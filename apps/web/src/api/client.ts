import type { z } from 'zod';
import { ErrorBodySchema, IntentResponseSchema, LoginResponseSchema, MenuSchema, NoContentSchema, OrderDetailSchema, OrderListSchema, OrderSchema, OrderStatusResponseSchema, RestaurantListSchema, TriageResponseSchema } from './schema.js';
import type { ApiDiagnostics, IntentResponse, LoginResponse, Menu, Order, OrderDetail, OrderStatusResponse, Restaurant, TriageResponse } from './types.js';

// Where the API is. VITE_API_URL is compiled into the bundle, so it must be set when a production build is made.
// The localhost default exists only for local development (`vite`, the tests): a production build that was made
// without VITE_API_URL has no address at all, rather than quietly pointing every visitor at their own localhost.
// The default is a separate constant on purpose: `import.meta.env.DEV` is replaced by `false` when a production
// bundle is made, so the bundler removes the localhost string from it entirely (scripts/check-bundle.mjs checks).
const DEV_DEFAULT = import.meta.env.DEV ? 'http://localhost:3000' : null;

export function resolveApiBaseUrl(
  env: { VITE_API_URL?: string; DEV?: boolean } = { VITE_API_URL: import.meta.env.VITE_API_URL, DEV: import.meta.env.DEV },
  devDefault: string | null = DEV_DEFAULT,
): string | null {
  const configured = env.VITE_API_URL?.trim();
  if (configured) return configured;
  return env.DEV ? devDefault : null;
}

export const API_BASE_URL = resolveApiBaseUrl();

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
  method?: 'GET' | 'POST';
  path: string;
  body?: unknown;
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
// Wording for the product-data calls (restaurants, menus, orders, payment). Also never the raw server text.
const dataMessage = (status: number, code: string): string => {
  if (status === 401) return 'Your session has ended. Please sign in again.';
  if (status === 403) return 'You are not allowed to see that.';
  if (status === 404) return 'That could not be found.';
  if (status === 429) return 'Too many requests. Please wait a minute and try again.';
  if (code === 'invalid_response') return 'The server sent a response this page could not understand.';
  if (status >= 500) return 'The server had a problem. Please try again.';
  return 'Request failed';
};
const payMessage = (status: number, code: string): string => {
  if (status === 409) {
    const now = /^order_is_(\w+)$/.exec(code)?.[1] ?? /^cannot_move_(\w+)_to_/.exec(code)?.[1];
    if (code === 'order_changed_concurrently') return 'This order changed while you were paying. The list has been refreshed; nothing was charged twice.';
    return now ? `This order is now ${now} and can no longer be paid.` : 'This order can no longer be paid.';
  }
  if (status === 402) return 'The payment was declined. You were not charged.';
  if (status === 502) return 'We could not confirm the payment with the payment provider. Please check the order status before trying again.';
  return dataMessage(status, code);
};
const intentMessage = (status: number, code: string): string => {
  switch (code) {
    case 'missing_token': case 'invalid_token': return 'Authentication required. Please sign in as a customer.';
    case 'customers_only': case 'forbidden_role': return 'Only customer accounts can use the assistant.';
    case 'rate_limited': return 'Too many requests. Please wait a minute and try again.';
    case 'assistant_unavailable': return 'The classifier could not answer right now. Please try again.';
    case 'invalid_request': return 'Invalid message (it must be 1 to 500 characters).';
  }
  if (status >= 500) return 'Server error while classifying the message.';
  return 'Request failed';
};
const loginMessage = (_status: number, code: string): string => (code === 'invalid_credentials' ? 'Invalid email or password' : 'Login failed');

export class ApiClient {
  private baseUrl: string;
  private timeoutMs: number;

  constructor(baseUrl: string = API_BASE_URL ?? '', timeoutMs: number = API_TIMEOUT_MS) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.timeoutMs = timeoutMs;
  }

  login(email: string, password: string, signal?: AbortSignal): Promise<Result<LoginResponse>> {
    return this.post({ path: '/auth/login', body: { email, password }, signal, schema: LoginResponseSchema, describe: loginMessage, onSuccess: () => ({ modelInvolved: false }) });
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

  /** Classification only: one label from a fixed list. What happens next is chosen by server code, not the model. */
  intent(text: string, accessToken: string | null, signal?: AbortSignal): Promise<Result<IntentResponse>> {
    return this.send({
      path: '/assist/intent', body: { text }, token: accessToken, signal, schema: IntentResponseSchema, describe: intentMessage,
      // The keyword rules involve no model; the language-model classifier does, but this endpoint does not say which model.
      onSuccess: (data) => ({ simulated: data.simulated, modelInvolved: data.classifier === 'llm' }),
    });
  }

  /** A plain lookup by the server (no model): the status of one order the caller owns. */
  orderStatus(orderId: string, token: string, signal?: AbortSignal): Promise<Result<OrderStatusResponse>> {
    return this.send({ method: 'GET', path: `/assist/order-status?orderId=${encodeURIComponent(orderId)}`, token, signal, schema: OrderStatusResponseSchema, describe: dataMessage });
  }

  logout(refreshToken: string, signal?: AbortSignal): Promise<Result<null>> {
    return this.send({ path: '/auth/logout', body: { refreshToken }, signal, schema: NoContentSchema, describe: dataMessage });
  }

  restaurants(signal?: AbortSignal): Promise<Result<Restaurant[]>> {
    return this.send({ method: 'GET', path: '/restaurants', signal, schema: RestaurantListSchema, describe: dataMessage });
  }

  menu(restaurantId: string, signal?: AbortSignal): Promise<Result<Menu>> {
    return this.send({ method: 'GET', path: `/restaurants/${encodeURIComponent(restaurantId)}/menu`, signal, schema: MenuSchema, describe: dataMessage });
  }

  orders(token: string, signal?: AbortSignal): Promise<Result<Order[]>> {
    return this.send({ method: 'GET', path: '/orders', token, signal, schema: OrderListSchema, describe: dataMessage });
  }

  order(orderId: string, token: string, signal?: AbortSignal): Promise<Result<OrderDetail>> {
    return this.send({ method: 'GET', path: `/orders/${encodeURIComponent(orderId)}`, token, signal, schema: OrderDetailSchema, describe: dataMessage });
  }

  /** The server decides whether the order may be paid; the client only reports what it said. */
  pay(orderId: string, token: string, signal?: AbortSignal): Promise<Result<Order>> {
    return this.send({ path: `/orders/${encodeURIComponent(orderId)}/pay`, body: {}, token, signal, schema: OrderSchema, describe: payMessage });
  }

  private post<T>(call: Call<T>): Promise<Result<T>> { return this.send(call); }

  private async send<T>(call: Call<T>): Promise<Result<T>> {
    if (call.signal?.aborted) throw new RequestCancelledError(); // cancelled before it started: nothing to send
    const started = performance.now();
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, this.timeoutMs);
    const onCallerAbort = () => controller.abort();
    if (call.signal?.aborted) controller.abort();
    else call.signal?.addEventListener('abort', onCallerAbort, { once: true });

    if (!this.baseUrl) {
      const diagnostics: ApiDiagnostics = {
        httpStatus: 0, statusText: 'Not configured', outcome: 'error', traceId: null, requestId: null, durationMs: 0, authenticated: false,
        errorCode: 'api_url_not_configured', errorMessage: 'This build has no API address (VITE_API_URL was not set when it was built).', timestamp: new Date().toISOString(),
      };
      throw Object.assign(new Error(diagnostics.errorMessage), { diagnostics });
    }
    const base = (): Pick<ApiDiagnostics, 'durationMs' | 'timestamp'> => ({ durationMs: Math.round(performance.now() - started), timestamp: new Date().toISOString() });
    const fail = (d: Omit<ApiDiagnostics, 'outcome' | 'durationMs' | 'timestamp'>): never => {
      const diagnostics: ApiDiagnostics = { ...d, outcome: 'error', ...base() };
      throw Object.assign(new Error(diagnostics.errorMessage), { diagnostics });
    };

    try {
      const headers: Record<string, string> = {};
      if ((call.method ?? 'POST') === 'POST') headers['Content-Type'] = 'application/json';
      if (call.token) headers['Authorization'] = `Bearer ${call.token}`;
      const method = call.method ?? 'POST';
      const res = await fetch(`${this.baseUrl}${call.path}`, { method, headers, ...(method === 'POST' ? { body: JSON.stringify(call.body ?? {}) } : {}), signal: controller.signal });
      const traceId = res.headers.get('x-trace-id');
      const requestId = res.headers.get('x-request-id');
      const common = { httpStatus: res.status, statusText: res.statusText, traceId, requestId };

      if (!res.ok) {
        const parsed = ErrorBodySchema.safeParse(await res.json().catch(() => null));
        const code = parsed.success ? parsed.data.error : `http_${res.status}`;
        return fail({ ...common, authenticated: res.status !== 401, errorCode: code, errorMessage: call.describe(res.status, code) });
      }

      const parsed = call.schema.safeParse(res.status === 204 ? null : await res.json().catch(() => null));
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
