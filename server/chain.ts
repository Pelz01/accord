import { readFile } from 'node:fs/promises';
import { Account, KeyPairSigner, actions, type KeyPairString } from 'near-api-js';
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
  ChainPaymentPolicy,
  ChainNativeDeposit,
} from '../shared/chain.ts';
import { ordersForAccount } from '../shared/chain.ts';
import { accountSchema, type Order } from '../shared/schema.ts';
import { Ledger, DomainError } from './ledger.ts';
import { extract } from './extraction.ts';
import type { InvoiceAuthorizer } from './sessions.ts';
import { InvoiceFiles } from './documents.ts';
import { RpcReadCache } from './read-cache.ts';
import { automaticPaymentJob } from './automatic-payments.ts';
import { FinalizedRpcProvider } from './rpc.ts';
import { assertOperatorPolicy } from './operator-policy.ts';
import { IntentsFunding } from './intents.ts';
import {
  assertDeploymentNetwork,
  networkRPC,
  tokenSymbol,
  type Network,
} from '../shared/network.ts';
import {
  HoldPaymentError,
  paymentArguments,
  publicPaymentJob,
  runPaymentJob,
  type StoredPaymentJob as Job,
} from './payment-worker.ts';
import {
  invoicePayload,
  invoicePayloadSchema,
  invoiceCommitment,
  type InvoiceConfirmation,
} from '../shared/invoices.ts';

type KeyFile = { accountId: string; secretKey: KeyPairString; publicKey: string };
const requestSchema = z.strictObject({
  orderId: z.string().min(1).max(64),
  quantity: z.string().regex(/^[1-9]\d{0,18}$/),
  auditHash: z.string().regex(/^[a-f0-9]{64}$/),
  invoice: invoicePayloadSchema.optional(),
});
export const runtimeNetwork: Network =
  process.env.ACCORD_NETWORK === 'mainnet' ? 'mainnet' : 'testnet';
if (process.env.ACCORD_NETWORK && !['mainnet', 'testnet'].includes(process.env.ACCORD_NETWORK))
  throw new Error('Invalid server network.');
const provider = new FinalizedRpcProvider({ url: networkRPC(runtimeNetwork) });
const displayReads = new RpcReadCache();
const recipient = `Accord ${runtimeNetwork} operator`;
export async function deployment(): Promise<Deployment | null> {
  try {
    const d = JSON.parse(
      await readFile(process.env.ACCORD_DEPLOYMENT_PATH || '.data/deployment.json', 'utf8'),
    ) as Deployment;
    if (!accountSchema.safeParse(d.vault).success || !accountSchema.safeParse(d.token).success)
      throw new Error('Invalid deployment.');
    assertDeploymentNetwork(d, runtimeNetwork);
    if (
      runtimeNetwork === 'mainnet' &&
      (!process.env.ACCORD_VAULT || d.vault !== process.env.ACCORD_VAULT)
    )
      throw new Error('Mainnet vault does not match the isolated service.');
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
    token: tokenSymbol(o.token),
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
function displayView<T>(d: Deployment, method: string, args: Record<string, unknown>) {
  return displayReads.read<T>(
    JSON.stringify([d.network, d.vault, method, args]),
    () => view<T>(d, method, args),
    (value) =>
      (method === 'get_payment_policy' && (value as ChainPaymentPolicy)?.mode === 'manual') ||
      (method === 'get_attempt' &&
        ['Settled', 'ReceiptAcknowledged'].includes((value as ChainAttempt | null)?.status ?? ''))
        ? 60000
        : 5000,
  );
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
  const target = await provider.viewAccount({
    accountId: d.vault,
    blockQuery: { finality: 'final' },
  });
  try {
    assertOperatorPolicy(d, onchain.permission, target.code_hash);
    if (d.network === 'mainnet') {
      const config = await view<{
        network: string;
        token: string;
        initial_storage_allowance: string;
        incremental_storage: boolean;
      }>(d, 'get_config', {});
      if (
        config.network !== 'mainnet' ||
        config.token !== d.token ||
        config.initial_storage_allowance !== '100000000000000000000000' ||
        !config.incremental_storage
      )
        throw new Error('The mainnet contract configuration does not match the reviewed release.');
    }
  } catch (error) {
    throw new DomainError((error as Error).message, 503);
  }
  return key;
}
export async function registerChain(
  app: FastifyInstance,
  ledger: Ledger,
  {
    worker = true,
    authRequired = false,
    authorizeInvoice,
    authorizeAccess,
    authorizeWallet,
  }: {
    worker?: boolean;
    authRequired?: boolean;
    authorizeInvoice?: InvoiceAuthorizer;
    authorizeAccess?: InvoiceAuthorizer;
    authorizeWallet?: (request: Parameters<InvoiceAuthorizer>[0]) => string;
  } = {},
) {
  const files = new InvoiceFiles(ledger.db);
  const funding = new IntentsFunding(ledger.db, provider);
  async function fundingContext(request: Parameters<InvoiceAuthorizer>[0]) {
    if (!authorizeWallet) throw new DomainError('Authorize your wallet to add USDC.', 401);
    const account = authorizeWallet(request),
      d = await requiredDeployment();
    if (d.network !== 'mainnet' || !d.features?.includes('intents-funding-v1'))
      throw new DomainError('Intents funding is not available for this deployment yet.', 409);
    return { account, d };
  }
  app.get('/api/chain/intents/current', async (req) => {
    const { d, account } = await fundingContext(req);
    return funding.current(d, account);
  });
  app.post('/api/chain/intents/quote', async (req) => {
    const { d, account } = await fundingContext(req);
    const body = z.strictObject({ amountNear: z.string().min(1).max(30) }).parse(req.body);
    return funding.quote(d, account, body.amountNear);
  });
  app.get<{ Params: { id: string } }>('/api/chain/intents/:id', async (req) => {
    const { d, account } = await fundingContext(req);
    return funding.status(d, account, z.string().uuid().parse(req.params.id));
  });
  app.post<{ Params: { id: string } }>('/api/chain/intents/:id/begin', async (req) => {
    const { d, account } = await fundingContext(req);
    return funding.begin(d, account, z.string().uuid().parse(req.params.id));
  });
  app.post<{ Params: { id: string } }>('/api/chain/intents/:id/cancel', async (req) => {
    const { d, account } = await fundingContext(req);
    return funding.cancel(d, account, z.string().uuid().parse(req.params.id));
  });
  app.post<{ Params: { id: string } }>('/api/chain/intents/:id/receipt', async (req) => {
    const { d, account } = await fundingContext(req),
      body = z.strictObject({ hash: z.string().min(32).max(60) }).parse(req.body);
    return funding.record(d, account, z.string().uuid().parse(req.params.id), body.hash);
  });
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
      const listed = account.success
        ? ((await displayView<ChainOrder[]>(d, 'list_orders', { limit: 50 })) ?? [])
        : [];
      const orders = account.success ? ordersForAccount(listed, account.data) : [];
      const recoveries = d.features?.includes('recovery-v1')
        ? Object.fromEntries(
            await Promise.all(
              orders.map(async (order) => [
                order.id,
                await displayView<ChainRecovery>(d, 'get_recovery', { order_id: order.id }),
              ]),
            ),
          )
        : undefined;
      const confirmations = d.features?.includes('invoice-v1')
        ? Object.fromEntries(
            await Promise.all(
              orders.map(async (o) => [
                o.id,
                await displayView<InvoiceConfirmation[]>(d, 'list_invoices', { order_id: o.id }),
              ]),
            ),
          )
        : undefined;
      const paymentPolicies = d.features?.includes('automatic-v1')
        ? Object.fromEntries(
            await Promise.all(
              orders.map(async (o) => [
                o.id,
                await displayView<ChainPaymentPolicy>(d, 'get_payment_policy', { order_id: o.id }),
              ]),
            ),
          )
        : undefined;
      const nativeDeposits = d.features?.includes('native-deposits-v1')
        ? Object.fromEntries(
            await Promise.all(
              orders.map(async (o) => [
                o.id,
                await displayView<ChainNativeDeposit>(d, 'get_native_deposit', { order_id: o.id }),
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
            .map((id) => displayView<ChainAttempt | null>(d, 'get_attempt', { request_id: id })),
        )
      ).filter((v): v is ChainAttempt => !!v && orders.some((o) => o.id === v.order_id));
      let operatorReady = false;
      try {
        await displayReads.read(
          JSON.stringify([d.network, d.vault, d.operator, d.wasmSha256.vault, 'operator-ready']),
          () => operatorKey(d).then(() => true),
          15000,
        );
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
        confirmations,
        paymentPolicies,
        nativeDeposits,
        operatorReady,
        liveAiAvailable: !!process.env.NEAR_AI_API_KEY,
        authRequired,
        coverage: {
          ordersComplete: listed.length < 50,
          attemptsComplete:
            listed.length < 50 &&
            orders.every(
              (order) =>
                attempts.filter((attempt) => attempt.order_id === order.id).length ===
                order.attempts,
            ),
          orderLimit: 50,
        },
      };
    },
  );
  app.get('/api/chain/jobs', async () => ({
    jobs: (ledger.db.prepare('SELECT payload FROM chain_jobs').all() as { payload: string }[]).map(
      (row) => publicPaymentJob(JSON.parse(row.payload) as Job),
    ),
  }));
  app.post<{ Params: { id: string } }>('/api/chain/orders/:id/extract', async (req) => {
    const d = await requiredDeployment();
    const order = await view<ChainOrder | null>(d, 'get_order', { order_id: req.params.id });
    if (!order) throw new DomainError('Order not found.', 404);
    const body = z
      .strictObject({
        text: z.string().min(1).max(32768).optional(),
        documentId: z.string().uuid().optional(),
        mode: z.enum(['sample', 'live']),
      })
      .refine(
        (body) => Boolean(body.text) !== Boolean(body.documentId),
        'Provide text or a document.',
      )
      .parse(req.body);
    if (authRequired && body.mode !== 'live')
      throw new DomainError('Use live invoice processing.', 400);
    if (authorizeInvoice) await authorizeInvoice(req, order);
    const scope = { network: d.network, vault: d.vault, orderId: order.id };
    files.checkInvoiceCapacity(scope);
    const document = body.documentId ? files.document(scope, body.documentId) : null;
    const text = document?.text ?? body.text!;
    const extraction = await extract(asPreviewOrder(order), text, body.mode);
    if (document) extraction.documentHash = document.documentHash;
    return files.save(scope, {
      ...extraction,
      payload: invoicePayload(order, extraction),
      documentId: document?.id ?? null,
      sourceText: text,
    });
  });
  async function privateOrder(req: Parameters<InvoiceAuthorizer>[0], orderId: string) {
    if (!authorizeAccess) throw new DomainError('Wallet authorization is required.', 401);
    const d = await requiredDeployment();
    const order = await view<ChainOrder | null>(d, 'get_order', { order_id: orderId });
    if (!order) throw new DomainError('Order not found.', 404);
    await authorizeAccess(req, order);
    return { d, order, scope: { network: d.network, vault: d.vault, orderId } };
  }
  app.get<{ Params: { id: string } }>('/api/chain/orders/:id/invoices', async (req) => {
    const { scope } = await privateOrder(req, req.params.id);
    return { invoices: files.list(scope) };
  });
  app.post<{ Params: { id: string } }>('/api/chain/orders/:id/documents', async (req) => {
    const { scope, order } = await privateOrder(req, req.params.id);
    if (authorizeInvoice) await authorizeInvoice(req, order);
    return files.upload(scope, req.body);
  });
  app.get<{ Params: { id: string; documentId: string }; Querystring: { download?: string } }>(
    '/api/chain/orders/:id/documents/:documentId',
    async (req) => {
      const { scope } = await privateOrder(req, req.params.id);
      return files.document(
        scope,
        z.string().uuid().parse(req.params.documentId),
        req.query.download === '1',
      );
    },
  );
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
    if (d.features?.includes('invoice-v1')) {
      if (!body.invoice) throw new DomainError('Select a supplier-confirmed invoice.', 409);
      const commitment = await invoiceCommitment(d.network, d.vault, body.invoice);
      const confirmation = await view<InvoiceConfirmation | null>(d, 'get_invoice', { commitment });
      if (
        !confirmation ||
        confirmation.supplier !== order.terms.supplier ||
        body.invoice.order_id !== order.id ||
        body.invoice.terms_hash !== order.terms_hash ||
        body.auditHash !== body.invoice.document_hash ||
        body.invoice.token !== order.token ||
        body.invoice.line_id !== order.terms.line_id ||
        BigInt(body.quantity) > BigInt(body.invoice.quantity) ||
        BigInt(body.invoice.amount) !==
          BigInt(body.invoice.quantity) * BigInt(order.terms.unit_price)
      )
        throw new DomainError('The payment must match a supplier-confirmed invoice.', 409);
    }
    const capacity = BigInt(order.accepted) - BigInt(order.paid) - BigInt(order.pending);
    if (BigInt(body.quantity) > capacity)
      throw new DomainError('Quantity exceeds current contract capacity.');
    const id = randomUUID(),
      nonce = randomBytes(32).toString('base64'),
      expires = Date.now() + 300_000;
    ledger.db.prepare('DELETE FROM chain_challenges WHERE expires<?').run(Date.now());
    const message = JSON.stringify({
      application: 'Accord',
      network: d.network,
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
      invoice: challenge.request.invoice,
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
    return publicPaymentJob(job);
  });
  let inFlight = false;
  let scannedAt = 0;
  let scanIndex = 0;
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
      if (d.features?.includes('automatic-v1') && Date.now() - scannedAt >= 15000) {
        scannedAt = Date.now();
        const listed = await displayView<ChainOrder[]>(d, 'list_orders', {
          ...(scanIndex ? { from_index: scanIndex } : {}),
          limit: 50,
        });
        scanIndex = listed.length === 50 ? scanIndex + 50 : 0;
        for (const o of listed) {
          if (
            o.terms.operator !== d.operator ||
            !o.accepted_terms ||
            BigInt(o.accepted) <= BigInt(o.paid) + BigInt(o.pending)
          )
            continue;
          const policy = await displayView<ChainPaymentPolicy>(d, 'get_payment_policy', {
            order_id: o.id,
          });
          if (policy.mode !== 'automatic') continue;
          const recovery = await displayView<ChainRecovery>(d, 'get_recovery', { order_id: o.id });
          const invoices = await displayView<InvoiceConfirmation[]>(d, 'list_invoices', {
            order_id: o.id,
          });
          const existing = (
            ledger.db.prepare('SELECT payload FROM chain_jobs').all() as { payload: string }[]
          ).map((row) => JSON.parse(row.payload) as Job);
          const job = await automaticPaymentJob(d, o, policy, recovery, invoices, existing);
          if (job)
            ledger.db
              .prepare('INSERT OR IGNORE INTO chain_jobs (id,payload) VALUES (?,?)')
              .run(job.id, JSON.stringify(job));
        }
      }
      const jobs = (
        ledger.db.prepare('SELECT payload FROM chain_jobs').all() as { payload: string }[]
      )
        .map((row) => JSON.parse(row.payload) as Job)
        .filter(
          (job) =>
            job.status === 'queued' || job.status === 'submitting' || job.status === 'unresolved',
        );
      for (const job of jobs) {
        await runPaymentJob(d, job, {
          attempt: () => view<ChainAttempt | null>(d, 'get_attempt', { request_id: job.id }),
          transactionStatus: async () => {
            if (!job.transactionHash) throw new Error('No submitted transaction hash.');
            return provider.viewTransactionStatus({
              txHash: job.transactionHash,
              accountId: d.operator,
              waitUntil: 'FINAL',
            });
          },
          prepare: async () => {
            if (d.features?.includes('invoice-v1') && !job.invoice)
              throw new HoldPaymentError(
                'This request needs a fresh authorization referencing a supplier-confirmed invoice.',
              );
            if (
              job.authorization === 'automatic' &&
              (!d.features?.includes('automatic-v1') ||
                (await view<ChainPaymentPolicy>(d, 'get_payment_policy', { order_id: job.orderId }))
                  .mode !== 'automatic')
            )
              throw new HoldPaymentError('Automatic payment is not enabled for this order.');
            const key = await operatorKey(d);
            const signer = KeyPairSigner.fromSecretKey(key.secretKey);
            const account = new Account(key.accountId, provider, signer);
            const transaction = await account.createTransaction({
              receiverId: d.vault,
              publicKey: key.publicKey,
              actions: [
                actions.functionCall(
                  'request_payment',
                  paymentArguments(job),
                  150_000_000_000_000n,
                  0n,
                ),
              ],
            });
            return (await signer.signTransaction(transaction)).signedTransaction;
          },
          broadcast: async (transaction) => {
            const key = await operatorKey(d);
            if (transaction.transaction.publicKey.toString() !== key.publicKey)
              throw new HoldPaymentError('Stored payment authorization needs review.');
            return provider.sendTransactionUntil(transaction, 'FINAL');
          },
          save,
        });
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
