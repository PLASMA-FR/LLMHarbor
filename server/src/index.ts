import './env.js';
import { createApp } from './app.js';
import { initDb } from './db/index.js';
import { startHealthChecker } from './services/health.js';

const PORT = Number(process.env.PORT ?? 3001);
const HOST = process.env.HOST ?? '127.0.0.1';

if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  throw new Error(`PORT must be an integer between 1 and 65535; received ${process.env.PORT ?? PORT}`);
}

async function main() {
  initDb();
  const app = createApp();

  app.listen(Number(PORT), HOST, () => {
    const displayHost = HOST === '0.0.0.0' ? 'localhost' : HOST;
    console.log(`Server running on http://${displayHost}:${PORT}`);
    console.log(`Proxy endpoint: http://${displayHost}:${PORT}/v1/chat/completions`);
    if (HOST === '0.0.0.0' || HOST === '::') {
      console.warn('Warning: LLMHarbor is listening on all interfaces. Only do this behind your own network controls.');
    }
    startHealthChecker();
  });
}

main().catch(console.error);
