import { buildFakePsp } from './app.js';
import { createShutdown, installSignalHandlers, telemetryStage } from './shutdown.js';

const port = Number(process.env.PORT ?? 4010);
const app = buildFakePsp();
await app.listen({ port, host: '0.0.0.0' });
console.log(`fake-psp listening on :${port}`);

const shutdownMs = process.env.SHUTDOWN_DEADLINE_MS ? Number(process.env.SHUTDOWN_DEADLINE_MS) : undefined;
installSignalHandlers(createShutdown({ deadlineMs: shutdownMs, stages: [{ name: 'server', run: () => app.close() }, telemetryStage()] }));
