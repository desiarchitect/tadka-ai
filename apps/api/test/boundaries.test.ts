// EP1 step 6, extended in EP2: an import-graph check for the assist module and its tools. It catches accidental coupling
// only. It is NOT a security boundary: every module runs in one process with the same
// database credentials. The real guarantees are the orders service's ownership checks,
// the strict schemas and the label-to-action mapping, each tested elsewhere.
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { TOOL_SET } from '../src/assist/agent-loop.js';
import { IntentOutput } from '../src/assist/intent.js';

const dir = new URL('../src/assist/', import.meta.url);
const files = readdirSync(dir, { recursive: true }).map(String).filter((f) => f.endsWith('.ts'));
const importsOf = (f: string) =>
  [...readFileSync(new URL(f, dir), 'utf8').matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]!);

describe('assist imports only public interfaces', () => {
  it('has the files this test expects (a rename must not silently empty the check)', () => {
    for (const f of ['classifier.ts', 'classifiers.ts', 'eval.ts', 'intent.ts', 'next-step.ts', 'routes.ts', 'agent-loop.ts', 'templates.ts', 'tools/executor.ts', 'tools/registry.ts', 'tools/views.ts', 'tools/audit.ts']) expect(files).toContain(f);
  });

  it('never imports the database, the schema, drizzle, payments or identity internals', () => {
    const forbidden = [/shared\/db/, /shared\/schema/, /drizzle-orm/, /\/payments\//, /\/identity\//, /state-machine/];
    const offenders = files.flatMap((f) => importsOf(f).filter((i) => forbidden.some((re) => re.test(i))).map((i) => `${f} -> ${i}`));
    expect(offenders).toEqual([]);
  });

  it('reaches orders and restaurants only through their public services', () => {
    const fromDomains = files.flatMap((f) => importsOf(f).filter((i) => /\/(orders|restaurants)\//.test(i)).map((i) => `${f} -> ${i}`));
    for (const e of fromDomains) expect(e).toMatch(/\/(orders|restaurants)\/service\.js$/);
  });

  it('nothing in src imports the deliberately vulnerable demo', () => {
    const all = readdirSync(new URL('../src/', import.meta.url), { recursive: true }).map(String).filter((f) => f.endsWith('.ts'));
    const offenders = all.filter((f) => /from\s+'[^']*demo\//.test(readFileSync(new URL(`../src/${f}`, import.meta.url), 'utf8')));
    expect(offenders).toEqual([]);
  });
});

describe('the model has no way to name a user', () => {
  it('the output schema is one field, and the request body has no identity field', () => {
    expect(Object.keys(IntentOutput.shape)).toEqual(['intent']);
    const routes = readFileSync(new URL('routes.ts', dir), 'utf8');
    expect(routes).not.toMatch(/userId|customerId/);
  });

  it('no tool schema has a field for a user', () => {
    const schemas = JSON.stringify(Object.values(TOOL_SET).map((t) => (t.inputSchema as { jsonSchema: unknown }).jsonSchema));
    expect(schemas).not.toMatch(/userId|customerId|principal|role/i);
  });
});
