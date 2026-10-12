// M0 probe: one structured LLM call. Default is a dry run against a fake model (no key,
// no network, no cost). `--live` makes ONE real call to the model chosen by LLM_PROVIDER
// (Microsoft Foundry or the direct OpenAI API), guarded by the budget ledger. Input is synthetic.
import { MockLanguageModelV4 } from 'ai/test';
import { LlmConfigError, createModelHandle, formatMeta } from '../src/llm/index.js';
import { triage, MAX_OUTPUT_TOKENS } from '../src/assist/triage.js';
import { BudgetLedger } from '../src/assist/budget.js';
import { fileURLToPath } from 'node:url';

const SYNTHETIC_MESSAGE = 'Mera order 40 minute se late hai, Paneer Butter Masala abhi tak nahi aaya. Kab aayega?';
const live = process.argv.includes('--live');

if (!live) {
  const fake = new MockLanguageModelV4({
    doGenerate: {
      content: [{ type: 'text', text: JSON.stringify({ intent: 'order_status', language: 'hinglish', needsHuman: false, summary: 'Customer asks why the order is 40 minutes late.' }) }],
      finishReason: { unified: 'stop', raw: 'stop' },
      usage: { inputTokens: { total: 90, noCache: 90, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 30, text: 30, reasoning: 0 } },
      warnings: [],
    },
  });
  const r = await triage({ model: fake, providerOptions: {} }, SYNTHETIC_MESSAGE);
  console.log(JSON.stringify({ mode: 'dry-run (fake model)', output: r.output, usage: r.usage }, null, 2));
  process.exit(0);
}

let setup: ReturnType<typeof createModelHandle>;
try { setup = createModelHandle(); } catch (e) {
  if (!(e instanceof LlmConfigError)) throw e;
  console.error(`${e.message.replace(/\.$/, '')}. Put the settings in .env (never commit it) and re-run with --live.`);
  process.exit(1);
}
if (setup.status === 'off') {
  console.error(`The live call needs a provider: ${setup.reason}. Put the settings in .env (never commit it) and re-run with --live.`);
  process.exit(1);
}
for (const w of setup.warnings) console.warn(`warning: ${w}`);
const { handle } = setup;
const ledger = new BudgetLedger(fileURLToPath(new URL('../../../.m0-usage.json', import.meta.url)), Number(process.env.M0_BUDGET_USD ?? 5));
const systemChars = 200; // the system prompt plus schema overhead, rounded up
let worst: number;
try { worst = ledger.assertAffordable(handle.priceKey, SYNTHETIC_MESSAGE.length + systemChars + 2000, MAX_OUTPUT_TOKENS); } catch (e) {
  console.error(`Nothing was sent. ${(e as Error).message}. Prices live in apps/api/src/llm/pricing.ts: add a row for ${handle.priceKey} with its source and date, or lower the output cap.`);
  process.exit(1);
}
console.log(`budget ok: spent $${ledger.spent().toFixed(6)}, worst case for this call $${worst.toFixed(6)}`);

const started = Date.now();
const r = await triage(handle, SYNTHETIC_MESSAGE);
const cost = ledger.record(handle.priceKey, r.usage.inputTokens ?? 0, r.usage.outputTokens ?? 0);
console.log(JSON.stringify({
  mode: 'live', model: formatMeta(handle.meta), pricedAs: handle.priceKey, servedModel: r.modelId, latencyMs: Date.now() - started,
  output: r.output, warnings: r.warnings, usage: { inputTokens: r.usage.inputTokens, outputTokens: r.usage.outputTokens },
  costUsd: cost, totalSpentUsd: ledger.spent(),
}, null, 2));
