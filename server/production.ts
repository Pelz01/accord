import Fastify from 'fastify';
import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { Ledger, DomainError } from './ledger.ts';
import { registerChain } from './chain.ts';
import { WalletSessions } from './sessions.ts';

export function productionApp(
  ledger: Ledger,
  { origin, proxySecret, worker = true }: { origin: string; proxySecret: string; worker?: boolean },
) {
  const parsed = new URL(origin);
  if (
    parsed.protocol !== 'https:' ||
    parsed.origin !== origin ||
    parsed.username ||
    parsed.password
  )
    throw new Error('Set an HTTPS frontend origin.');
  if (proxySecret.length < 32) throw new Error('A strong proxy secret is required.');
  const app = Fastify({ logger: false, bodyLimit: 40000 });
  const sessions = new WalletSessions(ledger.db, origin);
  let windowStart = Date.now(),
    writes = 0;
  app.addHook('onRequest', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    reply.header('X-Content-Type-Options', 'nosniff');
    const secret = request.headers['x-accord-proxy-secret'];
    if (
      typeof secret !== 'string' ||
      Buffer.byteLength(secret) !== Buffer.byteLength(proxySecret) ||
      !timingSafeEqual(Buffer.from(secret), Buffer.from(proxySecret))
    )
      return reply.code(403).send({ error: 'This request is not permitted.' });
    if (request.headers.origin && request.headers.origin !== origin)
      return reply.code(403).send({ error: 'This website is not authorized.' });
    if (request.method !== 'GET') {
      if (Date.now() - windowStart >= 60000) {
        windowStart = Date.now();
        writes = 0;
      }
      if (++writes > 120)
        return reply.code(429).send({ error: 'Too many requests. Please try again shortly.' });
    }
    if (
      request.method === 'POST' &&
      /^\/api\/chain\/orders\/[^/]+\/extract(?:\?|$)/.test(request.url)
    )
      sessions.account(request.headers.authorization);
  });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof DomainError)
      return reply.code(error.status).send({ error: error.message });
    if (error instanceof z.ZodError)
      return reply.code(400).send({ error: 'Please check the request details.' });
    return reply
      .code(503)
      .send({ error: 'The action could not be completed. Please try again shortly.' });
  });
  app.get('/api/health', async () => ({ ok: true, network: 'testnet' }));
  sessions.register(app);
  app.register(async (child) =>
    registerChain(child, ledger, {
      worker,
      authRequired: true,
      authorizeInvoice: (request, order) =>
        sessions.authorizeInvoice(request.headers.authorization, order),
    }),
  );
  return app;
}
