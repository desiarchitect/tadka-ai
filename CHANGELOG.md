# Changelog

What changed on each episode branch. The newest branch is at the top. Each branch adds one section here
and leaves the earlier sections alone, so this file always tells the whole story up to that branch.

Format: Added, Changed, Fixed, Removed. "Verified" lines say what was actually run.

## ep01-structured-intent - 2026-10-11

Episode 1: not every AI feature is an agent. Starts from `ep00-start`.

### Added
- `GET /assist/order-status?orderId=`: a deterministic route with no LLM. The verified principal goes to the orders service, which enforces ownership: someone else's order is 404, no token is 401, a malformed id is 400.
- `POST /assist/intent`: free text in, one of five labels out (`order_status`, `cancel_order`, `refund_request`, `menu_question`, `other`). Customers only (owner and admin tokens get 403). The body is `{ "text" }` and nothing else, so no identity can come from the request or the model.
- `src/assist/intent.ts`: the strict one-field schema, and a keyword rules baseline that is blind to negation on purpose.
- `src/assist/classifier.ts`: the LLM classifier (`generateText` with `Output.object`, reasoning off, `maxRetries: 0`, 100-token cap). Every call ends in one outcome: `ok`, `refusal`, `invalid_output` or `provider_error`. A failure is never counted as the valid label `other`.
- `src/assist/next-step.ts`: the application decides what happens after a label. `order_status` lists the caller's own active orders (one, several or none; it never guesses between several); cancel, refund and menu are unsupported in this episode; `other` asks for clarification. No label changes an order. A failing order lookup is a safe 500, not "no orders".
- `OrdersService.listActive`: the caller's orders that are not Delivered or Cancelled.
- `POST /assist/intent` uses the Foundry model when `AZURE_RESOURCE_NAME` and `AZURE_API_KEY` are set, behind the spending ledger; otherwise it uses the keyword rules. The response says which one answered.
- Evaluation: `pnpm eval:intent` over 40 frozen synthetic messages (19 Hinglish, 5 hard cases). A separate 8-message dev set is used for tuning. Failures count as wrong and are reported apart from a valid `other`. The dry run uses a stand-in model and checks the harness only; `--live` measures the real deployment and writes per-message results (outcome, tokens, cost, latency) to `.eval-runs/`.
- Spending guard for the evaluation: before each request it adds actual spend so far to a worst case for the next request and stops, without retrying, if the run cap (`EVAL_BUDGET_USD`, default 0.5) or the ledger cap (`M0_BUDGET_USD`) could be crossed. The worst case counts the UTF-8 byte length of the prompt as tokens (safe for Devanagari), adds a fixed overhead and the full output cap, prices input and output separately, and refuses a model with no configured price.
- `test/boundaries.test.ts`: an import-graph check that `assist` reaches orders only through the public service.
- Tests: 82 (74 API, 8 fake provider), 41 of them new.
- `RUNBOOK.md` section 6 (bash and PowerShell), README section, new troubleshooting rows.

### Changed
- CI runs on Node 24 (required) and Node 26 (an extra check that may fail without failing the workflow), and installs pnpm with npm because Node 25 and later have no corepack.
- The runbook is now for this branch; sections after the walkthrough moved down by one number.

### Verified
- Typecheck and 82 of 82 tests on Node 24 and Node 26.
- On a local run: both new routes in bash and PowerShell, the dry-run evaluation (rules 24 of 40, hard cases 0 of 5).

### Not in this branch
- Tools, the agent loop, conversations, RAG, refunds, and any action taken from a classification. They arrive in later episode branches.

## ep00-start - 2026-10-11

First branch. Starts from `main` (overview only). Baseline backend plus one structured LLM call.

### Added
- Workspace: pnpm monorepo (`apps/api`, `apps/fake-psp`), Node 24 or 26 (`engines >=24 <27`), TypeScript 7, pinned dependency versions and a frozen lockfile.
- `docker-compose.yml`: Postgres 16 with pgvector on port 5544; Jaeger under the `observability` profile.
- Database: one Postgres schema per module (`identity`, `restaurant`, `ordering`, `payment`), no cross-schema foreign keys, one drizzle migration, synthetic seed data (4 users, 3 restaurants, 9 orders).
- Identity: login, refresh-token rotation with reuse detection, logout. Access tokens are 15-minute EdDSA JWTs with pinned algorithm, issuer, audience and type. Refresh tokens are stored as hashes.
- Restaurants: list and menu endpoints (public).
- Orders: list, get and pay. Ownership is enforced in the service for every caller: customers see their own orders, owners see their restaurant's orders without address or phone, admins see all. An order you may not see returns 404. State machine with optimistic concurrency (`version`).
- Payments: charge only, through a `PaymentProvider` interface. One stable provider key per order, so a retry can never charge twice. A timed-out charge is resolved by looking it up under the same key.
- Fake payment provider (`apps/fake-psp`): charges, refunds, lookup by idempotency key, and a control endpoint to make it succeed, decline, time out or fail. State is in memory.
- Tracing: OpenTelemetry across both processes, exported to Jaeger. A paid order is one trace of 15 spans over two services.
- LLM probe (`pnpm probe:llm`): one structured call (`generateText` with `Output.object`) through the AI SDK to `gpt-5.4-mini` on Microsoft Foundry, with a dry-run mode that uses a fake model. Reasoning off, output capped at 400 tokens, no retries, `store: false`.
- Spending guard: a local ledger that refuses a live call before sending it if the worst-case cost would pass `M0_BUDGET_USD` (default 5).
- CI workflow for GitHub Actions: Node 24, frozen lockfile, typecheck and tests against a Postgres service.
- `RUNBOOK.md` (how to run this branch, command by command, with install steps for Windows, macOS and Linux) and this changelog.
- Windows support: file paths built with `fileURLToPath`, and `.gitattributes` keeps LF line endings.
- PowerShell versions of the install check, Quick start, walkthrough, port cleanup and teardown, so Windows users can use PowerShell or Git Bash.
- Tests: 41 (33 API, 8 fake provider).

### Verified
- On a clean checkout: `pnpm install --frozen-lockfile`, migrate, seed, `pnpm dev`, every command in `RUNBOOK.md`, typecheck, and 41 of 41 tests.
- The dry-run probe, and the refusal to run `--live` without credentials.

### Not in this branch
- Chat, tools, RAG, the agent loop and refunds. They arrive in later episode branches.
