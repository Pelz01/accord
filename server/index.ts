import 'dotenv/config';
import { Ledger } from './ledger.ts';
import { buildApp } from './app.ts';
const ledger = new Ledger(process.env.ACCORD_DATA_PATH || '.data/accord.sqlite');
const app = buildApp(ledger);
await app.listen({ port: Number(process.env.PORT) || 3001, host: '127.0.0.1' });
console.log('Accord local simulation API: http://127.0.0.1:3001');
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.on(signal, async () => {
    await app.close();
    ledger.close();
    process.exit(0);
  });
