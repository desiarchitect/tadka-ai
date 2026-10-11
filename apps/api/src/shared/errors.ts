// Domain errors. Routes map them to HTTP status codes in one place (app.ts).
export class NotFoundError extends Error { readonly status = 404; }
export class ForbiddenError extends Error { readonly status = 403; }
export class ConflictError extends Error { readonly status = 409; }
export class UnauthorizedError extends Error { readonly status = 401; }
export class PaymentFailedError extends Error { readonly status = 402; }
export class UpstreamError extends Error { readonly status = 502; }
