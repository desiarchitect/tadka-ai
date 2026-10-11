// The restricted operator audit channel. The ONLY place that records that a request named an
// order that exists but belongs to someone else. Ordinary logs and traces show plain
// `not_found` for that case, exactly as for an invented id, so they can't be used to learn
// which ids exist. Events carry no order data; the requested id is an HMAC, enough to spot
// repeated probing of the same id without storing it. In production this is an
// access-controlled audit log; here it's a separate, gitignored file.
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHmac, randomBytes } from 'node:crypto';

export type AuditEvent = { at: string; event: 'forbidden_as_not_found'; tool: string; principalId: string; requestedIdHmac: string };
export type SecurityAudit = { record(e: Omit<AuditEvent, 'at'>): void; hmac(id: string): string };

function hmacWith(key: string | Buffer) {
  return (id: string) => createHmac('sha256', key).update(id).digest('hex').slice(0, 16);
}

export function fileAudit(path: string, key: string | undefined): SecurityAudit {
  return {
    hmac: hmacWith(key ?? randomBytes(32)),
    record(e) {
      mkdirSync(dirname(path), { recursive: true });
      appendFileSync(path, JSON.stringify({ at: new Date().toISOString(), ...e }) + '\n');
    },
  };
}

export function memoryAudit(): SecurityAudit & { events: AuditEvent[] } {
  const events: AuditEvent[] = [];
  return { events, hmac: hmacWith('test-key'), record: (e) => events.push({ at: new Date().toISOString(), ...e }) };
}
