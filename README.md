# tadka-ai

Build a production-grade AI assistant into a real food-delivery app.
Code for The Desi Architect's free AI engineering series (TypeScript, Fastify, PostgreSQL + pgvector).

Each episode shows a real failure first, then the fix, with tests.

## How this repo is organised

`main` holds only this overview. The code lives on **one branch per episode**.
Every episode branch starts from the previous one, so `git checkout epNN-...` gives you the code
exactly as it is at the end of that episode, and `git diff ep01-...ep02-...` shows what the episode added.

| Branch | Episode | Status |
|---|---|---|
| `ep00-start` | Baseline app (orders, auth, fake payment provider) plus one structured LLM call | built, CI green |
| `ep01-structured-intent` | Deterministic order-status route, plus an LLM that only classifies free text into five labels, measured against keyword rules | built, CI green |
| `ep02-typed-tool-calling` | Three read-only tools with identity from the token, an agent loop with hard limits and a spending guard, replies rendered from tool results | built, CI green |
| `ep03-conversation-memory` | Conversations stored in Postgres and owned by the customer, history trimmed by whole turns within a byte budget, and an opt-in vegetarian preference applied by the app | built, CI green |
| `ep04-...` to `ep12-...` | AI features, evals, safety, operations | not started |

**Status.** "built, CI green" means the code and tests pass in CI on Node 24 and 26, the typed-tool and ownership
checks were exercised against a real API and database, and the browser client was checked in a real browser.
It does **not** mean the assistant has been run against a live model: every provider answer in that testing was a
scripted stand-in. That run, and formal acceptance criteria, are still pending.

Branch names are `epNN-short-topic`. A branch is added only when the episode's code and tests pass.

Every episode branch carries two files at its root:

- `RUNBOOK.md`: every command to run that branch, what each one does, what you should see, and how to fix common problems.
- `CHANGELOG.md`: what that branch added and changed compared with the previous one, what was verified, and the known gaps.

## Commit convention

- Messages start with an imperative summary of the change, for example `Add tool executor that carries the request principal`.
- The body says why, and what was measured or verified.
- One logical change per commit, and the tests for a change go in the same commit.
- Work on a branch is never squashed into `main`.

## Run it

Check out a branch and follow its `RUNBOOK.md`. Start with `ep00-start`.
