# Changelog

What changed on each episode branch. The newest branch is at the top. Each branch adds one section here
and leaves the earlier sections alone, so this file always tells the whole story up to that branch.

Format: Added, Changed, Fixed, Removed. "Verified" lines say what was actually run.

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
- Tests: 173 (130 API, 13 fake provider, 30 web client). Includes an adapter contract suite run once per provider against a recording stand-in for the Responses API (address, credentials, `store: false`, no reasoning, output cap, structured output, no ignored settings), provider selection rules, boundary test, and visual client tests.

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

### Fixed (EP-0 remediation)
- **The API and the fake provider did not exit on SIGTERM when tracing was on**, because the bare `SIGTERM` handler in `instrument.ts` replaced Node's default. Both now run one bounded shutdown for SIGTERM and SIGINT: stop the server, close the database (API), flush traces (3 s limit), exit; 8 s overall deadline, forced exit code 1 after it, whichever step hangs (tested for a stuck server close, a stuck stage in each position, and a trace backend that never answers); a repeated signal does not start a second shutdown. A request still running at the deadline is abandoned.
- The root `pnpm dev` script now uses `--no-bail`, so Ctrl+C no longer makes pnpm kill the API and fake provider before they finish shutting down (Vite exits non-zero on Ctrl+C). SIGTERM sent to a pnpm process is still not forwarded to the apps by pnpm; start the `node` command directly under a process manager or container. RUNBOOK section 9 lists which launch commands give a graceful stop.

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
