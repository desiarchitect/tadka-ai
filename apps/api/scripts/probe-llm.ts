// M0 probe: one structured LLM call. Default is a dry run against a fake model (no key,
// no network, no cost). `--live` makes ONE real call to a gpt-5.4-mini deployment on
// Microsoft Foundry, guarded by the budget ledger. Input is synthetic.
import { createAzure } from '@ai-sdk/azure';
import { MockLanguageModelV4 } from 'ai/test';
import { triage, MAX_OUTPUT_TOKENS } from '../src/assist/triage.js';
import { BudgetLedger } from '../src/assist/budget.js';
import { fileURLToPath } from 'node:url';

const MODEL = 'gpt-5.4-mini' as const; // the model priced in the ledger
// The Foundry deployment name. Name the deployment after the model: the AI SDK reads the
// name to decide that this is a reasoning model.
const DEPLOYMENT = process.env.AZURE_DEPLOYMENT || MODEL;
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
  const r = await triage(fake, SYNTHETIC_MESSAGE);
  console.log(JSON.stringify({ mode: 'dry-run (fake model)', output: r.output, usage: r.usage }, null, 2));
  process.exit(0);
}

if (!process.env.AZURE_API_KEY || !process.env.AZURE_RESOURCE_NAME) {
  console.error('AZURE_API_KEY and AZURE_RESOURCE_NAME must be set. Put them in .env (never commit it) and re-run with --live.');
  process.exit(1);
}
const azure = createAzure({ resourceName: process.env.AZURE_RESOURCE_NAME, apiKey: process.env.AZURE_API_KEY });
const ledger = new BudgetLedger(fileURLToPath(new URL('../../../.m0-usage.json', import.meta.url)), Number(process.env.M0_BUDGET_USD ?? 5));
const systemChars = 200; // the system prompt plus schema overhead, rounded up
const worst = ledger.assertAffordable(MODEL, SYNTHETIC_MESSAGE.length + systemChars + 2000, MAX_OUTPUT_TOKENS);
console.log(`budget ok: spent $${ledger.spent().toFixed(6)}, worst case for this call $${worst.toFixed(6)}`);

const started = Date.now();
const r = await triage(azure(DEPLOYMENT), SYNTHETIC_MESSAGE);
const cost = ledger.record(MODEL, r.usage.inputTokens ?? 0, r.usage.outputTokens ?? 0);
console.log(JSON.stringify({
  mode: 'live', deployment: DEPLOYMENT, pricedAs: MODEL, servedModel: r.modelId, latencyMs: Date.now() - started,
  output: r.output, usage: { inputTokens: r.usage.inputTokens, outputTokens: r.usage.outputTokens },
  costUsd: cost, totalSpentUsd: ledger.spent(),
}, null, 2));
