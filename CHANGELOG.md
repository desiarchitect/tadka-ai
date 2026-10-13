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

### Changed (remediation after the independent verification of EP-2)
- Merged the EP-0/EP-1 remediation (`e002976`: nine commits) into this branch, keeping the tool implementation as it was. Conflicts were in `.env.example`, `.gitignore`, `RUNBOOK.md`, `app.ts`, `routes.ts`, `main.ts` and `test/helpers.ts`; the typed-tool authorization, strict validation, read-only policy, limits and fixed fallback are untouched. This fixes F-1 (demo mode reaching a provider; `/assist/chat` is now also off in demo mode), F-2 (the `.env.example` quick start), F-4 (`/assist/intent` timeout) and F-7 (client defects).
- F-3: `POST /assist/chat` is rate limited per verified user with the shared limiter (`TRIAGE_RATE_LIMIT_PER_MIN`, default 10). A refused request (no token, wrong role) uses no quota. A limited request never reaches the provider.
- F-5: the request's abort signal now reaches the whole turn. When the client disconnects, the provider call is abandoned, no further tool is started, the request that already left is charged at its estimate and nothing stays held.
- F-6: a turn that did not answer is no longer a `200`. The fixed fallback sentence stays in `answer`, and the body adds `error`, a machine-readable code: `429 provider_rate_limited` (with `Retry-After`), `502 provider_auth` / `provider_unavailable` / `provider_bad_output` / `provider_refused`, `504 provider_timeout` / `turn_timeout`, `503 budget_exhausted` / `backend_unavailable` / `provider_not_configured`. Provider text, prompts and credentials are never in the response, and only a safe subset is logged. Successful turns are unchanged.
- O-1: the spending ledger stays fail-closed and now validates provider usage before recording it (not a number, infinite, negative, fractional, above explicit bounds, or above what the request could have used). A rejected figure is charged at the held estimate (never the wrong number, never zero) and blocks live calls until an operator clears it. A corrupt ledger file is refused, never treated as empty. New operator commands: `pnpm budget:status`, `budget:clear-halt` (reason and `--confirm`, evidence copy kept, event recorded) and `budget:start-over` (corrupt file only, explicit baseline from the provider's billing, original kept). Nothing resets the ledger automatically, including reaching the cap. `RUNBOOK` section 7, "Ledger recovery".
- `record()` on the ledger takes optional per-request limits; `settle()` refuses nonsense figures; `settleUsage()` is the loop's way to settle.
- Tests: 404 (356 API, 13 fake provider, 35 web client) before the client work below.

### Added (client, `apps/web`; no backend change)
- The product UI from `ep01-product-ui` (orders, order details, restaurants and menus, payment, email/password sign-in, the EP-1 intent card and order-status lookup) is merged in.
- An **Ask about your orders** card for `POST /assist/chat`: the question goes out as `{ text }` with the token and nothing else (no user id, order id or role; the server authorizes). It shows the answer (written by the server from tool results) apart from the tools that ran and how each ended. It does not show tool arguments or results because the API does not send them. A non-2xx is a failed turn: the page's own wording for each error code, with the tools that ran and the fixed fallback sentence labelled "not an answer"; `Retry-After` is used for 429. Responses are validated with zod. Cancel aborts the request (the server then abandons the turn). Switching customer aborts a question in flight and a late answer is ignored.
- The capability list shows EP-0, EP-1 and EP-2 as available.
- Tests: 500 (356 API, 13 fake provider, 131 web client).

### Not verified (still open)
- No live Foundry call has been made for this branch. The scripted provider proves server behaviour for failures; it is not evidence of live-model behaviour.
- The canonical roadmap and acceptance criteria are not in the repository. This changelog is the provisional scope.

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
- Client (`apps/web`, no backend change): an **Intent classification** card for `POST /assist/intent` that shows the classification (label, and whether it came from the language model or the keyword rules; SIMULATED in demo mode) apart from the **next step** the server's code chose, with an explicit "classification only, does not read your orders" label and no confidence score (the API sends none). A **Check status (server lookup)** button on each order calls `GET /assist/order-status` and labels the answer as a direct lookup with no model. Responses are validated with zod. The capability list shows EP-1 as available. The product UI from `ep00-product-ui` (orders, details, menus, payment, sign-in) is carried in.
- Tests: 337 (230 API, 13 fake provider, 94 web client).
- `RUNBOOK.md` section 6 (bash and PowerShell), README section, new troubleshooting rows.

### Changed
- CI runs a Node 24 and Node 26 matrix; both jobs must pass (a failure on either fails the workflow), and pnpm is installed with npm because Node 25 and later have no corepack.
- The classifier, the evaluator, the spending guard and `pnpm eval:intent` take their model, request options and price from the `ModelHandle` of the model boundary introduced on `ep00-start`; none of them names a provider. `.eval-runs` files record the model and the price row used.
- The runbook is now for this branch; sections after the walkthrough moved down by one number.

### Fixed
- The PowerShell `Call` helper in the runbook sent a body with every request. Windows PowerShell 5.1 refuses a body on GET, so most walkthrough commands failed there with a `ConvertFrom-Json` error and `[0]`. It now sends a body only with POST and PUT, as UTF-8, and prints `[no response]` when the API is not running.

### Verified
- Typecheck and 110 of 110 tests on Node 24 and Node 26 (the count at that time; the current count is in the remediation sections below).
- On a local run: both new routes in bash and PowerShell, the dry-run evaluation (rules 24 of 40, hard cases 0 of 5).

### Changed (remediation after the independent end-to-end review)
- **EP-0's remediation is merged in**: the explicit startup decision (demo / live / off, one-line refusals, no uncaught exception; the template ships `LLM_PROVIDER` empty), the shared assist guard, and the web client fixes (panel layout, accessibility, favicon, required `VITE_API_URL` for production builds).
- **`POST /assist/intent` now has the same protections as `/assist/triage`**, through the shared guard (`src/assist/guard.ts`): a per-user rate limit (`TRIAGE_RATE_LIMIT_PER_MIN`, its own quota on this route), and a bounded provider call (`TRIAGE_TIMEOUT_MS`, aborted at the timeout, no retries). In demo mode no LLM classifier is built, the keyword rules answer, and the response says `simulated: true`. Every response now has an explicit `simulated` field.
- **Diagnosable failures.** A classification that produced no intent logs one structured warning: the outcome, a reason category, the provider's status, and its error code and request id when they look like identifiers. Never the customer's message, the model's output, provider text or a key. The client still sees only `assistant_unavailable`.
- **Evaluation tooling** (the 40-message dataset is untouched and now pinned by SHA-256 in a test): per-intent precision and recall, failure and timeout rates, latency percentiles and a paired comparison; the output file records the prompt hash. `docs/evaluation/EP1_INTENT_EVAL_PLAN.md` is a **draft**: its decision rule needs thresholds only the owner can set, so the live evaluation has not been run.
- Removed `apps/api/.vitest/json/output.json` (generated output from an ad-hoc run on another machine, committed by accident) and ignored `.vitest/`.

### Fixed (remediation after the independent end-to-end review)
- `cp .env.example .env` followed by starting the API failed on this branch even with `DEMO_MODE=1` (the provider was initialised before the demo check). Both now start.
- A hung provider kept a `/assist/intent` request open indefinitely, and the route had no rate limit and ignored `DEMO_MODE`.

### Verified (remediation, local only)
- Typecheck, 278 of 278 tests (230 API, 13 fake provider, 35 web client), the production build and the bundle check, on Node 22, 24 and 26 against a local Postgres 16 without pgvector. CI results for these commits are reported separately, and are the only evidence for the pgvector image.
- A real Chromium run against the real API and the production preview: see the review report. The live Foundry probe and the live intent evaluation were **not** run by this change.

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
- Product UI in `apps/web` (no backend change): orders list and order detail, restaurant list and menus (name and price only), paying a `Placed` order, a real email/password sign-in beside the demo sign-in, and a capability list saying what the assistant can do in this build. Customer switching aborts requests in flight and clears all customer-scoped state first; a 401 from any data call ends the session. Responses from every new call are validated with zod.
- Tests: 240 (154 API, 13 fake provider, 73 web: the visual client tests plus the product UI tests). Includes an adapter contract suite run once per provider against a recording stand-in for the Responses API (address, credentials, `store: false`, no reasoning, output cap, structured output, no ignored settings), provider selection rules, boundary test, and visual client tests.

### Changed (EP-0 remediation after the independent audit)
- **No silent mock.** Without a provider, `POST /assist/triage` is `503 provider_not_configured`. `DEMO_MODE=1` (only `1` or `0`; empty is off; anything else refuses to start) returns answers marked `simulated: true` with `modelId: "demo-mock"`, and the client shows a SIMULATED badge. Every response now has an explicit `simulated` boolean. The hard-coded `gpt-5.4-mini` model name in the response is gone: it reports what the provider returned.
- **Customer only.** Other roles get `403 forbidden_role`. Role and user id come from the verified token.
- **Per-user rate limit** (`TRIAGE_RATE_LIMIT_PER_MIN`, default 10) with `@fastify/rate-limit` 10.3.0, keyed on the verified user. It is not a spending cap, and the budget ledger still covers only the CLI probe.
- **Provider errors** are mapped to `502 provider_auth`, `429 provider_rate_limited`, `502 provider_unavailable`, `504 provider_timeout`, `502 provider_bad_output`. Messages are fixed; provider text, keys, resource names and the customer's message are in neither the response nor the log. The log keeps our code, the error class, the provider's status number, and its error code, error type and request id when they look like identifiers. The error handler no longer reuses an AI SDK error's provider status.
- **Timeouts**: the provider call is aborted after `TRIAGE_TIMEOUT_MS` (15 s); the client stops waiting after 20 s and has a Cancel button.
- **CORS**: a disallowed origin gets no CORS headers instead of a 500 and an error log.
- **Client**: responses are validated with zod; one request helper replaces the duplicated fetch code; error wording is the client's own per error code; the demo sign-in and its credentials exist only in a build made with `VITE_DEMO_LOGIN=1` (`pnpm dev` sets it).
- **CI**: Node 24 and 26 matrix; adds `pnpm build` and the bundle check (`pnpm --filter @tadka/web check:bundle`).
- Docs: RUNBOOK, README, `.env.example`, `apps/web/.env.example`, ADR 0001 section 6; the earlier in-repo review is marked historical.

### Changed (EP-0 remediation, round 2: independent end-to-end review)
- **Startup.** `.env.example` ships `LLM_PROVIDER` empty. The API decides once whether it is in demo, live or off mode (`src/assist/provider-mode.ts`): demo mode never reads provider settings, a provider that is chosen but incomplete (or unknown) is refused with one `Startup refused: ...` line and exit code 1 (no stack trace, no credential value), and nothing configured is a legitimate "model off" state. A present-but-empty setting takes its default and is never turned into 0. Tests start the real process from the parsed `.env.example`.
- **Shared guard** (`src/assist/guard.ts`): the customer check, per-user limiter and provider timeout signal moved out of the triage route so another route can reuse them. No behaviour change for triage. Each route has its own per-user quota.
- **Web client.** The developer panel no longer clips on phones (an inline `span 2` forced a second grid column); muted text colours meet WCAG AA; the diagnostics toggle is one native button; the page has a `<main>` landmark and a favicon. A production build requires `VITE_API_URL` (the localhost default is dev-only and is removed from production bundles); without it the page says what to set and sends nothing. The bundle check also asserts that.

### Fixed (EP-0 remediation, round 2)
- **`cp .env.example .env` and starting the API crashed** (an uncaught `LlmConfigError`), because the template chose `LLM_PROVIDER=azure` with blank credentials. This was in the baseline before the first remediation and was found by the independent review.

### Fixed (EP-0 remediation)
- **The API and the fake provider did not exit on SIGTERM when tracing was on**, because the bare `SIGTERM` handler in `instrument.ts` replaced Node's default. Both now run one bounded shutdown for SIGTERM and SIGINT: stop the server, close the database (API), flush traces (3 s limit), exit; 8 s overall deadline, forced exit code 1 after it, whichever step hangs (tested for a stuck server close, a stuck stage in each position, and a trace backend that never answers); a repeated signal does not start a second shutdown. A request still running at the deadline is abandoned.
- The root `pnpm dev` script now uses `--no-bail`, so Ctrl+C no longer makes pnpm kill the API and fake provider before they finish shutting down (Vite exits non-zero on Ctrl+C). SIGTERM sent to a pnpm process is still not forwarded to the apps by pnpm; start the `node` command directly under a process manager or container. RUNBOOK section 10 lists which launch commands give a graceful stop.

### Verified (EP-0 remediation, local, Node 22 only)
- Typecheck, 173 of 173 tests, the web production build, the bundle check (demo credentials absent without `VITE_DEMO_LOGIN`, present with it) and the dry-run probe, on Node 22, 24 and 26 against a local Postgres 16 without pgvector.
- Not verified here: the live Foundry call for this commit, CI for this commit, a real browser (CORS included), Jaeger (a successful trace flush through `pnpm dev`), Docker and the pgvector image, clean-machine reproduction.

### Fixed
- The PowerShell `Call` helper in the runbook sent a body with every request. Windows PowerShell 5.1 refuses a body on GET, so most walkthrough commands failed there with a `ConvertFrom-Json` error and `[0]`. It now sends a body only with POST and PUT, as UTF-8, and prints `[no response]` when the API is not running.

### Verified
- On a clean checkout: `pnpm install --frozen-lockfile`, migrate, seed, `pnpm dev`, every command in `RUNBOOK.md`, typecheck, build, and 78 of 78 tests (the count at that time; see the remediation section for the current one).
- The dry-run probe, and the live call to Microsoft Foundry `gpt-5.4-mini`.
- The adapters through the real AI SDK providers against a stand-in for the network.

### Not in this branch
- Chat, tools, RAG, the agent loop and refunds. They arrive in later episode branches.
