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
   - Enforce customer JWT authentication (`verifyAccessToken`).
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
- **Provider Unavailability**: If Azure Foundry credentials are missing or the API key expires, calls to `/assist/triage` would fail. *Mitigation*: Graceful fallback to a dry-run mock model in local dev, clearly flagged as demo mode in response metadata.

---

## 4. Revisit When

- **Episode 10 (Streaming & Latency)**: Revisit the client's HTTP transport when Server-Sent Events (SSE) or WebSockets are introduced.
- **Episode 3 (Conversation Memory)**: Revisit when multi-turn conversation threads and conversation IDs are stored in the database.

---

## 5. Cross-Stack Consistency

- Mirrors standard microservice / modular monolith patterns: frontends receive trace IDs to enable correlation with backend APM (Jaeger), auth is handled via short-lived bearer JWTs, and CORS headers are strictly bounded to verified caller domains.
