// Compare the keyword rules with the LLM classifier on the frozen evaluation set.
//   pnpm eval:intent          dry run: the "LLM" is a FAKE model that repeats the rules'
//                             answer. This checks the harness only. Its accuracy says
//                             nothing about a real model.
//   pnpm eval:intent --live   the real Foundry deployment, one request per message, under
//                             a run budget and the shared ledger. Stops before sending a
//                             request that could cross a limit; never retries.
import { createAzure } from '@ai-sdk/azure';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { MockLanguageModelV4 } from 'ai/test';
import { BudgetLedger } from '../src/assist/budget.js';
import { classifyIntent, type ClassifyResult } from '../src/assist/classifier.js';
import { EvalBudget, runEval, summarize, type EvalMessage } from '../src/assist/eval.js';
import { classifyWithRules } from '../src/assist/intent.js';

const MODEL = 'gpt-5.4-mini' as const; // the model priced in the ledger
const live = process.argv.includes('--live');
const evalPath = fileURLToPath(new URL('../eval/intents.eval.json', import.meta.url));
const raw = readFileSync(evalPath, 'utf8');
const dataset = JSON.parse(raw) as { version: string; messages: EvalMessage[] };
const datasetSha = createHash('sha256').update(raw).digest('hex').slice(0, 12);

const rulesClassify = async (text: string): Promise<ClassifyResult> => ({ outcome: 'ok', intent: classifyWithRules(text), usage: { inputTokens: 0, outputTokens: 0 } });
const usage = { inputTokens: { total: 120, noCache: 120, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 6, text: 6, reasoning: 0 } };
const fakeModelFor = (text: string) => new MockLanguageModelV4({
  doGenerate: { content: [{ type: 'text', text: JSON.stringify({ intent: classifyWithRules(text) }) }], finishReason: { unified: 'stop', raw: 'stop' }, usage, warnings: [] },
});

let llmClassify: (text: string) => Promise<ClassifyResult>;
let budget: EvalBudget | undefined;
let deployment = 'fake model (dry run)';
if (!live) {
  llmClassify = (text) => classifyIntent(fakeModelFor(text), text);
} else {
  if (!process.env.AZURE_API_KEY || !process.env.AZURE_RESOURCE_NAME) {
    console.error('AZURE_API_KEY and AZURE_RESOURCE_NAME must be set in .env (never commit it) to use --live.');
    process.exit(1);
  }
  deployment = process.env.AZURE_DEPLOYMENT || MODEL;
  const azure = createAzure({ resourceName: process.env.AZURE_RESOURCE_NAME, apiKey: process.env.AZURE_API_KEY });
  const model = azure(deployment);
  llmClassify = (text) => classifyIntent(model, text);
  const ledger = new BudgetLedger(fileURLToPath(new URL('../../../.m0-usage.json', import.meta.url)), Number(process.env.M0_BUDGET_USD ?? 5));
  budget = new EvalBudget(Number(process.env.EVAL_BUDGET_USD ?? 0.5), MODEL, ledger);
  console.log(`budget: run cap $${process.env.EVAL_BUDGET_USD ?? 0.5}, ledger cap $${process.env.M0_BUDGET_USD ?? 5}, spent so far $${ledger.spent().toFixed(6)}`);
}

const rules = summarize(await runEval(dataset.messages, rulesClassify));
const llmRows = await runEval(dataset.messages, llmClassify, budget);
const llm = summarize(llmRows);

const line = (name: string, s: ReturnType<typeof summarize>) =>
  `${name.padEnd(8)} ${String(s.correct).padStart(2)}/${s.total}  ${String(s.accuracyPct).padStart(5)}%   English ${s.english.accuracyPct}%   Hinglish ${s.hinglish.accuracyPct}%   hard cases ${s.hardCases.correct}/${s.hardCases.n}`;
console.log(`\ndataset ${dataset.version} (${datasetSha}), ${dataset.messages.length} messages${live ? '' : '\nDRY RUN: the LLM row is a fake model that repeats the rules. Harness check only; run with --live for the real model.'}\n`);
console.log(line('rules', rules));
console.log(line('llm', llm));
console.log(`\nllm outcomes: ${JSON.stringify(llm.outcomes)}   cost $${llm.costUsd.toFixed(6)}   tokens ${llm.inputTokens} in / ${llm.outputTokens} out   mean latency ${llm.meanLatencyMs} ms`);
for (const [name, s] of [['rules', rules], ['llm', llm]] as const) {
  console.log(`\n${name} misses (expected -> got):`);
  for (const c of s.confusion) console.log(`  ${c.expected} -> ${c.got}   "${c.text}"`);
  if (s.confusion.length === 0) console.log('  none');
}
if (llm.outcomes.budget_stop) console.log(`\nSTOPPED by the budget guard: ${llm.outcomes.budget_stop} messages were not sent.`);

mkdirSync(fileURLToPath(new URL('../../../.eval-runs/', import.meta.url)), { recursive: true });
const out = fileURLToPath(new URL(`../../../.eval-runs/${new Date().toISOString().replace(/[:.]/g, '-')}-${live ? 'live' : 'dry'}.json`, import.meta.url));
writeFileSync(out, JSON.stringify({ mode: live ? 'live' : 'dry-run', deployment, pricedAs: MODEL, node: process.version, dataset: { version: dataset.version, sha: datasetSha }, rules, llm, rows: llmRows }, null, 2));
console.log(`\nfull results: ${out}`);
