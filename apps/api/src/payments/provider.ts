// The thin adapter between Tadka and a payment provider. Only this file knows the
// provider's HTTP shape. A timeout or 5xx is an UNKNOWN outcome, never a failure:
// the money may have moved, so the caller must look it up under the same key.
export type ChargeOutcome =
  | { kind: 'succeeded'; chargeId: string }
  | { kind: 'declined' }
  | { kind: 'unknown'; reason: string };

export interface PaymentProvider {
  charge(req: { key: string; amountPaise: number; reference: string }): Promise<ChargeOutcome>;
  lookupCharge(key: string): Promise<ChargeOutcome | null>;
}

export class HttpPaymentProvider implements PaymentProvider {
  constructor(private readonly baseUrl: string, private readonly timeoutMs = 2000) {}

  async charge(req: { key: string; amountPaise: number; reference: string }): Promise<ChargeOutcome> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/v1/charges`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': req.key },
        body: JSON.stringify({ amount: req.amountPaise, currency: 'INR', reference: req.reference }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      return { kind: 'unknown', reason: (err as Error).name };
    }
    return toOutcome(res);
  }

  async lookupCharge(key: string): Promise<ChargeOutcome | null> {
    try {
      const res = await fetch(`${this.baseUrl}/v1/charges?idempotency_key=${encodeURIComponent(key)}`, { signal: AbortSignal.timeout(this.timeoutMs) });
      if (res.status === 404) return null;
      return toOutcome(res);
    } catch (err) {
      return { kind: 'unknown', reason: (err as Error).name };
    }
  }
}

async function toOutcome(res: Response): Promise<ChargeOutcome> {
  const body = (await res.json().catch(() => ({}))) as { id?: string; status?: string };
  if ((res.status === 200 || res.status === 201) && body.status === 'succeeded' && body.id) return { kind: 'succeeded', chargeId: body.id };
  if (body.status === 'declined') return { kind: 'declined' };
  return { kind: 'unknown', reason: `http_${res.status}` };
}
