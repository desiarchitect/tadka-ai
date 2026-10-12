// Builds the web client twice into temporary folders and searches the output:
//   nothing set            ->  no demo accounts, and no localhost API address, in the bundle
//   VITE_DEMO_LOGIN=1      ->  the demo accounts must be there (so the first check cannot pass by looking for the wrong thing)
//   VITE_API_URL=...       ->  that address is used, and still no localhost default
// and no server-side setting name in any of them.
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
const fail = (msg) => { console.error(`FAIL: ${msg}`); failed = true; };
const LOCAL_DEFAULT = 'localhost:3000';
const API = 'https://api.example.test';

// 1. A production build with nothing set: no demo accounts, and no silent localhost API address.
const off = build({});
for (const s of SECRETS) if (off.includes(s)) fail(`"${s}" is in the bundle built WITHOUT VITE_DEMO_LOGIN`);
if (off.includes(LOCAL_DEFAULT)) fail(`"${LOCAL_DEFAULT}" is in a production bundle built WITHOUT VITE_API_URL (it would silently point visitors at their own machine)`);
// 2. With the demo sign-in switched on, the accounts are there (so check 1 cannot pass by looking for the wrong thing).
const on = build({ VITE_DEMO_LOGIN: '1' });
for (const s of SECRETS) if (!on.includes(s)) fail(`"${s}" is missing from the bundle built WITH VITE_DEMO_LOGIN=1 (the check would prove nothing)`);
// 3. A production build with VITE_API_URL uses it, and still has no localhost default.
const withUrl = build({ VITE_API_URL: API });
if (!withUrl.includes(API)) fail(`the VITE_API_URL value is missing from the bundle built WITH VITE_API_URL`);
if (withUrl.includes(LOCAL_DEFAULT)) fail(`"${LOCAL_DEFAULT}" is in the bundle built WITH VITE_API_URL`);
// 4. Nothing server-side reaches any bundle.
for (const [name, text] of [['off', off], ['on', on], ['url', withUrl]]) for (const bad of ['AZURE_API_KEY', 'OPENAI_API_KEY', 'JWT_PRIVATE_JWK', 'DATABASE_URL', 'tadka_local']) if (text.includes(bad)) fail(`"${bad}" is in the "${name}" bundle`);
if (failed) process.exit(1);
console.log('bundle check ok: no demo accounts and no localhost API address without the flags; both present only when asked for; no server settings');
