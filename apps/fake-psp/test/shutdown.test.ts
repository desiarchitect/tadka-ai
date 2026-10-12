// The fake payment provider has the same shutdown contract as the API: SIGTERM must end the process,
// with telemetry on or off, inside the deadline. Started with the command in its package.json.
import { afterEach, describe, expect, it } from 'vitest';
import { blackhole, signal, startApp, stop, unfinishedRequest, waitReady, type Running } from '../../api/test/proc.js';

describe('fake-psp process (documented command)', () => {
  let running: Running | undefined;
  let sink: Awaited<ReturnType<typeof blackhole>> | undefined;
  afterEach(async () => { if (running) await stop(running); running = undefined; sink?.server.close(); sink = undefined; });

  it('telemetry OFF: SIGTERM exits 0 promptly', async () => {
    running = await startApp('fake-psp', {});
    await waitReady(running);
    signal(running, 'SIGTERM');
    const { code, ms } = await running.exited;
    expect(code).toBe(0);
    expect(ms).toBeLessThan(3000);
    expect(running.output()).toMatch(/shutdown: server done[\s\S]*shutdown: telemetry done/);
  }, 30_000);

  it('telemetry ON, backend refusing connections: still exits inside the deadline (this was the bug: it stayed alive)', async () => {
    running = await startApp('fake-psp', { OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:1' });
    await waitReady(running);
    for (let i = 0; i < 3; i++) await fetch(`http://127.0.0.1:${running.port}/health`);
    signal(running, 'SIGTERM');
    const { code, ms } = await running.exited;
    expect(ms).toBeLessThan(5000);
    expect(code).toBe(1);
    expect(running.output()).toMatch(/shutdown: telemetry failed/);
  }, 30_000);

  it('repeated signals run one sequence', async () => {
    running = await startApp('fake-psp', {});
    await waitReady(running);
    signal(running, 'SIGTERM');
    signal(running, 'SIGINT');
    await running.exited;
    expect(running.output().match(/received/g)).toHaveLength(1);
  }, 30_000);

  it('server close that hangs on an unfinished request: the deadline forces exit 1', async () => {
    running = await startApp('fake-psp', { SHUTDOWN_DEADLINE_MS: '1500' });
    await waitReady(running);
    const sock = await unfinishedRequest(running.port);
    signal(running, 'SIGTERM');
    const { code, ms } = await running.exited;
    sock.destroy();
    expect(code).toBe(1);
    expect(ms).toBeGreaterThanOrEqual(1400);
    expect(ms).toBeLessThan(5000);
    expect(running.output()).toMatch(/deadline passed, forcing exit/);
    expect(running.output()).not.toMatch(/shutdown: server done/);
  }, 30_000);

  it('telemetry ON, backend that never answers: the hard deadline forces exit 1', async () => {
    sink = await blackhole();
    running = await startApp('fake-psp', { OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${sink.port}`, SHUTDOWN_DEADLINE_MS: '1500' });
    await waitReady(running);
    for (let i = 0; i < 3; i++) await fetch(`http://127.0.0.1:${running.port}/health`);
    signal(running, 'SIGTERM');
    const { code, ms } = await running.exited;
    expect(code).toBe(1);
    expect(ms).toBeLessThan(6000);
    expect(running.output()).toMatch(/deadline passed, forcing exit/);
  }, 30_000);
});
