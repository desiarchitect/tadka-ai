// M0 step 5: a charge through the payments service and the real fake-PSP process.
import { eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { orders, payments } from '../src/shared/schema.js';
import { IDS } from '../src/shared/seed-data.js';
import { startStack } from './helpers.js';

let stack: Awaited<ReturnType<typeof startStack>>;
beforeAll(async () => { stack = await startStack(); });

const pay = (token: string) => stack.app.inject({ method: 'POST', url: `/orders/${IDS.rahulPlacedOrder}/pay`, headers: { authorization: `Bearer ${token}` } });
const levers = (body: object) => stack.psp.inject({ method: 'POST', url: '/__levers', payload: body });
const paymentRow = async () => (await stack.db.select().from(payments).where(eq(payments.orderId, IDS.rahulPlacedOrder)))[0];

describe('charge through the fake provider', () => {
  it("Aman can't pay Rahul's order (404)", async () => {
    const { accessToken } = await stack.login('aman@tadka.test');
    expect((await pay(accessToken)).statusCode).toBe(404);
    expect(await paymentRow()).toBeUndefined();
  });

  it('a provider timeout is resolved by looking the charge up under the same key', async () => {
    const { accessToken } = await stack.login('rahul@tadka.test');
    await levers({ charges: 'timeout' });
    const res = await pay(accessToken);
    await levers({ charges: 'succeed' });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('Confirmed');
    const row = await paymentRow();
    expect(row?.status).toBe('captured');
    expect(row?.capturedPaise).toBe(29900);
    expect(row?.providerKey).toBe(`charge:${IDS.rahulPlacedOrder}`);
  });

  it('a provider error leaves the outcome unknown (502); a retry reuses the key and captures once', async () => {
    const [o] = await stack.db.insert(orders).values({ customerId: IDS.rahul, restaurantId: IDS.chaiPoint, status: 'Placed', totalPaise: 3900,
      deliveryAddress: 'Flat 12, Test Lane, Pune 411001', contactPhone: '+91 00000 00001' }).returning();
    const { accessToken } = await stack.login('rahul@tadka.test');
    const payIt = () => stack.app.inject({ method: 'POST', url: `/orders/${o!.id}/pay`, headers: { authorization: `Bearer ${accessToken}` } });
    await levers({ charges: 'error' });
    const first = await payIt();
    expect(first.statusCode).toBe(502);
    expect(first.json().error).toBe('payment_outcome_unknown');
    await levers({ charges: 'succeed' });
    expect((await payIt()).statusCode).toBe(200);
    const rows = await stack.db.select().from(payments).where(eq(payments.orderId, o!.id));
    expect(rows.length).toBe(1);
    expect(rows[0]!.status).toBe('captured');
  });

  it('paying again is a no-op that reports the confirmed order', async () => {
    const { accessToken } = await stack.login('rahul@tadka.test');
    const again = await pay(accessToken);
    expect(again.statusCode).toBe(200);
    expect(again.json().version).toBe(2);
  });

  it('the money CHECK rejects refunded + reserved > captured', async () => {
    await expect(stack.db.update(payments).set({ refundedPaise: 20000, reservedPaise: 10000 }).where(eq(payments.orderId, IDS.rahulPlacedOrder)))
      .rejects.toThrow();
  });
});
