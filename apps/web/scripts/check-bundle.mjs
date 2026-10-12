// Builds the web client twice into temporary folders and searches the output:
//   VITE_DEMO_LOGIN unset  ->  the demo accounts and their password must NOT be in the bundle
//   VITE_DEMO_LOGIN=1      ->  they must be there (so the first check cannot pass by looking for the wrong thing)
// The environment is rebuilt from scratch for each build: any VITE_* variable in the caller's shell is
// dropped, so a developer's setting cannot change the result. Run with: pnpm --filter @tadka/web check:bundle
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const webDir = fileURLToPath(new URL('..', import.meta.url));
const viteBin = join(createRequire(import.meta.url).resolve('vite/package.json'), '..', 'bin', 'vite.js');
const SECRETS = ['Password123!', 'rahul@tadka.test', 'aman@tadka.test'];

const files = (dir) => readdirSync(dir).flatMap((f) => { const p = join(dir, f); return statSync(p).isDirectory() ? files(p) : [p]; });

function build(extraEnv) {
  const out = mkdtempSync(join(tmpdir(), 'tadka-web-'));
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('VITE_')));
  const r = spawnSync(process.execPath, [viteBin, 'build', '--mode', 'production', '--outDir', out, '--emptyOutDir', '--logLevel', 'warn'], { cwd: webDir, env: { ...env, ...extraEnv }, encoding: 'utf8' });
  if (r.status !== 0) { console.error(r.stdout, r.stderr); rmSync(out, { recursive: true, force: true }); throw new Error('vite build failed'); }
  const all = files(out);
  if (!all.some((f) => f.endsWith('index.html')) || !all.some((f) => f.endsWith('.js'))) throw new Error('the build produced no index.html or no JavaScript');
  const text = all.map((f) => readFileSync(f, 'utf8')).join('\n');
  rmSync(out, { recursive: true, force: true });
  return text;
}

let failed = false;
const off = build({});
for (const s of SECRETS) if (off.includes(s)) { console.error(`FAIL: "${s}" is in the bundle built WITHOUT VITE_DEMO_LOGIN`); failed = true; }
const on = build({ VITE_DEMO_LOGIN: '1' });
for (const s of SECRETS) if (!on.includes(s)) { console.error(`FAIL: "${s}" is missing from the bundle built WITH VITE_DEMO_LOGIN=1 (the check would prove nothing)`); failed = true; }
if (failed) process.exit(1);
console.log('bundle check ok: demo credentials absent without VITE_DEMO_LOGIN, present with VITE_DEMO_LOGIN=1');
