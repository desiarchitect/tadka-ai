// The provider boundary, as an import-and-construction rule. It bans coupling, not vocabulary:
// docs, tests and labels may say "azure" or "openai". Like the other boundary tests it catches
// accidental coupling only; the contract tests prove what each adapter really sends.
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const root = new URL('../', import.meta.url);
const list = (dir: string) => readdirSync(new URL(dir, root), { recursive: true }).map((f) => `${dir}${String(f).replaceAll('\\', '/')}`).filter((f) => f.endsWith('.ts'));
const outside = [...list('src/'), ...list('scripts/')].filter((f) => !f.startsWith('src/llm/'));
// Code only: drop whole-line and trailing // comments.
const code = (f: string) => readFileSync(new URL(f, root), 'utf8').split('\n').map((l) => l.replace(/(^|\s)\/\/.*$/, '')).join('\n');
const offenders = (re: RegExp) => outside.filter((f) => re.test(code(f)));

describe('only src/llm talks to a model vendor', () => {
  it('sees the files it is meant to check (a rename must not silently empty the rule)', () => {
    expect(outside).toEqual(expect.arrayContaining(['src/assist/triage.ts', 'scripts/probe-llm.ts', 'src/main.ts']));
    expect(list('src/llm/')).toEqual(expect.arrayContaining(['src/llm/azure.ts', 'src/llm/openai.ts', 'src/llm/index.ts']));
  });

  it('no vendor SDK package is imported outside src/llm', () => {
    expect(offenders(/from\s+'@ai-sdk\/(azure|openai)'/)).toEqual([]);
  });

  it('no provider client is constructed outside src/llm (scripts get their model from the factory too)', () => {
    expect(offenders(/\bcreate(Azure|OpenAI)\s*\(/)).toEqual([]);
  });

  it('provider option objects are built only by the adapters', () => {
    expect(offenders(/providerOptions\s*:\s*\{\s*[^}\s]/)).toEqual([]); // an empty {} (a fake model in the dry run) is fine
    expect(offenders(/\breasoningEffort\b/)).toEqual([]);
  });

  it('nothing outside src/llm reaches into an adapter file', () => {
    expect(offenders(/from\s+'[^']*llm\/(azure|openai)\.js'/)).toEqual([]);
  });

  it('the adapters are the only place with a provider-keyed options object', () => {
    for (const [file, key] of [['src/llm/azure.ts', 'azure'], ['src/llm/openai.ts', 'openai']] as const) {
      expect(code(file)).toMatch(new RegExp(`providerOptions:\\s*\\{\\s*${key}:`));
    }
  });
});
