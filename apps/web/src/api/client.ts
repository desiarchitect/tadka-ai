import type { z } from 'zod';
import { ErrorBodySchema, LoginResponseSchema, TriageResponseSchema } from './schema.js';
import type { ApiDiagnostics, LoginResponse, TriageResponse } from './types.js';

export const API_BASE_URL = (import.meta.env.VITE_API_URL as string | undefined) || 'http://localhost:3000';

// Longer than the server's own provider timeout (15 s), so the server's answer arrives first and the
// client timeout only fires when the server itself is unreachable or stuck.
export const API_TIMEOUT_MS = 20_000;

/** The caller cancelled the request. Not a failure: the UI shows nothing. */
export class RequestCancelledError extends Error {
  constructor() { super('Request cancelled'); this.name = 'RequestCancelledError'; }
}
export const isCancelled = (err: unknown): err is RequestCancelledError => err instanceof RequestCancelledError;

type Result<T> = { data: T; diagnostics: ApiDiagnostics };
type Call<T> = {
  path: string;
  body: unknown;
  token?: string | null;
  signal?: AbortSignal;
  schema: z.ZodType<T>;
  /** Wording shown to the user for an HTTP error. Never the raw server text. */
  describe: (status: number, code: string) => string;
  /** Extra diagnostics taken from a valid success response. */
  onSuccess?: (data: T) => Partial<ApiDiagnostics>;
};

// Application-owned wording for the error codes the API can send. The server text itself is never shown.
const triageMessage = (status: number, code: string): string => {
  switch (code) {
    case 'missing_token': case 'invalid_token': return 'Authentication required. Please sign in as a customer.';
    case 'forbidden_role': return 'Only customer accounts can use the assistant.';
    case 'rate_limited': return 'Too many requests. Please wait a minute and try again.';
    case 'provider_not_configured': return 'No AI model is configured on the server. Ask the operator to set up a provider, or to turn on DEMO_MODE for simulated answers.';
    case 'provider_rate_limited': return 'The AI provider is busy right now. Please try again shortly.';
    case 'provider_timeout': return 'The AI provider took too long to answer. Please try again.';
    case 'provider_auth': case 'provider_unavailable': case 'provider_bad_output': return 'The AI provider could not answer this request. Please try again later.';
    case 'invalid_request': return 'Invalid message (it must be 1 to 500 characters).';
  }
  if (status === 400) return 'Invalid message (it must be 1 to 500 characters).';
  if (status >= 500) return 'Server error processing triage request.';
  return 'Request failed';
};
const loginMessage = (_status: number, code: string): string => (code === 'invalid_credentials' ? 'Invalid email or password' : 'Login failed');

export class ApiClient {
  private baseUrl: string;
  private timeoutMs: number;

  constructor(baseUrl: string = API_BASE_URL, timeoutMs: number = API_TIMEOUT_MS) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.timeoutMs = timeoutMs;
  }

  login(email: string, password: string, signal?: AbortSignal): Promise<Result<LoginResponse>> {
    return this.post({ path: '/auth/login', body: { email, password }, signal, schema: LoginResponseSchema, describe: loginMessage });
  }

  triage(message: string, accessToken: string | null, signal?: AbortSignal): Promise<Result<TriageResponse>> {
    return this.post({
      path: '/assist/triage', body: { message }, token: accessToken, signal, schema: TriageResponseSchema, describe: triageMessage,
      onSuccess: (data) => ({
        userRole: data.authenticatedAs?.role,
        userId: data.authenticatedAs?.userId,
        modelId: data.modelId,
        simulated: data.simulated,
        tokenUsage: data.usage ? { inputTokens: data.usage.inputTokens, outputTokens: data.usage.outputTokens } : undefined,
      }),
    });
  }

  private async post<T>(call: Call<T>): Promise<Result<T>> {
    if (call.signal?.aborted) throw new RequestCancelledError(); // cancelled before it started: nothing to send
    const started = performance.now();
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, this.timeoutMs);
    const onCallerAbort = () => controller.abort();
    if (call.signal?.aborted) controller.abort();
    else call.signal?.addEventListener('abort', onCallerAbort, { once: true });

    const base = (): Pick<ApiDiagnostics, 'durationMs' | 'timestamp'> => ({ durationMs: Math.round(performance.now() - started), timestamp: new Date().toISOString() });
    const fail = (d: Omit<ApiDiagnostics, 'outcome' | 'durationMs' | 'timestamp'>): never => {
      const diagnostics: ApiDiagnostics = { ...d, outcome: 'error', ...base() };
      throw Object.assign(new Error(diagnostics.errorMessage), { diagnostics });
    };

    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (call.token) headers['Authorization'] = `Bearer ${call.token}`;
      const res = await fetch(`${this.baseUrl}${call.path}`, { method: 'POST', headers, body: JSON.stringify(call.body), signal: controller.signal });
      const traceId = res.headers.get('x-trace-id');
      const requestId = res.headers.get('x-request-id');
      const common = { httpStatus: res.status, statusText: res.statusText, traceId, requestId };

      if (!res.ok) {
        const parsed = ErrorBodySchema.safeParse(await res.json().catch(() => null));
        const code = parsed.success ? parsed.data.error : `http_${res.status}`;
        return fail({ ...common, authenticated: res.status !== 401, errorCode: code, errorMessage: call.describe(res.status, code) });
      }

      const parsed = call.schema.safeParse(await res.json().catch(() => null));
      if (!parsed.success) {
        return fail({ ...common, authenticated: true, errorCode: 'invalid_response', errorMessage: 'The server sent a response this page could not understand.' });
      }
      return { data: parsed.data, diagnostics: { ...common, outcome: 'success', authenticated: true, ...call.onSuccess?.(parsed.data), ...base() } };
    } catch (err: unknown) {
      if ((err as { diagnostics?: ApiDiagnostics }).diagnostics) throw err;
      const none = { httpStatus: 0, traceId: null, requestId: null, authenticated: false };
      if (timedOut) {
        return fail({ ...none, statusText: 'Timeout', errorCode: 'client_timeout', errorMessage: `No answer within ${Math.round(this.timeoutMs / 1000)} seconds. The request was stopped; please try again.` });
      }
      if (call.signal?.aborted) throw new RequestCancelledError();
      return fail({ ...none, statusText: 'Network Error', errorCode: 'network_error', errorMessage: `Unable to reach the Tadka API at ${this.baseUrl}` });
    } finally {
      clearTimeout(timer);
      call.signal?.removeEventListener('abort', onCallerAbort);
    }
  }
}

export const apiClient = new ApiClient();
