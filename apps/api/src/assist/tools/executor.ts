// The tool executor (roadmap §3.4). For every call the model asks for, in this order:
// known tool -> parse -> strict validation -> role check -> side-effect policy -> service
// call with the verified Principal -> allow-listed, size-capped result.
// The model never supplies identity, and every call gets exactly one result.
import { NotFoundError } from '../../shared/errors.js';
import type { Principal } from '../../shared/principal.js';
import { inSpan } from '../../shared/tracing.js';
import type { SecurityAudit } from './audit.js';
import { isToolName, TOOLS, type ToolServices } from './registry.js';
import { fitResult, MAX_RESULT_BYTES, type ToolData } from './views.js';

export type InternalStatus = 'ok' | 'not_found' | 'forbidden_as_not_found' | 'invalid_args' | 'failed';
export type PublicStatus = 'ok' | 'not_found' | 'invalid_args' | 'failed';
export type ToolCallRequest = { callId: string; tool: string; input: unknown; unparsable?: boolean };
export type ModelResult =
  | { status: 'ok'; data: ToolData }
  | { status: 'not_found' }
  | { status: 'invalid_args'; reason: 'unknown_tool' | 'unparsable' | 'schema'; issues?: string[] }
  | { status: 'failed' };
export type ToolOutcome = { callId: string; tool: string; status: InternalStatus; publicStatus: PublicStatus; modelResult: ModelResult; reason?: string };

export type ExecutorDeps = ToolServices & {
  audit: SecurityAudit;
  log: (line: { event: 'assist.tool'; tool: string; status: PublicStatus }) => void;
  maxResultBytes?: number;
};

// The internal status the model and the user must not see collapses to plain not_found.
export const toPublic = (s: InternalStatus): PublicStatus => (s === 'forbidden_as_not_found' ? 'not_found' : s);

export async function executeToolCall(deps: ExecutorDeps, p: Principal, call: ToolCallRequest): Promise<ToolOutcome> {
  const tool = isToolName(call.tool) ? call.tool : 'unknown';
  const outcome = await inSpan('assist.tool', { 'tadka.tool': tool }, () => run(deps, p, call));
  // Ordinary log and span: the public status only, identical for a foreign and an invented id.
  deps.log({ event: 'assist.tool', tool, status: outcome.publicStatus });
  return outcome;
}

async function run(deps: ExecutorDeps, p: Principal, call: ToolCallRequest): Promise<ToolOutcome> {
  const done = (status: InternalStatus, modelResult: ModelResult, reason?: string): ToolOutcome =>
    ({ callId: call.callId, tool: call.tool, status, publicStatus: toPublic(status), modelResult, ...(reason ? { reason } : {}) });

  // A tool that doesn't exist and a tool this role isn't offered look the same to the model.
  if (!isToolName(call.tool)) return done('invalid_args', { status: 'invalid_args', reason: 'unknown_tool' });
  const def = TOOLS[call.tool];
  if (call.unparsable) return done('invalid_args', { status: 'invalid_args', reason: 'unparsable' });
  const parsed = def.input.safeParse(call.input);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.code}`);
    return done('invalid_args', { status: 'invalid_args', reason: 'schema', issues });
  }
  if (!def.roles.includes(p.role)) return done('invalid_args', { status: 'invalid_args', reason: 'unknown_tool' });
  if (def.sideEffect !== 'read') return done('failed', { status: 'failed' }, 'side_effect_not_allowed');

  try {
    const data = await def.run(deps, p, parsed.data as never);
    const fitted = fitResult(data, deps.maxResultBytes ?? MAX_RESULT_BYTES);
    if (!fitted) return done('failed', { status: 'failed' }, 'result_too_large');
    return done('ok', { status: 'ok', data: fitted });
  } catch (err) {
    if (err instanceof NotFoundError) {
      if (err.denied === true) {
        const requested = Object.values(parsed.data as Record<string, string>)[0] ?? '';
        deps.audit.record({ event: 'forbidden_as_not_found', tool: call.tool, principalId: p.userId, requestedIdHmac: deps.audit.hmac(requested) });
        return done('forbidden_as_not_found', { status: 'not_found' });
      }
      return done('not_found', { status: 'not_found' });
    }
    // A database or backend failure is never reported as "no orders".
    return done('failed', { status: 'failed' }, 'backend_error');
  }
}
