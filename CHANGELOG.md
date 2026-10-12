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
- LLM probe (`pnpm probe:llm`): one structured call (`generateText` with `Output.object`) through the AI SDK to `gpt-5.4-mini` on Microsoft Foundry, with a dry-run mode that uses a fake model. Reasoning off, output capped at 400 tokens, no retries, `store: false`.
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
- Tests: 50 (39 API, 8 fake provider, 3 web client).

### Fixed
- The PowerShell `Call` helper in the runbook sent a body with every request. Windows PowerShell 5.1 refuses a body on GET, so most walkthrough commands failed there with a `ConvertFrom-Json` error and `[0]`. It now sends a body only with POST and PUT, as UTF-8, and prints `[no response]` when the API is not running.

### Verified
- On a clean checkout: `pnpm install --frozen-lockfile`, migrate, seed, `pnpm dev`, every command in `RUNBOOK.md`, typecheck, build, and 50 of 50 tests.
- The dry-run probe, and live call to Microsoft Foundry `gpt-5.4-mini`.

### Not in this branch
- Chat, tools, RAG, the agent loop and refunds. They arrive in later episode branches.
