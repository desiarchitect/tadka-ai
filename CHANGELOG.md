# Changelog

What changed on each episode branch. The newest branch is at the top. Each branch adds one section here
and leaves the earlier sections alone, so this file always tells the whole story up to that branch.

Format: Added, Changed, Fixed, Removed. "Verified" lines say what was actually run.

## ep02-typed-tool-calling - 2026-10-11

Episode 2: typed tool calling with server-side identity. Starts from `ep01-structured-intent`.

### Added
- `apps/api/demo/naive-get-order.ts`: a deliberately vulnerable tool that takes `{ userId, orderId }` from the model. A test shows Rahul's chat reading the address on Aman's order through it. It is outside `src/` and a test checks that nothing in `src/` imports it.
- Three read-only tools in `src/assist/tools/`: `get_my_orders`, `get_order`, `get_restaurant_menu`. No tool has a user field; the executor passes the verified principal to the orders and restaurants services. Results contain allow-listed fields only (no address, phone or customer id), names are capped, menu text is labelled as untrusted data.
- The executor checks, in order: known tool, parseable input, strict schema, role, read-only policy, then calls the service. Every call ends as `ok`, `not_found`, `invalid_args` or `failed`. A tool a role is not offered looks like an unknown tool. A backend failure is `failed`, never an empty list.
- `src/assist/agent-loop.ts`: our own loop around `generateText`. The model must call a tool on every step and finishes with `final_answer`, naming which results answer the question or asking one of three fixed clarifying questions. The reply is rendered from templates (`src/assist/templates.ts`): the model never writes text the user sees, so prose instead of a tool call is `invalid_output`.
- Limits, each enforced on its own: 6 model requests, 8 tool calls (a round that would pass 8 is not run), 3 tool calls at once, one 20 s deadline for the whole question (a slow tool or model ends the turn; late results are discarded), 32 KB per request (bytes), 8 KB per tool result (lists drop whole trailing items), 10 orders with `hasMore`, 25 menu items with `totalItems`.
- Every tool call gets exactly one result, tied to its call id, even when parallel calls finish out of order.
- Spending guard per model request: a conservative cost estimate (input bytes counted as tokens plus overheads, times `ASSIST_ESTIMATE_MARGIN`; the full output cap, which is also sent on every request; priced separately), checked against `ASSIST_TURN_BUDGET_USD` and then reserved in the shared ledger. Actual usage is charged after; missing usage is charged at the estimate; usage above the estimate is charged in full, logged as `estimator_violation`, and stops the turn. An unpriced model sends nothing.
- Ledger reservations (`reserved`, `sent`, `settled`, `released`) with a lock file and durable writes, so concurrent processes on one machine cannot spend the same allowance. On start, never-sent reservations are released and sent-but-unsettled ones stay held. `pnpm budget:reservations` and `pnpm budget:settle` let an operator settle them once each.
- `POST /assist/chat`: customers only, body `{ "text" }`, single turn, returns `{ answer, stopReason, steps }`. Without a configured model provider it returns 503 `assistant_not_configured`.
- `OrdersService.listRecent` (newest first, then by id) and `RestaurantsService.menuPage` (by name, then id, with the total).
- Restricted audit log `logs/security-audit.jsonl`: the only place that records a request for another customer's order (principal id and an HMAC of the order id, no order data). Ordinary logs show `not_found` for that case exactly as for an invented id.
- Settings: `ASSIST_MAX_OUTPUT_TOKENS`, `ASSIST_TURN_BUDGET_USD`, `ASSIST_ESTIMATE_MARGIN`, `AUDIT_HMAC_KEY`.
- The assistant takes its model, request options and price key from the `ModelHandle` in `src/llm` (merged from ep01). `ASSIST_PRICED_AS` is gone: the price key is `provider:model`, and a pair with no price row sends nothing.
- Tests: 168 (160 API, 8 fake provider) after the provider boundary was merged in.
- `RUNBOOK.md` section 7 (bash and PowerShell), README section, new troubleshooting rows.

### Changed
- The orders service finds an order and classifies a denial in one SQL statement, so the check cannot race the read. The caller still gets the same 404; whether the order exists is kept in an internal, non-serialized flag on the error.
- The EP1 spending guard now counts reservations held by other requests.
- The boundary test covers `assist/tools` and the loop, checks that `src/` never imports `demo/`, and checks that no tool schema has a user field.
- The runbook is now for this branch; sections after section 6 moved down by one number.

### Fixed
- The PowerShell `Call` helper in the runbook sent a body with every request. Windows PowerShell 5.1 refuses a body on GET, so most walkthrough commands failed there with a `ConvertFrom-Json` error and `[0]`. It now sends a body only with POST and PUT, as UTF-8, and prints `[no response]` when the API is not running.

### Verified
- Typecheck and 140 of 140 tests on Node 24 and Node 26.
- On a clean clone: install, migrate, seed, `pnpm dev`; the naive-tool demo; `POST /assist/chat` returning 503 without a model, in bash and PowerShell; the budget commands.
- The loop through the Azure provider package against a local stand-in for the Responses API: tool calls, tool results, `tool_choice: required`, the output cap, `store: false` and reasoning off are sent as expected. This checks the request and response format only, not a real model.

### Not in this branch
- Conversations, tools that change anything, RAG, and prompt-injection defences beyond labelling database text. They arrive in later episode branches.

## ep01-structured-intent - 2026-10-11

Episode 1: not every AI feature is an agent. Starts from `ep00-start`.

### Added
- `GET /assist/order-status?orderId=`: a deterministic route with no LLM. The verified principal goes to the orders service, which enforces ownership: someone else's order is 404, no token is 401, a malformed id is 400.
- `POST /assist/intent`: free text in, one of five labels out (`order_status`, `cancel_order`, `refund_request`, `menu_question`, `other`). Customers only (owner and admin tokens get 403). The body is `{ "text" }` and nothing else, so no identity can come from the request or the model.
- `src/assist/intent.ts`: the strict one-field schema, and a keyword rules baseline that is blind to negation on purpose.
- `src/assist/classifier.ts`: the LLM classifier (`generateText` with `Output.object`, reasoning off, `maxRetries: 0`, 100-token cap). Every call ends in one outcome: `ok`, `refusal`, `invalid_output` or `provider_error`. A failure is never counted as the valid label `other`.
- `src/assist/next-step.ts`: the application decides what happens after a label. `order_status` lists the caller's own active orders (one, several or none; it never guesses between several); cancel, refund and menu are unsupported in this episode; `other` asks for clarification. No label changes an order. A failing order lookup is a safe 500, not "no orders".
- `OrdersService.listActive`: the caller's orders that are not Delivered or Cancelled.
- `POST /assist/intent` uses the model from `src/llm` (Foundry or the direct OpenAI API, chosen by `LLM_PROVIDER`) when one is configured, behind the spending ledger; otherwise it uses the keyword rules. The response says which one answered.
- Evaluation: `pnpm eval:intent` over 40 frozen synthetic messages (19 Hinglish, 5 hard cases). A separate 8-message dev set is used for tuning. Failures count as wrong and are reported apart from a valid `other`. The dry run uses a stand-in model and checks the harness only; `--live` measures the real deployment and writes per-message results (outcome, tokens, cost, latency) to `.eval-runs/`.
- Spending guard for the evaluation: before each request it adds actual spend so far to a worst case for the next request and stops, without retrying, if the run cap (`EVAL_BUDGET_USD`, default 0.5) or the ledger cap (`M0_BUDGET_USD`) could be crossed. The worst case estimates input tokens as the UTF-8 byte length of the prompt (a conservative estimate that does not undercount Devanagari, not a guaranteed bound), adds a fixed overhead and the full output cap, prices input and output separately, and refuses a model with no configured price.
- `test/boundaries.test.ts`: an import-graph check that `assist` reaches orders only through the public service.
- Tests: 110 (102 API, 8 fake provider), 41 of them new.
- `RUNBOOK.md` section 6 (bash and PowerShell), README section, new troubleshooting rows.

### Changed
- CI runs on Node 24 (required) and Node 26 (an extra check that may fail without failing the workflow), and installs pnpm with npm because Node 25 and later have no corepack.
- The classifier, the evaluator, the spending guard and `pnpm eval:intent` take their model, request options and price from the `ModelHandle` of the model boundary introduced on `ep00-start`; none of them names a provider. `.eval-runs` files record the model and the price row used.
- The runbook is now for this branch; sections after the walkthrough moved down by one number.

### Fixed
- The PowerShell `Call` helper in the runbook sent a body with every request. Windows PowerShell 5.1 refuses a body on GET, so most walkthrough commands failed there with a `ConvertFrom-Json` error and `[0]`. It now sends a body only with POST and PUT, as UTF-8, and prints `[no response]` when the API is not running.

### Verified
- Typecheck and 110 of 110 tests on Node 24 and Node 26.
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
- LLM probe (`pnpm probe:llm`): one structured call (`generateText` with `Output.object`) through the AI SDK to `gpt-5.4-mini`, with a dry-run mode that uses a fake model. Reasoning off, output capped at 400 tokens, no retries, `store: false`.
- A model boundary in `apps/api/src/llm`: a factory plus one adapter per provider (Microsoft Foundry through `@ai-sdk/azure`, the direct OpenAI API through `@ai-sdk/openai`). Application code and scripts receive a `ModelHandle`: the AI SDK model, the request options the adapter chose (opaque), structured non-secret metadata and a price key. Only `src/llm` imports a vendor package, builds a client or builds provider option objects, so changing provider is configuration (`LLM_PROVIDER=azure|openai`). With `LLM_PROVIDER` unset, Azure-only settings still work with a warning; a machine with both providers configured must choose.
- The model we price (`LLM_MODEL`) is kept apart from the Azure deployment name (`AZURE_DEPLOYMENT`). The AI SDK decides what a model supports from the name it is given, and on Azure that is the deployment's, so a deployment not named like a GPT model is refused instead of silently losing the reasoning setting.
- Prices per provider and model (`src/llm/pricing.ts`), each with tier, source and check date. A pair with no price, such as `openai:gpt-5.4-mini` for now, is refused before anything is sent. Reasoning tokens are part of the reported output total and are charged once.
- Spending guard: a local ledger that refuses a live call before sending it if the worst-case cost would pass `M0_BUDGET_USD` (default 5).
- CI workflow for GitHub Actions: Node 24, frozen lockfile, typecheck and tests against a Postgres service.
- `RUNBOOK.md` (how to run this branch, command by command, with install steps for Windows, macOS and Linux) and this changelog.
- Windows support: file paths built with `fileURLToPath`, and `.gitattributes` keeps LF line endings.
- PowerShell versions of the install check, Quick start, walkthrough, port cleanup and teardown, so Windows users can use PowerShell or Git Bash.
- Visual client (`apps/web`): React 19, Vite, TypeScript, and semantic CSS. Customer food-assistant view with demo banner and collapsible Developer Demonstration Panel displaying real OTel trace ID, request ID, latency, model metadata, and safe error codes.
- CORS support on `apps/api` using `@fastify/cors` restricted to local development origins (`:5173`, `:4173`).
- OpenTelemetry trace ID and request ID propagation on all API responses (`x-trace-id`, `x-request-id`).
- Authenticated `POST /assist/triage` endpoint for the EP0 vertical slice, guarded by customer token verification and Zod validation.
- ADR 0001 (`docs/adr/0001-ep0-visual-client-and-cors.md`) and independent review (`docs/reviews/EP0_INDEPENDENT_REVIEW.md`).
- Tests: 78 (67 API, 8 fake provider, 3 web client). Includes an adapter contract suite run once per provider against a recording stand-in for the Responses API (address, credentials, `store: false`, no reasoning, output cap, structured output, no ignored settings), provider selection rules, boundary test, and visual client tests.

### Fixed
- The PowerShell `Call` helper in the runbook sent a body with every request. Windows PowerShell 5.1 refuses a body on GET, so most walkthrough commands failed there with a `ConvertFrom-Json` error and `[0]`. It now sends a body only with POST and PUT, as UTF-8, and prints `[no response]` when the API is not running.

### Verified
- On a clean checkout: `pnpm install --frozen-lockfile`, migrate, seed, `pnpm dev`, every command in `RUNBOOK.md`, typecheck, build, and 78 of 78 tests.
- The dry-run probe, and the live call to Microsoft Foundry `gpt-5.4-mini`.
- The adapters through the real AI SDK providers against a stand-in for the network.

### Not in this branch
- Chat, tools, RAG, the agent loop and refunds. They arrive in later episode branches.
