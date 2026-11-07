import { readFile } from 'node:fs/promises';
import {
  Account,
  JsonRpcProvider,
  KeyPairSigner,
  actions,
  baseEncode,
  type KeyPairString,
} from 'near-api-js';
import { verifyMessage } from 'near-api-js/nep413';
import { randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type {
  Deployment,
  ChainOrder,
  ChainAttempt,
  ChainState,
  ChainRecovery,
} from '../shared/chain.ts';
import { ordersForAccount } from '../shared/chain.ts';
import { accountSchema, type Order } from '../shared/schema.ts';
import { Ledger, DomainError } from './ledger.ts';
import { extract } from './extraction.ts';
import type { InvoiceAuthorizer } from './sessions.ts';

type KeyFile = { accountId: string; secretKey: KeyPairString; publicKey: string };
type Job = {
  vault?: string;
  network?: string;
  id: string;
  orderId: string;
  quantity: string;
  auditHash: string;
  status: 'queued' | 'submitting' | 'settled' | 'failed' | 'unresolved';
  transactionHash: string | null;
  error: string | null;
  createdAt: string;
};
const requestSchema = z.strictObject({
  orderId: z.string().min(1).max(64),
  quantity: z.string().regex(/^[1-9]\d{0,18}$/),
  auditHash: z.string().regex(/^[a-f0-9]{64}$/),
});
const provider = new JsonRpcProvider({ url: 'https://test.rpc.fastnear.com' });
const recipient = 'Accord testnet operator';
export async function deployment(): Promise<Deployment | null> {
  try {
    const d = JSON.parse(
      await readFile(process.env.ACCORD_DEPLOYMENT_PATH || '.data/deployment.json', 'utf8'),
    ) as Deployment;
    if (
      d.network !== 'testnet' ||
      !accountSchema.safeParse(d.vault).success ||
      !accountSchema.safeParse(d.token).success
    )
      throw new Error('Invalid testnet deployment.');
    return d;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
}
export function asPreviewOrder(o: ChainOrder): Order {
  return {
    id: o.id,
    buyer: o.buyer,
    supplierName: o.terms.supplier,
    supplier: o.terms.supplier,
    receiver: o.terms.receiver,
    operator: o.terms.operator,
    payout: o.terms.payout,
    description: o.terms.description,
    ordered: Number(o.terms.ordered),
    unitPrice: o.terms.unit_price,
    lineId: o.terms.line_id,
    token: 'aUSD',
    termsHash: o.terms_hash,
    acceptedTerms: o.accepted_terms,
    funded: o.funded,
    accepted: Number(o.accepted),
    paid: Number(o.paid),
    pending: Number(o.pending),
    sequence: Number(o.sequence),
    createdAt: new Date().toISOString(),
  };
}
async function view<T>(d: Deployment, method: string, args: Record<string, unknown>) {
  return provider.callFunction({ contractId: d.vault, method, args }) as Promise<T>;
}
async function requiredDeployment() {
  const d = await deployment();
  if (!d) throw new DomainError('Testnet deployment has not been configured.', 503);
  return d;
}
async function operatorKey(d: Deployment) {
  const key = JSON.parse(
    await readFile(process.env.ACCORD_OPERATOR_KEY_PATH || '.data/operator-key.json', 'utf8'),
  ) as KeyFile;
  if (key.accountId !== d.operator)
    throw new DomainError('Operator account does not match deployment.', 503);
  const onchain = await provider.viewAccessKey({
    accountId: key.accountId,
    publicKey: key.publicKey,
  });
  if (
    onchain.permission === 'FullAccess' ||
    !('FunctionCall' in onchain.permission) ||
    onchain.permission.FunctionCall.receiver_id !== d.vault ||
    onchain.permission.FunctionCall.method_names.length !== 1 ||
    onchain.permission.FunctionCall.method_names[0] !== 'request_payment'
  )
    throw new DomainError('Operator key is not narrowly scoped.', 503);
  return key;
}
export async function registerChain(
  app: FastifyInstance,
  ledger: Ledger,
  {
    worker = true,
    authRequired = false,
    authorizeInvoice,
  }: { worker?: boolean; authRequired?: boolean; authorizeInvoice?: InvoiceAuthorizer } = {},
) {
  ledger.db.exec(
    `CREATE TABLE IF NOT EXISTS chain_jobs (id TEXT PRIMARY KEY,payload TEXT NOT NULL); CREATE TABLE IF NOT EXISTS chain_challenges (id TEXT PRIMARY KEY,payload TEXT NOT NULL,used INTEGER NOT NULL DEFAULT 0,expires INTEGER NOT NULL);`,
  );
  app.get<{ Querystring: { account?: string } }>(
    '/api/chain/state',
    async (req): Promise<ChainState> => {
      const d = await deployment();
      if (!d)
        return {
          configured: false,
          deployment: null,
          orders: [],
          attempts: [],
          operatorReady: false,
          liveAiAvailable: !!process.env.NEAR_AI_API_KEY,
        };
      const account = accountSchema.safeParse(req.query.account);
      const orders = account.success
        ? ordersForAccount(
            (await view<ChainOrder[]>(d, 'list_orders', { limit: 50 })) ?? [],
            account.data,
          )
        : [];
      const recoveries = d.features?.includes('recovery-v1')
        ? Object.fromEntries(
            await Promise.all(
              orders.map(async (order) => [
                order.id,
                await view<ChainRecovery>(d, 'get_recovery', { order_id: order.id }),
              ]),
            ),
          )
        : undefined;
      const jobs = (
        ledger.db.prepare('SELECT payload FROM chain_jobs').all() as { payload: string }[]
      ).map((row) => JSON.parse(row.payload) as Job);
      const ids = [...new Set([...(d.trackedRequestIds ?? []), ...jobs.map((j) => j.id)])];
      const attempts = (
        await Promise.all(
          ids
            .slice(-100)
            .map((id) => view<ChainAttempt | null>(d, 'get_attempt', { request_id: id })),
        )
      ).filter((v): v is ChainAttempt => !!v && orders.some((o) => o.id === v.order_id));
      let operatorReady = false;
      try {
        await operatorKey(d);
        operatorReady = true;
      } catch {
        /* read-only mode remains available */
      }
      return {
        configured: true,
        deployment: d,
        orders,
        attempts,
        recoveries,
        operatorReady,
        liveAiAvailable: !!process.env.NEAR_AI_API_KEY,
        authRequired,
      };
    },
  );
  app.get('/api/chain/jobs', async () => ({
    jobs: (ledger.db.prepare('SELECT payload FROM chain_jobs').all() as { payload: string }[]).map(
      (row) => JSON.parse(row.payload),
    ),
  }));
  app.post<{ Params: { id: string } }>('/api/chain/orders/:id/extract', async (req) => {
    const d = await requiredDeployment();
    const order = await view<ChainOrder | null>(d, 'get_order', { order_id: req.params.id });
    if (!order) throw new DomainError('Order not found.', 404);
    const body = z
      .strictObject({ text: z.string().min(1).max(32768), mode: z.enum(['sample', 'live']) })
      .parse(req.body);
    if (authRequired && body.mode !== 'live')
      throw new DomainError('Use live invoice processing.', 400);
    if (authorizeInvoice) await authorizeInvoice(req, order);
    return extract(asPreviewOrder(order), body.text, body.mode);
  });
  app.post('/api/chain/challenge', async (req) => {
    const d = await requiredDeployment();
    await operatorKey(d);
    const body = requestSchema.parse(req.body);
    const order = await view<ChainOrder | null>(d, 'get_order', { order_id: body.orderId });
    if (!order) throw new DomainError('Order not found.', 404);
    if (d.features?.includes('recovery-v1')) {
      const recovery = await view<ChainRecovery>(d, 'get_recovery', { order_id: order.id });
      if (recovery.phase !== 'Open') throw new DomainError('This order is closing or closed.', 409);
    }
    if (order.terms.operator !== d.operator)
      throw new DomainError('This order uses a different operator.', 403);
    const capacity = BigInt(order.accepted) - BigInt(order.paid) - BigInt(order.pending);
    if (BigInt(body.quantity) > capacity)
      throw new DomainError('Quantity exceeds current contract capacity.');
    const id = randomUUID(),
      nonce = randomBytes(32).toString('base64'),
      expires = Date.now() + 300_000;
    ledger.db.prepare('DELETE FROM chain_challenges WHERE expires<?').run(Date.now());
    const message = JSON.stringify({
      application: 'Accord',
      network: 'testnet',
      vault: d.vault,
      requestId: id,
      ...body,
      expires,
    });
    const payload = { id, nonce, message, recipient, request: body, operator: d.operator };
    ledger.db
      .prepare('INSERT INTO chain_challenges (id,payload,expires) VALUES (?,?,?)')
      .run(id, JSON.stringify(payload), expires);
    return { id, nonce, message, recipient, expires, accountId: d.operator };
  });
  app.post('/api/chain/submit', async (req) => {
    const d = await requiredDeployment();
    const body = z
      .strictObject({
        challengeId: z.string().uuid(),
        accountId: accountSchema,
        publicKey: z.string().max(200),
        signature: z.string().max(256),
      })
      .parse(req.body);
    const row = ledger.db
      .prepare('SELECT payload,used,expires FROM chain_challenges WHERE id=?')
      .get(body.challengeId) as { payload: string; used: number; expires: number } | undefined;
    if (!row || row.used || row.expires < Date.now())
      throw new DomainError('Challenge expired or already consumed.');
    const challenge = JSON.parse(row.payload) as {
      nonce: string;
      message: string;
      request: z.infer<typeof requestSchema>;
      operator: string;
    };
    const bound = JSON.parse(challenge.message) as { vault?: string; network?: string };
    if (bound.vault !== d.vault || bound.network !== d.network)
      throw new DomainError('The deployment changed. Authorize a fresh payment request.', 409);
    if (body.accountId !== challenge.operator || body.accountId !== d.operator)
      throw new DomainError('Only the designated operator can authorize this request.', 403);
    try {
      await verifyMessage({
        signerAccountId: body.accountId,
        signerPublicKey: body.publicKey,
        payload: {
          message: challenge.message,
          nonce: Buffer.from(challenge.nonce, 'base64'),
          recipient,
        },
        signature: Buffer.from(body.signature, 'base64'),
        provider,
      });
    } catch {
      throw new DomainError('Wallet signature or account ownership could not be verified.', 403);
    }
    const job: Job = {
      vault: d.vault,
      network: d.network,
      id: body.challengeId,
      orderId: challenge.request.orderId,
      quantity: challenge.request.quantity,
      auditHash: challenge.request.auditHash,
      status: 'queued',
      transactionHash: null,
      error: null,
      createdAt: new Date().toISOString(),
    };
    ledger.db.exec('BEGIN IMMEDIATE');
    try {
      const consumed = ledger.db
        .prepare('UPDATE chain_challenges SET used=1 WHERE id=? AND used=0 AND expires>=?')
        .run(body.challengeId, Date.now());
      if (Number(consumed.changes) !== 1) throw new DomainError('Challenge already consumed.');
      ledger.db
        .prepare('INSERT INTO chain_jobs (id,payload) VALUES (?,?)')
        .run(job.id, JSON.stringify(job));
      ledger.db.exec('COMMIT');
    } catch (e) {
      ledger.db.exec('ROLLBACK');
      throw e;
    }
    return job;
  });
  let inFlight = false;
  const save = (job: Job) =>
    ledger.db
      .prepare('UPDATE chain_jobs SET payload=? WHERE id=?')
      .run(JSON.stringify(job), job.id);
  async function tick() {
    if (inFlight) return;
    inFlight = true;
    try {
      const d = await deployment();
      if (!d) return;
      const jobs = (
        ledger.db.prepare('SELECT payload FROM chain_jobs').all() as { payload: string }[]
      )
        .map((row) => JSON.parse(row.payload) as Job)
        .filter(
          (job) =>
            job.status === 'queued' || job.status === 'submitting' || job.status === 'unresolved',
        );
      for (const job of jobs) {
        if (job.vault !== d.vault || job.network !== d.network) {
          job.status = 'unresolved';
          job.error = 'This request requires authorization for the current deployment.';
          save(job);
          continue;
        }
        const attempt = await view<ChainAttempt | null>(d, 'get_attempt', { request_id: job.id });
        if (attempt) {
          job.status =
            attempt.status === 'Settled' || attempt.status === 'ReceiptAcknowledged'
              ? 'settled'
              : attempt.status === 'TransferFailed'
                ? 'failed'
                : 'unresolved';
          if (job.status === 'settled' || job.status === 'failed') job.error = null;
          save(job);
          continue;
        }
        // A submitting job without visible state may be in flight. Never sign it again blindly.
        if (job.status !== 'queued') {
          job.status = 'unresolved';
          if (job.transactionHash) {
            try {
              const status = await provider.viewTransactionStatus({
                txHash: job.transactionHash,
                accountId: d.operator,
                waitUntil: 'FINAL',
              });
              if (typeof status.status === 'object' && 'Failure' in status.status) {
                job.status = 'failed';
                job.error = 'The contract rejected this request.';
              }
            } catch {
              /* retain the unresolved record while the provider is unavailable */
            }
          }
          save(job);
          continue;
        }
        const key = await operatorKey(d);
        const signer = KeyPairSigner.fromSecretKey(key.secretKey);
        const account = new Account(key.accountId, provider, signer);
        const transaction = await account.createTransaction({
          receiverId: d.vault,
          publicKey: key.publicKey,
          actions: [
            actions.functionCall(
              'request_payment',
              {
                order_id: job.orderId,
                request_id: job.id,
                quantity: job.quantity,
                audit_hash: job.auditHash,
              },
              150_000_000_000_000n,
              0n,
            ),
          ],
        });
        const signed = await signer.signTransaction(transaction);
        job.status = 'submitting';
        job.transactionHash = baseEncode(signed.txHash);
        save(job);
        try {
          await provider.sendTransactionUntil(signed.signedTransaction, 'FINAL');
          const outcome = await view<ChainAttempt | null>(d, 'get_attempt', { request_id: job.id });
          job.status =
            outcome?.status === 'Settled' || outcome?.status === 'ReceiptAcknowledged'
              ? 'settled'
              : outcome?.status === 'TransferFailed'
                ? 'failed'
                : 'unresolved';
          if (job.status === 'settled' || job.status === 'failed') job.error = null;
          save(job);
        } catch {
          job.status = 'unresolved';
          job.error =
            'Submission outcome requires receipt reconciliation. No blind retry was made.';
          save(job);
        }
      }
    } catch {
      /* Provider outage leaves durable jobs unchanged for the next read. */
    } finally {
      inFlight = false;
    }
  }
  const timer = worker ? setInterval(() => void tick(), 3000) : undefined;
  app.addHook('onClose', async () => {
    if (timer) clearInterval(timer);
  });
}
