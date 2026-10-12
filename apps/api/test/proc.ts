// Starts an app the way its package.json `dev` script does, so a test exercises the documented
// command (same node flags, same --import of instrument.ts), not a lookalike.
import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { connect, createServer, type Server, type Socket } from 'node:net';
import { fileURLToPath } from 'node:url';

export const documentedArgs = (appDir: string): string[] => {
  const dev = (JSON.parse(readFileSync(new URL(`${appDir}/package.json`, import.meta.url), 'utf8')) as { scripts: { dev: string } }).scripts.dev;
  const [node, ...args] = dev.split(/\s+/);
  if (node !== 'node') throw new Error(`expected the dev script to start with node, got: ${dev}`);
  return args;
};

export const freePort = () => new Promise<number>((resolve, reject) => {
  const s = createServer();
  s.once('error', reject);
  s.listen(0, '127.0.0.1', () => { const { port } = s.address() as { port: number }; s.close(() => resolve(port)); });
});

// A TCP server that accepts connections and never answers: a telemetry backend that hangs.
export const blackhole = () => new Promise<{ server: Server; port: number }>((resolve) => {
  const server = createServer((sock) => { sock.on('error', () => {}); });
  server.listen(0, '127.0.0.1', () => resolve({ server, port: (server.address() as { port: number }).port }));
});

// Settings that must not leak in from the developer's shell or .env: an empty value counts as unset,
// and `--env-file-if-exists` never overrides a variable that is already set.
const CLEARED = ['LLM_PROVIDER', 'LLM_MODEL', 'AZURE_RESOURCE_NAME', 'AZURE_API_KEY', 'AZURE_DEPLOYMENT', 'OPENAI_API_KEY', 'DEMO_MODE', 'OTEL_EXPORTER_OTLP_ENDPOINT', 'CORS_ORIGIN', 'SHUTDOWN_DEADLINE_MS'];

export type Running = { child: ChildProcess; port: number; output: () => string; exited: Promise<{ code: number | null; signal: NodeJS.Signals | null; ms: number }> };

export async function startApp(appDir: 'api' | 'fake-psp', env: Record<string, string>): Promise<Running> {
  const port = await freePort();
  const cwd = fileURLToPath(new URL(`../../${appDir}/`, import.meta.url));
  const clean = Object.fromEntries(CLEARED.map((k) => [k, '']));
  const child = spawn(process.execPath, documentedArgs(`../../${appDir}`), { cwd, env: { ...process.env, ...clean, PORT: String(port), ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout!.on('data', (d) => (out += d));
  child.stderr!.on('data', (d) => (out += d));
  let killedAt = 0;
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null; ms: number }>((resolve) => child.on('exit', (code, signal) => resolve({ code, signal, ms: Date.now() - killedAt })));
  const running: Running = { child, port, output: () => out, exited };
  (child as ChildProcess & { markSignalled?: () => void }).markSignalled = () => { killedAt = Date.now(); };
  return running;
}

export const signal = (r: Running, sig: NodeJS.Signals) => {
  (r.child as ChildProcess & { markSignalled?: () => void }).markSignalled?.();
  r.child.kill(sig);
};

export async function waitReady(r: Running, timeoutMs = 20_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (r.child.exitCode !== null) throw new Error(`process exited early (${r.child.exitCode}):\n${r.output()}`);
    try { if ((await fetch(`http://127.0.0.1:${r.port}/health`)).ok) return; } catch { /* not up yet */ }
    await new Promise((res) => setTimeout(res, 100));
  }
  throw new Error(`not ready in ${timeoutMs} ms:\n${r.output()}`);
}

export const stop = async (r: Running) => { if (r.child.exitCode === null) { r.child.kill('SIGKILL'); await r.exited; } };

// A connection with a request that never finishes: headers sent, the promised body never arrives. The server
// has a request in flight, so closing it cannot finish until this ends or the shutdown deadline does.
export const unfinishedRequest = (port: number) => new Promise<Socket>((resolve, reject) => {
  const sock = connect(port, '127.0.0.1', () => {
    sock.write('POST /nothing HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{');
    setTimeout(() => resolve(sock), 150);
  });
  sock.on('error', () => {});
  sock.once('error', reject);
});
