# EP-1 intent evaluation: plan for the live comparison

**Status: DRAFT. NOT PREREGISTERED. The live evaluation has not been run and must not be run yet.**
Section 6 (the decision rule) needs numbers only the owner can set. Until the owner fills it in and commits it, this plan is
not frozen, and a run made now could not honestly be called a test of a prediction.

This plan was written without seeing any live result. The only numbers in it are the rules baseline (deterministic, reproducible
by anyone with `pnpm eval:intent`) and facts about the code and the dataset.

## 1. The question

EP-1 asks where an LLM earns its cost over a deterministic route for the same job: turning a free-text customer message into
one of five labels (`order_status`, `cancel_order`, `refund_request`, `menu_question`, `other`).

The comparison: **keyword rules** (`classifyWithRules`, deterministic, free, instant) against the **LLM classifier**
(`classifyIntent`, one structured call, `maxRetries: 0`, reasoning off, 100-token cap), on the same messages.

## 2. Frozen materials

| What | Value |
|---|---|
| Evaluation set | `apps/api/eval/intents.eval.json`, version `eval-1`, 40 synthetic messages |
| SHA-256 (full) | `a4c7f86df7b540586e8de33e1cb2cc705e1043290105247e9d0edba06aa53083` (the runner prints the first 12 characters, `a4c7f86df7b5`) |
| Pinned by | `test/intent-eval.test.ts` ("the frozen datasets are unchanged"). Any edit, even a typo fix, fails that test |
| Composition | English 21, Hinglish 19; order_status 10, cancel_order 8, refund_request 8, menu_question 7, other 7; 5 flagged "hard" (negation and similar) |
| Dev set | `apps/api/eval/intents.dev.json`, version `dev-1`, 8 messages, SHA-256 `f1c1a469204a98cf09cb3127aa0c631c937d662bb91c9194c2a1b7bcc61f7ff4`. Used to write the prompt and the rules; no message is shared with the evaluation set |
| Prompt | `SYSTEM_PROMPT` in `src/assist/classifier.ts`, 554 bytes, SHA-256 `f1c3b5f34893c082fc7254eff3c4e34a2c9067e47128c5480320c69e149b913b`. The runner records this hash in its output file. **Changing the prompt invalidates this plan** |
| Model | `gpt-5.4-mini`, Microsoft Foundry deployment `gpt-5.4-mini`, priced as `azure:gpt-5.4-mini` (Global Standard, $0.75 / $4.50 per 1M input / output tokens, checked 2026-10-11) |
| Code | the commit SHA the owner runs it on, recorded with the results |

The evaluation set must not be edited, extended, relabelled or tuned against. A different dataset is a new file with a new
version and a new plan, never an edit of these.

## 3. Procedure (when the owner decides to run it)

1. Fill in section 6 and commit this file. Record that commit's SHA.
2. On the final candidate SHA: `pnpm eval:intent` (the dry run: a fake model repeats the rules, so it must score exactly like the rules; this checks the harness only) and then `pnpm eval:intent --live`.
3. One live run, one request per message, in the dataset's order, no retries. The runner already stops before a request that could cross the run cap (`EVAL_BUDGET_USD`, default $0.50) or the ledger cap (`M0_BUDGET_USD`, default $5), and never retries.
4. A run that stops early (budget stop) or has provider failures is **reported as it is**. It is rerun only if the owner decides, in writing, that the cause was infrastructure and not the model. Failures are never dropped from the denominator.
5. Keep the runner's output file (`.eval-runs/<time>-live.json`, git-ignored) and attach a sanitized copy to the results record: no credentials, no resource name.
6. Results are written up before anything is changed. No prompt or rule is tuned on the evaluation set afterwards; if a change is wanted, it goes through the dev set and a new evaluation version.

Cost expectation (an estimate from the code, not a measurement): worst case for the 40 requests, by the runner's own bound, is **$0.0507**;
the measured cost will be much lower and is recorded. A single run cannot reach the $0.50 run cap.

## 4. What is recorded

All of this is produced by the runner (`pnpm eval:intent --live`) from the same 40 messages for both classifiers:

- Overall accuracy for rules and LLM, over **all 40** (a failure counts as wrong), and the English, Hinglish and hard-case accuracies.
- Per intent: support, number of answers, precision and recall, for both.
- Failure rates as a share of all messages: refusal, invalid output, provider error, **timeout** (a provider error with reason `provider_timeout`), and budget stops reported apart.
- Latency of the requests that were sent: mean, p50, p95, max.
- Input and output tokens and measured cost (reasoning tokens are inside the output total and are charged once).
- The **paired comparison**: both right, rules only, LLM only, both wrong. The two discordant counts are what decide who is better.
- Run metadata: model and deployment, price row, Node version, dataset version and hashes, prompt hash, code commit.

Computed afterwards from those counts: a 95% Wilson interval on each accuracy, and an exact two-sided McNemar test (a binomial test on the
discordant pairs). With 40 messages the intervals are wide (the rules' 24/40 is about 45% to 74%), so only a large difference can be told
from chance. That is a limit of the dataset, stated here so it is not discovered afterwards.

## 5. The rules baseline (reproducible now; not a prediction about the LLM)

`pnpm eval:intent` reproduces these deterministic numbers on `eval-1`:

| Overall | English | Hinglish | Hard cases (5) |
|---|---|---|---|
| 24 / 40 = 60.0% | 10 / 21 = 47.6% | 14 / 19 = 73.7% | 0 / 5 |

| Intent | Support | Precision | Recall |
|---|---|---|---|
| order_status | 10 | 83.3% | 50.0% |
| cancel_order | 8 | 62.5% | 62.5% |
| refund_request | 8 | 75.0% | 37.5% |
| menu_question | 7 | 100% | 71.4% |
| other | 7 | 35.3% | 85.7% |

The set is hand-built and partly written to break keyword rules (negation, paraphrase with no keyword), so 60% is **not** an estimate of
accuracy on real traffic. It has no typos, no Devanagari-script messages and few genuinely ambiguous ones.

## 6. The decision rule: OWNER DECISION REQUIRED (fill in before any live run)

This cannot be set responsibly from what is in the repository: the canonical roadmap, the episode crosswalk and the M0 evidence were not found in
Git history, and there is no traffic, volume or cost target. Setting a threshold here would be inventing one. The owner decides, **before the
run**, when an LLM improvement is worth its extra cost, latency and failure modes. A rule has this shape:

> Adopt the LLM classifier for `/assist/intent` **only if all** of the following hold on the preregistered run.

| Condition | Owner's value (fill in; do not change after the run) |
|---|---|
| Accuracy gain over the rules, in percentage points, on all 40 | OWNER: ____ |
| The gain is not chance: the paired evidence (LLM-only vs rules-only discordant pairs, exact McNemar) needs p below | OWNER: ____ |
| Hard-case result at least | OWNER: ____ of 5 |
| Minimum recall for the intents where a wrong route is costly (state which: for example `refund_request`, `cancel_order`) | OWNER: ____ |
| Failure rate allowed: refusals + invalid outputs + provider errors, as a share of all 40 | OWNER: ____ |
| Latency ceiling, p95 | OWNER: ____ ms |
| Cost ceiling, per 1,000 requests (needs a volume assumption) | OWNER: ____ USD, volume assumed: ____ |
| What the rules must still do when the LLM fails or is unavailable (the route's fallback) | OWNER: ____ |

Also decide: if the LLM wins on accuracy but fails a latency or cost condition, what then (rules only, LLM only for some intents, or neither).

Freeze record (the owner completes it in the commit that fills this table):

| | |
|---|---|
| Commit that froze this plan | OWNER: ____ |
| Date | OWNER: ____ |
| Owner | OWNER: ____ |

## 7. Dependencies that are still open

- **Canonical roadmap, EP crosswalk, M0 evidence, release manifest:** not in the repository's Git history. The owner needs to say where the
  authoritative copies live. Nothing in this plan, and no part of EP-0 or EP-1 acceptance, can be checked against them until then.
- **A live Foundry run on the final candidate SHA**, by the owner, with sanitized evidence, for the EP-0 probe and for this evaluation.
- **Spend accounting.** The ledger records a call's cost only when the provider reports usage. A call that times out or fails without a usage
  report is not added to it, so the ledger can under-count by those calls. The worst case for one run is bounded by section 3; the provider's
  own spending limit remains the hard safeguard.
