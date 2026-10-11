import { buildFakePsp } from './app.js';

const port = Number(process.env.PORT ?? 4010);
await buildFakePsp().listen({ port, host: '0.0.0.0' });
console.log(`fake-psp listening on :${port}`);
