// EP2 step 1: the failure first. A tool that takes the user id from the model leaks other
// customers' data. Synthetic users and addresses only.
import { eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { naiveGetOrder } from '../demo/naive-get-order.js';
import { orders } from '../src/shared/schema.js';
import { IDS } from '../src/shared/seed-data.js';
import { startStack } from './helpers.js';

let stack: Awaited<ReturnType<typeof startStack>>;
let amanOrderId: string;
beforeAll(async () => {
  stack = await startStack();
  amanOrderId = (await stack.db.select().from(orders).where(eq(orders.customerId, IDS.aman)))[0]!.id;
});

describe('the naive tool (deliberately vulnerable)', () => {
  it("lets Rahul's chat read Aman's address when the model supplies Aman's user id", async () => {
    // Rahul is logged in, but the tool never sees his token. It only sees what the model wrote.
    const argsFromModel = { userId: IDS.aman, orderId: amanOrderId };
    const r = await naiveGetOrder(stack.db, argsFromModel);
    expect(r.status).toBe('ok');
    expect(r.status === 'ok' && r.order.deliveryAddress).toBe('House 7, Sample Road, Mumbai 400001');
  });
});
