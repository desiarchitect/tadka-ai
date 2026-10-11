// EP1 step 1: the deterministic route. No LLM, no model. Ownership comes from the orders service.
import { beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { orders } from '../src/shared/schema.js';
import { IDS } from '../src/shared/seed-data.js';
import { startStack } from './helpers.js';

let stack: Awaited<ReturnType<typeof startStack>>;
let rahulOrderId: string;
let amanOrderId: string;
beforeAll(async () => {
  stack = await startStack();
  rahulOrderId = (await stack.db.select().from(orders).where(eq(orders.customerId, IDS.rahul)))[0]!.id;
  amanOrderId = (await stack.db.select().from(orders).where(eq(orders.customerId, IDS.aman)))[0]!.id;
});

const status = (orderId: string, token?: string) =>
  stack.app.inject({ method: 'GET', url: `/assist/order-status?orderId=${orderId}`, headers: token ? { authorization: `Bearer ${token}` } : {} });

describe('GET /assist/order-status', () => {
  it('returns the status of the caller\'s own order', async () => {
    const { accessToken } = await stack.login('rahul@tadka.test');
    const res = await status(rahulOrderId, accessToken);
    expect(res.statusCode).toBe(200);
    expect(Object.keys(res.json()).sort()).toEqual(['orderId', 'status']);
    expect(res.json().orderId).toBe(rahulOrderId);
  });

  it("returns 404 for someone else's order, not 403", async () => {
    const { accessToken } = await stack.login('rahul@tadka.test');
    const res = await status(amanOrderId, accessToken);
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'order_not_found' });
  });

  it('returns 401 without a token', async () => {
    const res = await status(rahulOrderId);
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: 'missing_token' });
  });

  it('returns 400 for a malformed order id', async () => {
    const { accessToken } = await stack.login('rahul@tadka.test');
    expect((await status('not-a-uuid', accessToken)).statusCode).toBe(400);
  });
});
