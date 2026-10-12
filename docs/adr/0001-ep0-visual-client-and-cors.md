# ADR 0001: EP0 Visual Client and Browser Integration Architecture

- **Status**: Accepted
- **Date**: 2026-10-12
- **Milestone**: EP0 Baseline
- **Context**: The Tadka AI Engineering project teaches production AI engineering through a progressive series of episodes. Episode 0 requires a demonstrable vertical slice that can be shown live on YouTube. Prior to this decision, the EP0 baseline contained only a headless Fastify API, a fake PSP, and a CLI probe script. Browser requests were blocked by CORS, OpenTelemetry trace IDs were not surfaced to callers, and no web client existed.

---

## 1. Decision

1. **Add `apps/web` as a minimal React + Vite + TypeScript client**:
   - Maintain a single language (TypeScript) and package workspace (`pnpm-workspace.yaml` `apps/*`).
   - Use clean semantic CSS (`apps/web/src/index.css`) rather than introducing a heavy component library or UI framework.
   - Separate concerns into a Customer View (inquiry input, loading state, structured triage result) and an expandable Developer Demonstration Panel (HTTP outcome, OTel trace ID, Fastify request ID, client-measured latency, auth role, model metadata, safe error codes).
   - Ensure the browser strictly communicates with the backend over HTTP; never allow direct DB access, provider calls, or client-side secret exposure.

2. **Configure CORS restricted to local development origins**:
   - Register `@fastify/cors` in `apps/api/src/app.ts` restricted to `http://localhost:5173` and `http://localhost:4173` (or `CORS_ORIGIN` env).
   - Expose headers `x-trace-id` and `x-request-id` to the browser.

3. **Expose trace context via Fastify `onSend` hook**:
   - Extract the active OpenTelemetry span context trace ID and attach it as `x-trace-id`.
   - Attach Fastify request ID as `x-request-id`.

4. **Introduce authenticated endpoint `POST /assist/triage` for the EP0 vertical slice**:
   - Enforce customer JWT authentication (`verifyAccessToken`) and the `Customer` role (`403 forbidden_role` otherwise; see section 6).
   - Validate payload via Zod (`{ message: string.min(1).max(500) }`).
   - Call the existing `triage(model, message)` function without adding chat loops, tools, or RAG (reserved for EP1-EP4).

---

## 2. Alternatives Considered and Rejected

1. **Keep EP0 headless and record terminal curl commands only**:
   - *Rejected*: A browser client provides immediate visual credibility for YouTube viewers, clearly demonstrates real CORS and distributed tracing, and contrasts authenticated vs. unauthenticated requests interactively.
2. **Implement full chat UI with streaming in EP0**:
   - *Rejected*: Violates episode scoping. Multi-turn chat belongs to EP3, streaming belongs to EP10, and tool execution belongs to EP2. EP0 must remain a focused feasibility probe of structured triage and foundational architecture.
3. **Use Next.js / SSR for frontend**:
   - *Rejected*: Adds unnecessary complexity, duplicate Node server processes, and potential confusion around server-side vs client-side API calls. A static Vite SPA cleanly decouples the frontend from backend services.

---

## 3. Failure Modes

- **Port Conflict on `:5173`**: If port 5173 is occupied, Vite may increment to 5174, triggering a CORS preflight failure if CORS origins are rigid. *Mitigation*: Configurable `CORS_ORIGIN` environment variable and documented port cleanup procedures.
- **Provider Unavailability**: If Azure Foundry credentials are missing or the API key expires, calls to `/assist/triage` fail with an application-owned error (`503 provider_not_configured`, `502 provider_auth`, `502 provider_unavailable`, `504 provider_timeout`, `429 provider_rate_limited`). There is **no automatic fallback** to a mock model. *Mitigation*: an explicit opt-in `DEMO_MODE=1`, whose answers carry `simulated: true` and `modelId: "demo-mock"` and are shown with a SIMULATED badge. (This replaces an earlier wording that described an automatic fallback; see section 6.)

---

## 4. Revisit When

- **Episode 10 (Streaming & Latency)**: Revisit the client's HTTP transport when Server-Sent Events (SSE) or WebSockets are introduced.
- **Episode 3 (Conversation Memory)**: Revisit when multi-turn conversation threads and conversation IDs are stored in the database.

---

## 5. Cross-Stack Consistency

- Mirrors standard microservice / modular monolith patterns: frontends receive trace IDs to enable correlation with backend APM (Jaeger), auth is handled via short-lived bearer JWTs, and CORS headers are strictly bounded to verified caller domains.

---

## 6. Amendments after the independent audit (2026-10-12)

The first implementation of this ADR differed from it in places. These are the corrections; the decisions above stand unless restated here.

1. **No silent mock.** The server used to substitute a canned model whenever no provider was configured, and answered `200` as if a model had run. Now: no provider and no `DEMO_MODE=1` is `503 provider_not_configured`. `DEMO_MODE` accepts only `1` or `0` (empty means off); any other value stops the server at start. Every triage response has a `simulated` boolean; demo answers use `modelId: "demo-mock"`. The client shows a SIMULATED badge.
2. **Customer only.** Section 1 item 4 said "customer JWT"; the code only checked that a token was valid. The role and user id now come from the verified token, and other roles get `403 forbidden_role`.
3. **Per-user rate limit** on `POST /assist/triage` (`TRIAGE_RATE_LIMIT_PER_MIN`, default 10), with the limiter keyed on the verified user id. It is basic abuse protection held in process memory. The `M0_BUDGET_USD` ledger still guards only the CLI probe; **no hard spending cap exists on the HTTP route**.
4. **Provider errors are classified** at the route (from the AI SDK's error classes) and never pass a provider status or message through. A provider authentication failure is `502 provider_auth`, so it cannot be confused with the API's own `401`.
5. **Bounded calls.** The provider call has a timeout (`TRIAGE_TIMEOUT_MS`, default 15 s) whose abort signal reaches `fetch`. The client gives up after 20 s (longer than the server's, so the server's answer arrives first) and offers Cancel.
6. **CORS denial is not an error.** A disallowed origin gets no CORS headers (it used to get a 500 and an error log). CORS is a browser read rule; it is not authorization.
7. **Bounded shutdown** for the API and the fake provider: one sequence for SIGTERM and SIGINT (server, database, telemetry), an overall 8 s deadline, a 3 s bound on the trace flush. A request still running at the deadline is abandoned. The root `pnpm dev` uses `--no-bail` so Ctrl+C reaches this sequence; pnpm does not forward SIGTERM, so a container or process manager must run `node` directly (RUNBOOK section 9). The earlier bare `SIGTERM` handler in `instrument.ts` stopped Node from exiting, which left the process alive when tracing was on.
8. **Demo credentials are build-time opt-in.** The seed accounts and password are compiled in only with `VITE_DEMO_LOGIN=1` (`pnpm dev` sets it; a production build does not), and `pnpm --filter @tadka/web check:bundle` checks the bundle both ways.
9. **Trace IDs.** The API returns `x-trace-id` and `x-request-id` in responses. The browser does not send a trace context, so this is not end-to-end propagation from the browser.
10. **`/health` is liveness only.** It does not check Postgres or the provider.
