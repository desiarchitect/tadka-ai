// Login, refresh rotation and logout. Refresh tokens are opaque random values; only
// their SHA-256 hash is stored. Rotation is one atomic UPDATE, and presenting a token
// that was already used revokes its whole family (stolen-token detection).
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { and, eq, isNull, sql } from 'drizzle-orm';
import type { Db } from '../shared/db.js';
import { UnauthorizedError } from '../shared/errors.js';
import type { Principal } from '../shared/principal.js';
import { refreshTokens, users } from '../shared/schema.js';
import { ACCESS_TTL_SECONDS, issueAccessToken, type SigningKeys } from './access-tokens.js';
import { verifyPassword } from './passwords.js';

export const REFRESH_TTL_SECONDS = 7 * 24 * 60 * 60;
export type TokenPair = { accessToken: string; refreshToken: string; expiresIn: number };

const hashToken = (t: string) => createHash('sha256').update(t).digest('hex');

export class IdentityService {
  constructor(private readonly db: Db, private readonly keys: SigningKeys) {}

  async login(email: string, password: string): Promise<TokenPair> {
    const [user] = await this.db.select().from(users).where(eq(users.email, email.toLowerCase()));
    // Same error for unknown email and wrong password.
    if (!user || !(await verifyPassword(password, user.passwordHash))) throw new UnauthorizedError('invalid_credentials');
    return this.issuePair(this.db, toPrincipal(user), randomUUID(), null);
  }

  async refresh(refreshToken: string): Promise<TokenPair> {
    const h = hashToken(refreshToken);
    const result = await this.db.transaction(async (tx) => {
      const claimed = await tx.execute<{ id: string; family_id: string; user_id: string }>(sql`
        update identity.refresh_tokens set used_at = now()
        where token_hash = ${h} and used_at is null and revoked_at is null and expires_at > now()
        returning id, family_id, user_id`);
      const row = claimed.rows[0];
      if (!row) return null;
      const [user] = await tx.select().from(users).where(eq(users.id, row.user_id));
      if (!user) return null;
      return this.issuePair(tx, toPrincipal(user), row.family_id, row.id);
    });
    if (result) return result;

    // Not claimable. If it was a real token that had already been used, treat it as
    // reuse and revoke the family. Two parallel refreshes land here by design (strict).
    const [known] = await this.db.select().from(refreshTokens).where(eq(refreshTokens.tokenHash, h));
    if (known?.usedAt) await this.revokeFamily(known.familyId);
    throw new UnauthorizedError('invalid_refresh_token');
  }

  async logout(refreshToken: string): Promise<void> {
    const [known] = await this.db.select().from(refreshTokens).where(eq(refreshTokens.tokenHash, hashToken(refreshToken)));
    if (known) await this.revokeFamily(known.familyId);
  }

  private async revokeFamily(familyId: string) {
    await this.db.update(refreshTokens).set({ revokedAt: new Date() })
      .where(and(eq(refreshTokens.familyId, familyId), isNull(refreshTokens.revokedAt)));
  }

  private async issuePair(tx: Pick<Db, 'insert'>, p: Principal, familyId: string, parentId: string | null): Promise<TokenPair> {
    const refreshToken = randomBytes(32).toString('base64url');
    await tx.insert(refreshTokens).values({
      familyId, userId: p.userId, parentId, tokenHash: hashToken(refreshToken),
      expiresAt: new Date(Date.now() + REFRESH_TTL_SECONDS * 1000),
    });
    return { accessToken: await issueAccessToken(this.keys, p), refreshToken, expiresIn: ACCESS_TTL_SECONDS };
  }
}

function toPrincipal(u: typeof users.$inferSelect): Principal {
  return { userId: u.id, role: u.role, ...(u.restaurantId ? { restaurantId: u.restaurantId } : {}) };
}
