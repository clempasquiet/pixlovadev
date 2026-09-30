import { buildInternalApp, buildPublicApp } from './app.js';
import { loadConfig } from './config.js';

const config = loadConfig();
const publicApp = buildPublicApp({ logger: true });
const internalApp = buildInternalApp({ logger: true });

async function shutdown(signal: string): Promise<void> {
  publicApp.log.info({ signal }, 'arrêt demandé');
  await Promise.allSettled([publicApp.close(), internalApp.close()]);
  process.exit(0);
}
process.once('SIGTERM', () => void shutdown('SIGTERM'));
process.once('SIGINT', () => void shutdown('SIGINT'));

await internalApp.listen(config.internal);
await publicApp.listen(config.public);
