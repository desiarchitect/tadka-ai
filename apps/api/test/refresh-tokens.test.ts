// Refresh lifecycle from Roadmap §3.2.
import { sql } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { startStack } from './helpers.js';

let stack: Awaited<ReturnType<typeof startStack>>;
beforeAll(async () => { stack = await startStack(); });

const refresh = (refreshToken: string) => stack.app.inject({ method: 'POST', url: '/auth/refresh', payload: { refreshToken } });
const orders = (accessToken: string) => stack.app.inject({ method: 'GET', url: '/orders', headers: { authorization: `Bearer ${accessToken}` } });

describe('refresh tokens', () => {
  it('login with a wrong password -> 401, same answer as an unknown email', async () => {
    const a = await stack.app.inject({ method: 'POST', url: '/auth/login', payload: { email: 'rahul@tadka.test', password: 'nope' } });
    const b = await stack.app.inject({ method: 'POST', url: '/auth/login', payload: { email: 'ghost@tadka.test', password: 'nope' } });
    expect(a.statusCode).toBe(401);
    expect(b.json()).toEqual(a.json());
  });

  it('rotation returns a new pair and the old refresh token stops working', async () => {
    const first = await stack.login('rahul@tadka.test');
    const res = await refresh(first.refreshToken);
    expect(res.statusCode).toBe(200);
    const second = res.json();
    expect(second.refreshToken).not.toBe(first.refreshToken);
    expect((await orders(second.accessToken)).statusCode).toBe(200);
    expect((await refresh(first.refreshToken)).statusCode).toBe(401);
  });

  it('reuse revokes the whole family: the newest refresh token dies too', async () => {
    const first = await stack.login('rahul@tadka.test');
    const second = (await refresh(first.refreshToken)).json();
    expect((await refresh(first.refreshToken)).statusCode).toBe(401); // reuse detected
    expect((await refresh(second.refreshToken)).statusCode).toBe(401); // family revoked
  });

  it('concurrent refresh: exactly one succeeds, then the family is revoked (strict, documented)', async () => {
    const first = await stack.login('rahul@tadka.test');
    const results = await Promise.all([refresh(first.refreshToken), refresh(first.refreshToken)]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 401]);
    const winner = results.find((r) => r.statusCode === 200)!.json();
    expect((await refresh(winner.refreshToken)).statusCode).toBe(401);
  });

  it('logout revokes the family', async () => {
    const first = await stack.login('rahul@tadka.test');
    const out = await stack.app.inject({ method: 'POST', url: '/auth/logout', payload: { refreshToken: first.refreshToken } });
    expect(out.statusCode).toBe(204);
    expect((await refresh(first.refreshToken)).statusCode).toBe(401);
  });

  it('expired refresh token -> 401', async () => {
    const first = await stack.login('aman@tadka.test');
    await stack.db.execute(sql`update identity.refresh_tokens set expires_at = now() - interval '1 second' where used_at is null and revoked_at is null`);
    expect((await refresh(first.refreshToken)).statusCode).toBe(401);
  });

  it('a refresh token used as an access token -> 401', async () => {
    const first = await stack.login('rahul@tadka.test');
    expect((await orders(first.refreshToken)).statusCode).toBe(401);
  });

  it('an access token sent to /auth/refresh -> 401', async () => {
    const first = await stack.login('rahul@tadka.test');
    const res = await stack.app.inject({ method: 'POST', url: '/auth/refresh', payload: { refreshToken: first.accessToken.slice(0, 200) } });
    expect(res.statusCode).toBe(401);
  });

  it('only a hash of the refresh token is stored', async () => {
    const first = await stack.login('rahul@tadka.test');
    const rows = await stack.db.execute<{ n: number }>(sql`select count(*)::int as n from identity.refresh_tokens where token_hash = ${first.refreshToken}`);
    expect(rows.rows[0]!.n).toBe(0);
  });
});
