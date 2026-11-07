import Fastify from 'fastify';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { createSchema, integerString, quantitySchema, type Role } from '../shared/schema.ts';
import {
  Ledger,
  DomainError,
  create,
  accept,
  fund,
  deliver,
  reserve,
  finalize,
  find,
  addExtraction,
} from './ledger.ts';
import { extract, sampleDocument } from './extraction.ts';
import { registerChain } from './chain.ts';

const roles = ['buyer', 'supplier', 'receiver', 'operator'] as const;
export function buildApp(ledger: Ledger, { worker = true }: { worker?: boolean } = {}) {
  const app = Fastify({ logger: false, bodyLimit: 40_000 });
  app.register(async (child) => registerChain(child, ledger, { worker }));
  // Loopback-only simulation API. Actor switching is a demo aid, never wallet authentication.
  app.addHook('onRequest', async (req, reply) => {
    const host = req.headers.host ?? '';
    if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host))
      return reply.code(403).send({ error: 'Local simulation accepts loopback hosts only.' });
    const origin = req.headers.origin;
    if (origin && !/^http:\/\/(127\.0\.0\.1|localhost):(5173|5174|3001|3002)$/.test(origin))
      return reply.code(403).send({ error: 'Cross-origin requests are not allowed.' });
    reply.header('Cache-Control', 'no-store');
  });
  app.setErrorHandler((error, _req, reply) => {
    if (error instanceof DomainError)
      return reply.code(error.status).send({ error: error.message });
    if (error instanceof z.ZodError)
      return reply
        .code(400)
        .send({ error: error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') });
    app.log.error(error);
    return reply
      .code(500)
      .send({ error: 'The action could not be completed. Refresh and inspect the current state.' });
  });
  function actor(headers: Record<string, unknown>): Role {
    const role = z.enum(roles).parse(headers['x-demo-role']);
    return role;
  }
  app.get('/api/health', async () => ({ ok: true, environment: 'local-simulation' }));
  app.get('/api/state', async () => ({
    ...ledger.read(),
    environment: 'local-simulation',
    liveAiAvailable: !!process.env.NEAR_AI_API_KEY,
    chain: { network: 'testnet', contract: null, status: 'not-deployed' },
  }));
  app.get<{ Params: { id: string } }>('/api/orders/:id/sample', async (req) => ({
    text: sampleDocument(find(ledger.read(), req.params.id)),
  }));
  app.post('/api/orders', async (req, reply) => {
    const body = createSchema.parse(req.body),
      role = actor(req.headers);
    const order = ledger.write((s) => create(s, body, role));
    return reply.code(201).send(order);
  });
  app.post<{ Params: { id: string } }>('/api/orders/:id/accept', async (req) => {
    const role = actor(req.headers);
    const body = z.strictObject({ termsHash: z.string().length(64) }).parse(req.body);
    ledger.write((s) => accept(s, req.params.id, role, body.termsHash));
    return { ok: true };
  });
  app.post<{ Params: { id: string } }>('/api/orders/:id/fund', async (req) => {
    const role = actor(req.headers);
    const body = z.strictObject({ amount: integerString }).parse(req.body);
    ledger.write((s) => fund(s, req.params.id, role, body.amount));
    return { ok: true };
  });
  app.post<{ Params: { id: string } }>('/api/orders/:id/delivery', async (req) => {
    const role = actor(req.headers);
    const body = z
      .strictObject({ sequence: quantitySchema, total: quantitySchema })
      .parse(req.body);
    ledger.write((s) => deliver(s, req.params.id, role, body.sequence, body.total));
    return { ok: true };
  });
  app.post<{ Params: { id: string } }>('/api/orders/:id/extract', async (req) => {
    if (actor(req.headers) !== 'operator')
      throw new DomainError('Only the operator can extract invoices in this demo.', 403);
    const body = z
      .strictObject({ text: z.string().min(1).max(32768), mode: z.enum(['sample', 'live']) })
      .parse(req.body);
    const extraction = await extract(find(ledger.read(), req.params.id), body.text, body.mode);
    ledger.write((s) => addExtraction(s, extraction));
    return extraction;
  });
  app.post<{ Params: { id: string } }>('/api/orders/:id/payments', async (req) => {
    const role = actor(req.headers);
    const body = z
      .strictObject({
        requestId: z.string().uuid(),
        quantity: quantitySchema,
        extractionId: z.string().uuid(),
      })
      .parse(req.body);
    return ledger.write((s) => {
      const extraction = s.extractions.find(
        (e) => e.id === body.extractionId && e.orderId === req.params.id,
      );
      if (!extraction) throw new DomainError('Extract an invoice for this order first.', 400);
      if (body.quantity > extraction.invoice.quantity)
        throw new DomainError('Requested quantity exceeds the extracted invoice.');
      return reserve(
        s,
        req.params.id,
        role,
        body.requestId,
        body.quantity,
        extraction.documentHash,
      );
    });
  });
  app.post('/api/demo/seed', async (req, reply) => {
    actor(req.headers);
    if (ledger.read().orders.length)
      throw new DomainError('A workspace already exists. Existing records were preserved.');
    const o = ledger.write((s) => {
      const o = create(
        s,
        {
          supplierName: 'Meridian Supply Co.',
          supplier: 'meridian.testnet',
          receiver: 'warehouse.testnet',
          operator: 'operator.testnet',
          payout: 'meridian.testnet',
          description: 'Premium packing cartons',
          ordered: 100,
          unitPrice: '10000000',
        },
        'buyer',
      );
      accept(s, o.id, 'supplier', o.termsHash);
      fund(s, o.id, 'buyer', '1000000000');
      deliver(s, o.id, 'receiver', 1, 40);
      return o;
    });
    return reply.code(201).send(o);
  });
  app.post('/api/demo/attack', async (req) => {
    actor(req.headers);
    const body = z
      .strictObject({
        orderId: z.string(),
        kind: z.enum(['excess', 'replay', 'redirection', 'unauthorized']),
      })
      .parse(req.body);
    // Run each probe in a rollback-only transaction. This is an API/simulation proof, not a deployed-contract receipt.
    try {
      ledger.db.exec('BEGIN IMMEDIATE');
      const s = ledger.read();
      const o = find(s, body.orderId);
      if (body.kind === 'redirection')
        z.strictObject({ orderId: z.string(), quantity: quantitySchema }).parse({
          orderId: o.id,
          quantity: 1,
          recipient: 'attacker.testnet',
        });
      else if (body.kind === 'unauthorized')
        deliver(s, o.id, 'operator', o.sequence + 1, Math.min(o.ordered, o.accepted + 1));
      else if (body.kind === 'replay') {
        const existing = s.attempts.find((a) => a.orderId === o.id);
        const id = existing?.id ?? randomUUID();
        if (!existing) reserve(s, o.id, 'operator', id, 1, 'a'.repeat(64));
        reserve(s, o.id, 'operator', id, 1, 'a'.repeat(64));
      } else reserve(s, o.id, 'operator', randomUUID(), o.ordered + 1, 'a'.repeat(64));
      return {
        blocked: false,
        reason: 'Probe was not blocked. Investigate before release.',
        proof: 'local-simulation',
      };
    } catch (e) {
      return {
        blocked: true,
        reason:
          e instanceof z.ZodError
            ? 'Recipient is not an accepted request field. Payout is fixed by the order.'
            : (e as Error).message,
        proof: 'local-simulation',
      };
    } finally {
      ledger.db.exec('ROLLBACK');
    }
  });
  let timer: NodeJS.Timeout | undefined;
  if (worker)
    timer = setInterval(() => {
      const pending = ledger
        .read()
        .attempts.filter((a) => a.status === 'reserved' || a.status === 'processing');
      if (!pending.length) return;
      ledger.write((s) => {
        for (const a of s.attempts) {
          if (a.status === 'reserved') {
            a.status = 'processing';
            a.updatedAt = new Date().toISOString();
          } else if (a.status === 'processing') finalize(s, a.id, 'success');
        }
      });
    }, 1800);
  app.addHook('onClose', async () => {
    if (timer) clearInterval(timer);
  });
  return app;
}
