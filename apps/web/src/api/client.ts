import type { ApiDiagnostics, LoginResponse, TriageResponse } from './types.js';

export const API_BASE_URL = (import.meta.env.VITE_API_URL as string | undefined) || 'http://localhost:3000';

export class ApiClient {
  private baseUrl: string;

  constructor(baseUrl: string = API_BASE_URL) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
  }

  async login(email: string, password: string): Promise<{ data: LoginResponse; diagnostics: ApiDiagnostics }> {
    const started = performance.now();
    try {
      const res = await fetch(`${this.baseUrl}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      const durationMs = Math.round(performance.now() - started);
      const traceId = res.headers.get('x-trace-id');
      const requestId = res.headers.get('x-request-id');

      if (!res.ok) {
        const errJson = (await res.json().catch(() => ({}))) as { error?: string };
        const diagnostics: ApiDiagnostics = {
          httpStatus: res.status,
          statusText: res.statusText,
          outcome: 'error',
          traceId,
          requestId,
          durationMs,
          authenticated: false,
          errorCode: errJson.error ?? `http_${res.status}`,
          errorMessage: errJson.error === 'invalid_credentials' ? 'Invalid email or password' : 'Login failed',
          timestamp: new Date().toISOString(),
        };
        throw Object.assign(new Error(diagnostics.errorMessage), { diagnostics });
      }

      const data = (await res.json()) as LoginResponse;
      const diagnostics: ApiDiagnostics = {
        httpStatus: res.status,
        statusText: res.statusText,
        outcome: 'success',
        traceId,
        requestId,
        durationMs,
        authenticated: true,
        timestamp: new Date().toISOString(),
      };
      return { data, diagnostics };
    } catch (err: unknown) {
      if ((err as { diagnostics?: ApiDiagnostics }).diagnostics) throw err;
      const durationMs = Math.round(performance.now() - started);
      const diagnostics: ApiDiagnostics = {
        httpStatus: 0,
        statusText: 'Network Error',
        outcome: 'error',
        traceId: null,
        requestId: null,
        durationMs,
        authenticated: false,
        errorCode: 'network_error',
        errorMessage: 'Unable to reach Tadka API server at ' + this.baseUrl,
        timestamp: new Date().toISOString(),
      };
      throw Object.assign(new Error(diagnostics.errorMessage), { diagnostics });
    }
  }

  async triage(
    message: string,
    accessToken: string | null
  ): Promise<{ data: TriageResponse; diagnostics: ApiDiagnostics }> {
    const started = performance.now();
    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };
      if (accessToken) {
        headers['Authorization'] = `Bearer ${accessToken}`;
      }

      const res = await fetch(`${this.baseUrl}/assist/triage`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ message }),
      });
      const durationMs = Math.round(performance.now() - started);
      const traceId = res.headers.get('x-trace-id');
      const requestId = res.headers.get('x-request-id');

      if (!res.ok) {
        const errJson = (await res.json().catch(() => ({}))) as { error?: string };
        const errorCode = errJson.error ?? `http_${res.status}`;
        let errorMessage = 'Request failed';
        if (res.status === 401) errorMessage = 'Authentication required. Please sign in as a customer.';
        else if (res.status === 400) errorMessage = 'Invalid message payload (must be 1-500 characters).';
        else if (res.status === 503) errorMessage = 'Model provider not configured on server.';
        else if (res.status >= 500) errorMessage = 'Server error processing triage request.';

        const diagnostics: ApiDiagnostics = {
          httpStatus: res.status,
          statusText: res.statusText,
          outcome: 'error',
          traceId,
          requestId,
          durationMs,
          authenticated: res.status !== 401,
          errorCode,
          errorMessage,
          timestamp: new Date().toISOString(),
        };
        throw Object.assign(new Error(errorMessage), { diagnostics });
      }

      const data = (await res.json()) as TriageResponse;
      const diagnostics: ApiDiagnostics = {
        httpStatus: res.status,
        statusText: res.statusText,
        outcome: 'success',
        traceId,
        requestId,
        durationMs,
        authenticated: true,
        userRole: data.authenticatedAs?.role,
        userId: data.authenticatedAs?.userId,
        modelId: data.modelId,
        tokenUsage: data.usage
          ? {
              inputTokens: typeof data.usage.inputTokens === 'object' ? (data.usage.inputTokens as { total?: number }).total : data.usage.inputTokens,
              outputTokens: typeof data.usage.outputTokens === 'object' ? (data.usage.outputTokens as { total?: number }).total : data.usage.outputTokens,
            }
          : undefined,
        timestamp: new Date().toISOString(),
      };
      return { data, diagnostics };
    } catch (err: unknown) {
      if ((err as { diagnostics?: ApiDiagnostics }).diagnostics) throw err;
      const durationMs = Math.round(performance.now() - started);
      const diagnostics: ApiDiagnostics = {
        httpStatus: 0,
        statusText: 'Network Error',
        outcome: 'error',
        traceId: null,
        requestId: null,
        durationMs,
        authenticated: false,
        errorCode: 'network_error',
        errorMessage: 'Unable to connect to Tadka backend at ' + this.baseUrl,
        timestamp: new Date().toISOString(),
      };
      throw Object.assign(new Error(diagnostics.errorMessage), { diagnostics });
    }
  }
}

export const apiClient = new ApiClient();
