// EP1 step 6: an import-graph check for the assist module. It catches accidental coupling
// only. It is NOT a security boundary: every module runs in one process with the same
// database credentials. The real guarantees are the orders service's ownership checks,
// the strict schemas and the label-to-action mapping, each tested elsewhere.
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { IntentOutput } from '../src/assist/intent.js';

const dir = new URL('../src/assist/', import.meta.url);
const files = readdirSync(dir).filter((f) => f.endsWith('.ts'));
const importsOf = (f: string) =>
  [...readFileSync(new URL(f, dir), 'utf8').matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]!);

describe('assist imports only public interfaces', () => {
  it('has the files this test expects (a rename must not silently empty the check)', () => {
    for (const f of ['classifier.ts', 'classifiers.ts', 'eval.ts', 'intent.ts', 'next-step.ts', 'routes.ts']) expect(files).toContain(f);
  });

  it('never imports the database, the schema, drizzle, payments or identity internals', () => {
    const forbidden = [/shared\/db/, /shared\/schema/, /drizzle-orm/, /\/payments\//, /\/identity\//, /state-machine/];
    const offenders = files.flatMap((f) => importsOf(f).filter((i) => forbidden.some((re) => re.test(i))).map((i) => `${f} -> ${i}`));
    expect(offenders).toEqual([]);
  });

  it('reaches orders only through the public service', () => {
    const fromOrders = files.flatMap((f) => importsOf(f).filter((i) => i.includes('/orders/')).map((i) => `${f} -> ${i}`));
    for (const e of fromOrders) expect(e).toMatch(/\/orders\/service\.js$/);
  });
});

describe('the model has no way to name a user', () => {
  it('the output schema is one field, and the request body has no identity field', () => {
    expect(Object.keys(IntentOutput.shape)).toEqual(['intent']);
    const routes = readFileSync(new URL('routes.ts', dir), 'utf8');
    expect(routes).not.toMatch(/userId|customerId/);
  });
});
