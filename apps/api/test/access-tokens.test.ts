// The 8 access-token cases from Roadmap §3.1, through a real protected route.
import { randomUUID } from 'node:crypto';
import { SignJWT, UnsecuredJWT, generateKeyPair } from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';
import { AUDIENCE, ISSUER, issueAccessToken } from '../src/identity/access-tokens.js';
import { IDS } from '../src/shared/seed-data.js';
import { startStack } from './helpers.js';

let stack: Awaited<ReturnType<typeof startStack>>;
beforeAll(async () => { stack = await startStack(); });

const call = (token?: string) => stack.app.inject({ method: 'GET', url: '/orders', headers: token ? { authorization: `Bearer ${token}` } : {} });
const now = () => Math.floor(Date.now() / 1000);
const claims = (over: Record<string, unknown> = {}) => ({ role: 'Customer', ...over });
const sign = (key: CryptoKey | Uint8Array, header: Record<string, unknown> = {}, o: { iss?: string; aud?: string; exp?: number } = {}) =>
  new SignJWT(claims()).setProtectedHeader({ alg: 'EdDSA', typ: 'at+jwt', ...header } as any)
    .setSubject(IDS.rahul).setJti(randomUUID()).setIssuer(o.iss ?? ISSUER).setAudience(o.aud ?? AUDIENCE)
    .setIssuedAt(now() - 60).setExpirationTime(o.exp ?? now() + 600).sign(key);

describe('access tokens', () => {
  it('1. no token -> 401', async () => { expect((await call()).statusCode).toBe(401); });

  it('2. bad signature (another key) -> 401', async () => {
    const other = await generateKeyPair('EdDSA', { crv: 'Ed25519' });
    expect((await call(await sign(other.privateKey))).statusCode).toBe(401);
  });

  it('3. expired beyond the 30 s skew -> 401', async () => {
    const t = await issueAccessToken(stack.keys, { userId: IDS.rahul, role: 'Customer' }, now() - 15 * 60 - 31);
    expect((await call(t)).statusCode).toBe(401);
  });

  it('4. wrong issuer -> 401', async () => {
    expect((await call(await sign(stack.keys.privateKey as CryptoKey, {}, { iss: 'evil' }))).statusCode).toBe(401);
  });

  it('5. wrong audience -> 401', async () => {
    expect((await call(await sign(stack.keys.privateKey as CryptoKey, {}, { aud: 'other-api' }))).statusCode).toBe(401);
  });

  it('6. alg none, or an algorithm outside the allow-list -> 401', async () => {
    const none = new UnsecuredJWT(claims()).setSubject(IDS.rahul).setIssuer(ISSUER).setAudience(AUDIENCE).setExpirationTime(now() + 600).encode();
    expect((await call(none)).statusCode).toBe(401);
    const hs = await new SignJWT(claims()).setProtectedHeader({ alg: 'HS256', typ: 'at+jwt' }).setSubject(IDS.rahul).setJti(randomUUID())
      .setIssuer(ISSUER).setAudience(AUDIENCE).setIssuedAt().setExpirationTime(now() + 600).sign(new TextEncoder().encode('x'.repeat(32)));
    expect((await call(hs)).statusCode).toBe(401);
  });

  it('7. wrong typ (e.g. an ID token) -> 401', async () => {
    expect((await call(await sign(stack.keys.privateKey as CryptoKey, { typ: 'JWT' }))).statusCode).toBe(401);
  });

  it('8. valid token -> 200', async () => {
    const t = await issueAccessToken(stack.keys, { userId: IDS.rahul, role: 'Customer' });
    expect((await call(t)).statusCode).toBe(200);
  });

  it('expired but within the 30 s skew is still accepted', async () => {
    const t = await issueAccessToken(stack.keys, { userId: IDS.rahul, role: 'Customer' }, now() - 15 * 60 - 10);
    expect((await call(t)).statusCode).toBe(200);
  });
});
