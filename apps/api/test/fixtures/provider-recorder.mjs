// TEST-ONLY. Loaded into a server process with `node --import`. It records every request the process makes to a model
// provider host (Azure OpenAI or api.openai.com) in PROVIDER_RECORDER_FILE, and answers it with a 500 so nothing
// leaves the machine. Used to PROVE that a code path made zero provider calls, rather than assume it. No key is logged.
import { appendFileSync } from 'node:fs';

const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = String(input instanceof Request ? input.url : input);
  if (/\.openai\.azure\.com|api\.openai\.com/.test(url)) {
    appendFileSync(process.env.PROVIDER_RECORDER_FILE, `${JSON.stringify({ host: new URL(url).host.replace(/^[^.]+\./, '<resource>.'), method: init?.method ?? 'GET' })}\n`);
    return new Response(JSON.stringify({ error: { message: 'recorded, not sent', code: 'recorder' } }), { status: 500, headers: { 'content-type': 'application/json' } });
  }
  return realFetch(input, init);
};
