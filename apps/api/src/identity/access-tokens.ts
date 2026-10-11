// Access tokens: 15-minute EdDSA JWTs. The verifier pins the algorithm, issuer,
// audience and `typ`, so a token minted for something else is never accepted here.
import { randomUUID } from 'node:crypto';
import { SignJWT, exportJWK, generateKeyPair, importJWK, jwtVerify, type CryptoKey, type KeyObject } from 'jose';
import { UnauthorizedError } from '../shared/errors.js';
import type { Principal } from '../shared/principal.js';
import type { Role } from '../shared/schema.js';

export const ISSUER = 'tadka-ts';
export const AUDIENCE = 'tadka-ts-api';
export const ACCESS_TTL_SECONDS = 15 * 60;
const TYP = 'at+jwt';

type Key = CryptoKey | KeyObject | Uint8Array;
export type SigningKeys = { privateKey: Key; publicKey: Key };

export async function loadSigningKeys(privateJwk?: string): Promise<SigningKeys> {
  if (!privateJwk) return generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true });
  const jwk = JSON.parse(privateJwk);
  const { d: _d, ...publicJwk } = jwk;
  return { privateKey: await importJWK(jwk, 'EdDSA'), publicKey: await importJWK(publicJwk, 'EdDSA') };
}

export async function exportPrivateJwk(keys: SigningKeys) {
  return exportJWK(keys.privateKey as CryptoKey);
}

export function issueAccessToken(keys: SigningKeys, p: Principal, now = Math.floor(Date.now() / 1000)): Promise<string> {
  return new SignJWT({ role: p.role, ...(p.restaurantId ? { restaurantId: p.restaurantId } : {}) })
    .setProtectedHeader({ alg: 'EdDSA', typ: TYP })
    .setSubject(p.userId)
    .setJti(randomUUID())
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt(now)
    .setExpirationTime(now + ACCESS_TTL_SECONDS)
    .sign(keys.privateKey);
}

export async function verifyAccessToken(keys: SigningKeys, token: string): Promise<Principal> {
  try {
    const { payload } = await jwtVerify(token, keys.publicKey, {
      algorithms: ['EdDSA'],
      issuer: ISSUER,
      audience: AUDIENCE,
      typ: TYP,
      clockTolerance: 30,
      requiredClaims: ['sub', 'jti', 'exp', 'iat'],
    });
    const role = payload.role as Role;
    if (!['Customer', 'RestaurantOwner', 'Admin'].includes(role)) throw new Error('bad role');
    const restaurantId = typeof payload.restaurantId === 'string' ? payload.restaurantId : undefined;
    return { userId: payload.sub!, role, ...(restaurantId ? { restaurantId } : {}) };
  } catch {
    // One generic answer: the caller learns nothing about why the token failed.
    throw new UnauthorizedError('invalid_token');
  }
}
