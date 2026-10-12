// Turns whatever the AI SDK throws into an application-owned status and code. Provider text
// (messages, response bodies, urls, resource names) is never copied into the result.
import { APICallError, EmptyResponseBodyError, InvalidResponseDataError, JSONParseError, LoadAPIKeyError, LoadSettingError, NoContentGeneratedError, NoObjectGeneratedError, NoOutputGeneratedError, RetryError, TypeValidationError } from 'ai';
import { ProviderError } from '../shared/errors.js';

const named = (e: unknown, name: string) => typeof e === 'object' && e !== null && (e as { name?: unknown }).name === name;
const isTimeout = (e: unknown) => named(e, 'TimeoutError') || named((e as { cause?: unknown } | null)?.cause, 'TimeoutError');

// Returns null for anything that is not a provider failure: the caller rethrows it unchanged.
export function classifyProviderError(err: unknown): ProviderError | null {
  if (RetryError.isInstance(err)) return classifyProviderError(err.lastError) ?? new ProviderError(502, 'provider_unavailable');
  if (isTimeout(err)) return new ProviderError(504, 'provider_timeout');
  if (LoadAPIKeyError.isInstance(err) || LoadSettingError.isInstance(err)) return new ProviderError(503, 'provider_not_configured');
  if (APICallError.isInstance(err)) {
    const s = err.statusCode;
    if (s === 401 || s === 403) return new ProviderError(502, 'provider_auth');
    if (s === 429) {
      const ra = Number(err.responseHeaders?.['retry-after']);
      return new ProviderError(429, 'provider_rate_limited', Number.isFinite(ra) && ra > 0 ? Math.ceil(ra) : undefined);
    }
    if (s === 408 || s === 504) return new ProviderError(504, 'provider_timeout');
    return new ProviderError(502, 'provider_unavailable');
  }
  if (
    NoObjectGeneratedError.isInstance(err) || JSONParseError.isInstance(err) || TypeValidationError.isInstance(err) ||
    InvalidResponseDataError.isInstance(err) || EmptyResponseBodyError.isInstance(err) || NoContentGeneratedError.isInstance(err) || NoOutputGeneratedError.isInstance(err)
  ) return new ProviderError(502, 'provider_bad_output');
  return null;
}

// What may be logged about a provider failure: our code, the error class, the provider's status number, and two
// short machine identifiers the provider sent (its error code, for example DeploymentNotFound, and its request id,
// which its support can look up). Never the message, the body, the url or the headers. An identifier is logged only
// if it looks like an identifier (letters, digits and . _ : - up to 64 characters), so free text cannot get in this way.
const TOKEN = /^[A-Za-z0-9_.:-]{1,64}$/;
const token = (v: unknown): string | undefined => (typeof v === 'string' && TOKEN.test(v) ? v : typeof v === 'number' ? String(v) : undefined);

export function safeErrorFields(err: unknown, code: string) {
  const cause = RetryError.isInstance(err) ? err.lastError : err;
  const base = { code, errorName: (err as { name?: string } | null)?.name ?? 'unknown' };
  if (!APICallError.isInstance(cause)) return base;
  const data = cause.data as { error?: { code?: unknown; type?: unknown } } | undefined;
  const h = cause.responseHeaders ?? {};
  return {
    ...base,
    providerStatus: cause.statusCode,
    providerErrorCode: token(data?.error?.code),
    providerErrorType: token(data?.error?.type),
    providerRequestId: token(h['x-request-id'] ?? h['apim-request-id'] ?? h['x-ms-request-id']),
  };
}
