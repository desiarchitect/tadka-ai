// Shutdown: first the sequence itself with injected stages, then the real processes started with
// the documented command, with telemetry on and off, a repeated signal, and a telemetry backend that hangs.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SHUTDOWN_DEADLINE_MS, createShutdown } from '../src/shutdown.js';
import { TEST_DB_URL } from './global-setup.js';
import { readFileSync } from 'node:fs';
import { blackhole, signal, startApp, stop, unfinishedRequest, waitReady, type Running } from './proc.js';

describe('createShutdown (injected stages)', () => {
  it('the default deadline is 8 seconds', () => expect(SHUTDOWN_DEADLINE_MS).toBe(8000));

  it('runs the stages in order, then exits 0', async () => {
    const order: string[] = [];
    const exit = vi.fn();
    await createShutdown({ exit, log: () => {}, stages: [{ name: 'a', run: async () => { order.push('a'); } }, { name: 'b', run: async () => { order.push('b'); } }] })('SIGTERM');
    expect(order).toEqual(['a', 'b']);
    expect(exit).toHaveBeenCalledExactlyOnceWith(0);
  });

  it('a stage that throws does not stop the later stages, and the exit code is 1', async () => {
    const later = vi.fn(async () => {});
    const exit = vi.fn();
    await createShutdown({ exit, log: () => {}, stages: [{ name: 'a', run: async () => { throw new Error('boom'); } }, { name: 'b', run: later }] })('SIGTERM');
    expect(later).toHaveBeenCalled();
    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
  });

  it('a stage that hangs is cut off at the deadline: exit 1 is forced', async () => {
    const exit = vi.fn();
    void createShutdown({ exit, log: () => {}, deadlineMs: 60, stages: [{ name: 'stuck', run: () => new Promise(() => {}) }] })('SIGTERM');
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1), { timeout: 1000 });
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it('normal shutdown waits for slow cleanup: it does not exit until the stage is done', async () => {
    const exit = vi.fn();
    const slow = createShutdown({ exit, log: () => {}, deadlineMs: 2000, stages: [{ name: 'slow', run: () => new Promise((r) => setTimeout(r, 150)) }] });
    const done = slow('SIGTERM');
    await new Promise((r) => setTimeout(r, 60));
    expect(exit).not.toHaveBeenCalled();
    await done;
    expect(exit).toHaveBeenCalledExactlyOnceWith(0);
  });

  it.each([['first (server)', 0], ['middle (database)', 1], ['last (telemetry)', 2]])('a hang in the %s stage is cut off at the deadline, and later stages never run', async (_n, hangAt) => {
    const ran: number[] = [];
    const exit = vi.fn();
    const stages = [0, 1, 2].map((i) => ({ name: `s${i}`, run: () => { ran.push(i); return i === hangAt ? new Promise<never>(() => {}) : Promise.resolve(); } }));
    void createShutdown({ exit, log: () => {}, deadlineMs: 80, stages })('SIGTERM');
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1), { timeout: 1500 });
    expect(ran).toEqual([0, 1, 2].filter((i) => i <= hangAt));
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it('a stage that finishes after the deadline cannot trigger a second exit', async () => {
    const exit = vi.fn();
    let release!: () => void;
    const late = new Promise<void>((r) => { release = r; });
    void createShutdown({ exit, log: () => {}, deadlineMs: 50, stages: [{ name: 'late', run: () => late }, { name: 'after', run: async () => {} }] })('SIGTERM');
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1), { timeout: 1000 });
    release();
    await new Promise((r) => setTimeout(r, 50));
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it('a log function that throws (closed stdout) does not break the sequence', async () => {
    const exit = vi.fn();
    const run = vi.fn(async () => {});
    await createShutdown({ exit, log: () => { throw new Error('EPIPE'); }, stages: [{ name: 'a', run }] })('SIGTERM');
    expect(run).toHaveBeenCalled();
    expect(exit).toHaveBeenCalledExactlyOnceWith(0);
  });

  it('the root dev script keeps --no-bail: without it pnpm kills the API and fake provider mid-shutdown as soon as the Vite dev server exits on Ctrl+C', () => {
    const root = JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8')) as { scripts: { dev: string } };
    expect(root.scripts.dev).toContain('--no-bail');
  });

  it('a repeated signal does not start a second sequence', async () => {
    const run = vi.fn(async () => {});
    const logs: string[] = [];
    const exit = vi.fn();
    const shutdown = createShutdown({ exit, log: (l) => logs.push(l), stages: [{ name: 'a', run }] });
    await Promise.all([shutdown('SIGTERM'), shutdown('SIGINT'), shutdown('SIGTERM')]);
    expect(run).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(logs.filter((l) => l.includes('already shutting down'))).toHaveLength(2);
  });

  it('the telemetry stage gives up after its own limit, and does not need the stop function to be present', async () => {
    const { telemetryStage, TELEMETRY_STOP } = await import('../src/shutdown.js');
    await expect(telemetryStage(50).run()).resolves.toBeUndefined(); // nothing registered: nothing to flush
    (globalThis as Record<symbol, unknown>)[TELEMETRY_STOP] = () => new Promise(() => {});
    try { await expect(telemetryStage(50).run()).rejects.toThrow(/timed out/); } finally { delete (globalThis as Record<symbol, unknown>)[TELEMETRY_STOP]; }
  });

  it('a nonsense deadline falls back to the default instead of firing at once', async () => {
    const exit = vi.fn();
    const slow = createShutdown({ exit, log: () => {}, deadlineMs: Number.NaN, stages: [{ name: 'a', run: () => new Promise((r) => setTimeout(r, 80)) }] });
    await slow('SIGTERM');
    expect(exit).toHaveBeenCalledExactlyOnceWith(0);
  });
});

describe.skipIf(process.platform === 'win32')('the API process (documented command) [skipped on Windows: child.kill does not send POSIX signals]', () => {
  let running: Running | undefined;
  let sink: Awaited<ReturnType<typeof blackhole>> | undefined;
  afterEach(async () => { if (running) await stop(running); running = undefined; sink?.server.close(); sink = undefined; });
  const base = { DATABASE_URL: TEST_DB_URL, DEMO_MODE: '1' };
  const touch = async (r: Running) => { for (let i = 0; i < 3; i++) await fetch(`http://127.0.0.1:${r.port}/health`); };

  it('telemetry OFF: SIGTERM exits 0 promptly', async () => {
    running = await startApp('api', base);
    await waitReady(running);
    signal(running, 'SIGTERM');
    const { code, ms } = await running.exited;
    expect(code).toBe(0);
    expect(ms).toBeLessThan(3000);
    expect(running.output()).toMatch(/shutdown: server done[\s\S]*shutdown: database done[\s\S]*shutdown: telemetry done/);
  }, 30_000);

  it('SIGINT is handled the same way', async () => {
    running = await startApp('api', base);
    await waitReady(running);
    signal(running, 'SIGINT');
    expect((await running.exited).code).toBe(0);
  }, 30_000);

  it('telemetry ON, backend refusing connections: SIGTERM still exits inside the deadline (this was the bug: it stayed alive)', async () => {
    running = await startApp('api', { ...base, OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:1' });
    await waitReady(running);
    await touch(running);
    signal(running, 'SIGTERM');
    const { code, ms } = await running.exited;
    expect(ms).toBeLessThan(5000); // the flush has its own 3 s bound, well inside the 8 s deadline
    expect(code).toBe(1); // the flush failed, and the exit code says so
    expect(running.output()).toMatch(/shutdown: server done[\s\S]*shutdown: database done[\s\S]*shutdown: telemetry failed/);
    expect(running.output()).not.toMatch(/forcing exit/);
  }, 30_000);

  it('repeated SIGTERM runs one sequence', async () => {
    running = await startApp('api', base);
    await waitReady(running);
    signal(running, 'SIGTERM');
    signal(running, 'SIGTERM');
    signal(running, 'SIGINT');
    await running.exited;
    const out = running.output();
    expect(out.match(/shutdown: server done/g)).toHaveLength(1);
    expect(out.match(/received/g)).toHaveLength(1);
  }, 30_000);

  it('server close that hangs on an unfinished request: the deadline forces exit 1 and the later stages never run', async () => {
    running = await startApp('api', { ...base, SHUTDOWN_DEADLINE_MS: '1500' });
    await waitReady(running);
    const sock = await unfinishedRequest(running.port);
    signal(running, 'SIGTERM');
    const { code, ms } = await running.exited;
    sock.destroy();
    expect(code).toBe(1);
    expect(ms).toBeGreaterThanOrEqual(1400);
    expect(ms).toBeLessThan(5000);
    const out = running.output();
    expect(out).toMatch(/deadline passed, forcing exit/);
    expect(out).not.toMatch(/shutdown: server done/);
    expect(out).not.toMatch(/shutdown: database done/);
  }, 30_000);

  it('telemetry ON, backend that never answers: the hard deadline forces exit 1', async () => {
    sink = await blackhole();
    running = await startApp('api', { ...base, OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${sink.port}`, SHUTDOWN_DEADLINE_MS: '1500' });
    await waitReady(running);
    await touch(running);
    signal(running, 'SIGTERM');
    const { code, ms } = await running.exited;
    expect(code).toBe(1);
    expect(ms).toBeGreaterThanOrEqual(1400);
    expect(ms).toBeLessThan(6000);
    expect(running.output()).toMatch(/deadline passed, forcing exit/);
  }, 30_000);
});
