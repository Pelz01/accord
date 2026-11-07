import 'dotenv/config';
import { Ledger } from './ledger.ts';
import { productionApp } from './production.ts';
process.umask(0o077);

const origin = process.env.ACCORD_FRONTEND_ORIGIN,
  proxySecret = process.env.ACCORD_PROXY_SECRET;
if (!origin || !proxySecret)
  throw new Error('Production origin and proxy secret must be configured.');
const ledger = new Ledger(process.env.ACCORD_DATA_PATH || '/data/accord.sqlite');
const app = productionApp(ledger, { origin, proxySecret });
await app.listen({ host: process.env.HOST || '127.0.0.1', port: Number(process.env.PORT || 3001) });
console.log('Accord API is ready.');
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.on(signal, async () => {
    await app.close();
    ledger.close();
    process.exit(0);
  });
