// The same expectations, run once per provider adapter. The adapters are built by the real
// factory and the real AI SDK providers; only the network is replaced by a recording stand-in
// for the Responses API. What this proves: the request each provider actually sends. What it
// does not prove: how a live deployment behaves (that is the live check).
import { describe, expect, it } from 'vitest';
import { BudgetLedger } from '../src/assist/budget.js';
import { classifyIntent } from '../src/assist/classifier.js';
import { classifyProviderError } from '../src/assist/errors.js';
import { MAX_OUTPUT_TOKENS, triage } from '../src/assist/triage.js';
import { createModelHandle, loadLlmConfig, type ModelHandle } from '../src/llm/index.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

type Seen = { url: string; headers: Record<string, string>; body: Record<string, any> };
const TRIAGE = { intent: 'refund_request', language: 'en', needsHuman: true, summary: 'Wants money back.' };

function standIn() {
  const seen: Seen[] = [];
  const fetchStub = (async (input: RequestInfo | URL, init?: RequestInit) => {
    seen.push({
      url: String(input),
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: JSON.parse(String(init?.body)),
    });
    return new Response(JSON.stringify({
      id: 'resp_1', object: 'response', created_at: 1_700_000_000, status: 'completed', model: 'gpt-5.4-mini',
      output: [{ type: 'message', id: 'msg_1', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: JSON.stringify(TRIAGE), annotations: [] }] }],
      // 50 output tokens in total, 30 of which were reasoning: the total already includes them.
      usage: { input_tokens: 80, input_tokens_details: { cached_tokens: 0 }, output_tokens: 50, output_tokens_details: { reasoning_tokens: 30 }, total_tokens: 130 },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { seen, fetchStub };
}

const CASES = [
  {
    name: 'azure',
    env: { LLM_PROVIDER: 'azure', AZURE_RESOURCE_NAME: 'my-resource', AZURE_API_KEY: 'azure-test-key', AZURE_DEPLOYMENT: 'gpt-5.4-mini-1' },
    url: /^https:\/\/my-resource\.openai\.azure\.com\/openai\/v1\/responses/,
    auth: (h: Record<string, string>) => expect(h['api-key']).toBe('azure-test-key'),
    sentModel: 'gpt-5.4-mini-1', // Azure addresses YOUR deployment, not the model
  },
  {
    name: 'openai',
    env: { LLM_PROVIDER: 'openai', OPENAI_API_KEY: 'openai-test-key' },
    url: /^https:\/\/api\.openai\.com\/v1\/responses/,
    auth: (h: Record<string, string>) => expect(h.authorization).toBe('Bearer openai-test-key'),
    sentModel: 'gpt-5.4-mini', // OpenAI addresses the model itself
  },
];

describe.each(CASES)('adapter contract: $name', (c) => {
  const run = async () => {
    const { seen, fetchStub } = standIn();
    const setup = createModelHandle(loadLlmConfig(c.env), { fetch: fetchStub });
    if (setup.status !== 'ready') throw new Error('expected a ready model');
    const r = await triage(setup.handle, 'My biryani arrived cold, I want a refund.');
    return { seen, r, handle: setup.handle };
  };

  it('sends one request to the provider with the right address and credentials', async () => {
    const { seen } = await run();
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toMatch(c.url);
    c.auth(seen[0]!.headers);
    expect(seen[0]!.body.model).toBe(c.sentModel);
  });

  it('keeps the privacy and cost protections: no provider-side storage, no reasoning, output cap, temperature 0', async () => {
    const { seen } = await run();
    const body = seen[0]!.body;
    expect(body.store).toBe(false);
    expect(body.reasoning).toMatchObject({ effort: 'none' });
    expect(body.max_output_tokens).toBe(MAX_OUTPUT_TOKENS);
    expect(body.temperature).toBe(0);
  });

  it('asks for structured output, and parses it', async () => {
    const { seen, r } = await run();
    expect(seen[0]!.body.text.format).toMatchObject({ type: 'json_schema', name: 'triage' });
    expect(r.output).toEqual(TRIAGE);
  });

  it('applied every setting: the SDK reports no unsupported or ignored setting', async () => {
    expect((await run()).r.warnings ?? []).toEqual([]);
  });

  it('reported output tokens already include reasoning tokens, so the budget charges them once', async () => {
    const { r, handle } = await run();
    expect(r.usage.outputTokens).toBe(50);
    const ledger = new BudgetLedger(join(mkdtempSync(join(tmpdir(), 'llm-')), 'usage.json'), 5);
    const price = (h: ModelHandle) => (h.meta.provider === 'azure' ? 1 : 0);
    if (price(handle)) expect(ledger.record(handle.priceKey, r.usage.inputTokens ?? 0, r.usage.outputTokens ?? 0)).toBeCloseTo((80 * 0.75 + 50 * 4.5) / 1_000_000);
    else expect(() => ledger.record(handle.priceKey, 80, 50)).toThrow(/no price configured/); // no OpenAI price row yet: fails closed
  });
});

// Timeout and cancellation, at the network boundary. The stand-in `fetch` below behaves like a real one
// for aborts: it never answers and rejects with the signal's reason when the signal fires. This proves the
// signal travels from our call through the real AI SDK provider to `fetch` and that the failure is
// classified. It does NOT prove that a live Foundry/OpenAI HTTP request is cancelled: that needs the live check.
describe.each(CASES)('abort signal reaches fetch: $name', (c) => {
  const hangingFetch = () => {
    const seen: { signal?: AbortSignal | null }[] = [];
    const fetchStub = ((_input: RequestInfo | URL, init?: RequestInit) => {
      seen.push({ signal: init?.signal });
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal!.reason));
      });
    }) as typeof fetch;
    return { seen, fetchStub };
  };
  const handle = (fetchStub: typeof fetch) => {
    const setup = createModelHandle(loadLlmConfig(c.env), { fetch: fetchStub });
    if (setup.status !== 'ready') throw new Error('expected a ready model');
    return setup.handle;
  };

  it('a timeout aborts the in-flight request and is classified as provider_timeout', async () => {
    const { seen, fetchStub } = hangingFetch();
    const started = Date.now();
    const err = await triage(handle(fetchStub), 'hello', { abortSignal: AbortSignal.timeout(100) }).then(() => null, (e: unknown) => e);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.signal).toBeInstanceOf(AbortSignal);
    expect(seen[0]!.signal!.aborted).toBe(true);
    expect(Date.now() - started).toBeLessThan(3000);
    const classified = classifyProviderError(err);
    expect(classified?.status).toBe(504);
    expect(classified?.message).toBe('provider_timeout');
  });

  it('the intent classifier: a timeout aborts the in-flight request and is reported as provider_error / provider_timeout', async () => {
    const { seen, fetchStub } = hangingFetch();
    const r = await classifyIntent(handle(fetchStub), 'where is my order', { abortSignal: AbortSignal.timeout(100) });
    expect(r).toMatchObject({ outcome: 'provider_error', reason: 'provider_timeout' });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.signal!.aborted).toBe(true);
  });

  it('a user cancel aborts the request too, and is not reported as a timeout', async () => {
    const { seen, fetchStub } = hangingFetch();
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 50);
    const err = await triage(handle(fetchStub), 'hello', { abortSignal: ac.signal }).then(() => null, (e: unknown) => e);
    expect(seen[0]!.signal!.aborted).toBe(true);
    expect((err as Error).name).toBe('AbortError');
    expect(classifyProviderError(err)).toBeNull();
  });
});

describe('what the contract exposes', () => {
  it('an Azure deployment the SDK would not recognise as a GPT model is refused, because it would silently drop reasoning settings', () => {
    const env = { LLM_PROVIDER: 'azure', AZURE_RESOURCE_NAME: 'r', AZURE_API_KEY: 'k' };
    for (const bad of ['my-deployment', 'tadka-prod', 'chat']) expect(() => createModelHandle(loadLlmConfig({ ...env, AZURE_DEPLOYMENT: bad }))).toThrow(/not named like a GPT model/);
    for (const good of ['gpt-5.4-mini', 'gpt-5.4-mini-1', 'gpt-5.4-nano', 'o4-mini']) expect(createModelHandle(loadLlmConfig({ ...env, AZURE_DEPLOYMENT: good })).status).toBe('ready');
  });

  it('each adapter keys its options under its own provider name, and the application never sees the key', async () => {
    const options = CASES.map((c) => {
      const s = createModelHandle(loadLlmConfig(c.env));
      if (s.status !== 'ready') throw new Error('expected ready');
      return Object.keys(s.handle.providerOptions);
    });
    expect(options).toEqual([['azure'], ['openai']]);
  });
});
