// Payments (charge only at ep00-start). Refunds, refund obligations and the operations
// port arrive in M6. The provider key is stable per order, so retrying a charge after
// an unknown outcome can never charge twice.
import { eq, sql } from 'drizzle-orm';
import type { Db } from '../shared/db.js';
import { NotFoundError, PaymentFailedError, UpstreamError } from '../shared/errors.js';
import type { Principal } from '../shared/principal.js';
import { payments } from '../shared/schema.js';
import { inSpan } from '../shared/tracing.js';
import type { ChargeOutcome, PaymentProvider } from './provider.js';

// What other modules (and later the assistant) may call.
export interface PaymentsPublic {
  chargeForOrder(p: Principal, order: { orderId: string; customerId: string; amountPaise: number }): Promise<{ paymentId: string; status: 'captured' }>;
}

export class PaymentsService implements PaymentsPublic {
  constructor(private readonly db: Db, private readonly provider: PaymentProvider) {}

  chargeForOrder(p: Principal, order: { orderId: string; customerId: string; amountPaise: number }) {
    return inSpan('payments.chargeForOrder', { 'tadka.order_id': order.orderId, 'tadka.amount_paise': order.amountPaise }, async () => {
      // Ownership again, here, because this service can't assume who its caller checked.
      if (p.role !== 'Admin' && p.userId !== order.customerId) throw new NotFoundError('order_not_found');

      const key = `charge:${order.orderId}`;
      await this.db.execute(sql`
        insert into payment.payments (order_id, amount_paise, status, provider_key)
        values (${order.orderId}, ${order.amountPaise}, 'pending', ${key})
        on conflict (order_id) do nothing`);
      const [row] = await this.db.select().from(payments).where(eq(payments.orderId, order.orderId));
      if (!row) throw new Error('payment row missing');
      if (row.status === 'captured') return { paymentId: row.id, status: 'captured' as const };
      if (row.status === 'declined') throw new PaymentFailedError('payment_declined');

      let outcome: ChargeOutcome = await this.provider.charge({ key: row.providerKey, amountPaise: row.amountPaise, reference: order.orderId });
      if (outcome.kind === 'unknown') outcome = (await this.provider.lookupCharge(row.providerKey)) ?? outcome;

      if (outcome.kind === 'succeeded') {
        await this.db.update(payments)
          .set({ status: 'captured', capturedPaise: row.amountPaise, providerChargeId: outcome.chargeId, updatedAt: new Date() })
          .where(eq(payments.id, row.id));
        return { paymentId: row.id, status: 'captured' as const };
      }
      if (outcome.kind === 'declined') {
        await this.db.update(payments).set({ status: 'declined', updatedAt: new Date() }).where(eq(payments.id, row.id));
        throw new PaymentFailedError('payment_declined');
      }
      await this.db.update(payments).set({ status: 'unknown', updatedAt: new Date() }).where(eq(payments.id, row.id));
      throw new UpstreamError('payment_outcome_unknown');
    });
  }
}
