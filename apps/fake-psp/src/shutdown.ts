// One bounded shutdown for SIGTERM and SIGINT. Stages run in order (stop the server, then the
// database pool, then telemetry). One hard deadline covers all of them: if a stage hangs, the
// process exits with code 1 when the deadline passes. A repeated signal does not start a second run.
// A request still running at the deadline is abandoned.
export const SHUTDOWN_DEADLINE_MS = 8000;

export type Stage = { name: string; run: () => Promise<unknown> };
type Options = {
  stages: Stage[];
  deadlineMs?: number;
  log?: (line: string) => void;
  exit?: (code: number) => void;
};

export function createShutdown({ stages, deadlineMs: requested, log = (l) => console.log(l), exit = (c) => process.exit(c) }: Options) {
  const deadlineMs = requested !== undefined && Number.isFinite(requested) && requested > 0 ? requested : SHUTDOWN_DEADLINE_MS;
  // A closed stdout (the parent went away first) must not break the sequence.
  const say = (line: string) => { try { log(line); } catch { /* nothing to do */ } };
  let started: Promise<void> | undefined;
  return function shutdown(signal: string): Promise<void> {
    if (started) { say(`shutdown: ${signal} ignored, already shutting down`); return started; }
    say(`shutdown: ${signal} received, deadline ${deadlineMs} ms`);
    let forced = false;
    // Started before any stage, so it covers all of them: whichever stage hangs, the process still ends.
    const timer = setTimeout(() => { forced = true; say('shutdown: deadline passed, forcing exit'); exit(1); }, deadlineMs);
    started = (async () => {
      let ok = true;
      for (const s of stages) {
        if (forced) return; // the deadline already ended the process; do not run or report anything more
        try { await s.run(); say(`shutdown: ${s.name} done`); } catch (e) { ok = false; say(`shutdown: ${s.name} failed (${(e as Error)?.name ?? 'error'})`); }
      }
      clearTimeout(timer);
      if (!forced) exit(ok ? 0 : 1);
    })();
    return started;
  };
}

// instrument.ts runs first (`--import`) and leaves its stop function here, so main does not depend on
// the two files being the same module instance under tsx.
export const TELEMETRY_STOP = Symbol.for('tadka.telemetry.stop');
// A collector that is down or slow must not use up the whole deadline: the flush gets its own, shorter bound.
export const TELEMETRY_STAGE_MS = 3000;
export const telemetryStage = (limitMs = TELEMETRY_STAGE_MS): Stage => ({
  name: 'telemetry',
  run: async () => {
    const stop = (globalThis as Record<symbol, (() => Promise<void>) | undefined>)[TELEMETRY_STOP];
    if (!stop) return;
    let timer: NodeJS.Timeout | undefined;
    const limit = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('telemetry flush timed out')), limitMs); });
    try { await Promise.race([stop(), limit]); } finally { clearTimeout(timer); }
  },
});

export function installSignalHandlers(shutdown: (signal: string) => Promise<void>) {
  for (const sig of ['SIGTERM', 'SIGINT'] as const) process.on(sig, () => void shutdown(sig));
}
