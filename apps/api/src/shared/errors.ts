// Domain errors. Routes map them to HTTP status codes in one place (app.ts).
// `denied` is internal diagnosis only: true when the resource exists but the caller may not
// see it. Only a domain service sets it, through this constructor; nothing derives it from a
// message. It is non-enumerable, so JSON.stringify and the HTTP error handler never include it.
export class NotFoundError extends Error {
  readonly status = 404;
  declare readonly denied: boolean;
  constructor(message: string, opts: { denied?: boolean } = {}) {
    super(message);
    Object.defineProperty(this, 'denied', { value: opts.denied === true, enumerable: false });
  }
}
export class ForbiddenError extends Error { readonly status = 403; }
export class ConflictError extends Error { readonly status = 409; }
export class UnauthorizedError extends Error { readonly status = 401; }
export class PaymentFailedError extends Error { readonly status = 402; }
export class UpstreamError extends Error { readonly status = 502; }
