import {
  Account,
  JsonRpcProvider,
  KeyPairSigner,
  actions,
  baseEncode,
  type KeyPairString,
} from 'near-api-js';
import { verifyMessage } from 'near-api-js/nep413';
import { z } from 'zod';
import { invoiceSchema, accountSchema } from '../shared/schema';
import { DEFAULT_NEAR_AI_MODEL, invoiceRequest } from '../shared/inference';
import type { Deployment, ChainOrder, ChainAttempt } from '../shared/chain';
import { ordersForAccount } from '../shared/chain';
import { assets } from 'accord:assets';

interface Statement {
  bind(...values: unknown[]): Statement;
  first<T>(): Promise<T | null>;
  all<T>(): Promise<{ results: T[] }>;
  run(): Promise<{ meta: { changes: number } }>;
}
interface Database {
  prepare(sql: string): Statement;
  batch(statements: Statement[]): Promise<{ meta: { changes: number } }[]>;
}
interface Env {
  DB: Database;
  DEPLOYMENT_JSON: string;
  OPERATOR_PRIVATE_KEY?: KeyPairString;
  OPERATOR_PUBLIC_KEY?: string;
  NEAR_AI_API_KEY?: string;
  NEAR_AI_MODEL?: string;
}
interface Context {
  waitUntil(promise: Promise<unknown>): void;
}
type Job = {
  id: string;
  orderId: string;
  quantity: string;
  auditHash: string;
  status: 'queued' | 'submitting' | 'settled' | 'failed' | 'unresolved';
  transactionHash: string | null;
  error: string | null;
  createdAt: string;
};
type Challenge = {
  id: string;
  nonce: string;
  message: string;
  recipient: string;
  operator: string;
  request: { orderId: string; quantity: string; auditHash: string };
};
class HttpError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}
const recipient = 'Accord payment authorization';
z.config({ jitless: true });
const json = (body: unknown, status = 200) =>
  Response.json(body, {
    status,
    headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
  });
function config(env: Env) {
  if (!env.DEPLOYMENT_JSON)
    throw new HttpError('The workspace is being prepared. Please try again shortly.', 503);
  const d = JSON.parse(env.DEPLOYMENT_JSON) as Deployment;
  if (
    !['testnet', 'mainnet'].includes(d.network) ||
    !accountSchema.safeParse(d.vault).success ||
    !accountSchema.safeParse(d.token).success
  )
    throw new HttpError('Workspace configuration is unavailable.', 503);
  const rpc =
    d.network === 'mainnet' ? 'https://rpc.mainnet.near.org' : 'https://test.rpc.fastnear.com';
  return { d, provider: new JsonRpcProvider({ url: rpc }), scope: `${d.network}:${d.vault}` };
}
async function read<T>(
  provider: JsonRpcProvider,
  d: Deployment,
  method: string,
  args: Record<string, unknown>,
) {
  return provider.callFunction({ contractId: d.vault, method, args }) as Promise<T>;
}
async function keyReady(env: Env, provider: JsonRpcProvider, d: Deployment) {
  if (!env.OPERATOR_PRIVATE_KEY || !env.OPERATOR_PUBLIC_KEY) return false;
  const k = await provider.viewAccessKey({
    accountId: d.operator,
    publicKey: env.OPERATOR_PUBLIC_KEY,
  });
  return (
    k.permission !== 'FullAccess' &&
    'FunctionCall' in k.permission &&
    k.permission.FunctionCall.receiver_id === d.vault &&
    k.permission.FunctionCall.method_names.length === 1 &&
    k.permission.FunctionCall.method_names[0] === 'request_payment'
  );
}
async function body(request: Request) {
  const text = await request.text();
  if (text.length > 40_000) throw new HttpError('This file is too large.', 413);
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError('The request could not be read.');
  }
}
function decode(value: string) {
  return Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
}
function encode(value: Uint8Array) {
  return btoa(Array.from(value, (b) => String.fromCharCode(b)).join(''));
}
async function digest(text: string) {
  return Array.from(
    new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))),
    (b) => b.toString(16).padStart(2, '0'),
  ).join('');
}
async function invoice(
  request: Request,
  env: Env,
  provider: JsonRpcProvider,
  d: Deployment,
  id: string,
) {
  const input = z
    .strictObject({ text: z.string().trim().min(1).max(32768), mode: z.literal('live').optional() })
    .parse(await body(request));
  const order = await read<ChainOrder | null>(provider, d, 'get_order', { order_id: id });
  if (!order) throw new HttpError('Purchase order not found.', 404);
  if (!env.NEAR_AI_API_KEY)
    throw new HttpError(
      'Invoice processing is temporarily unavailable. Your order has not changed.',
      503,
    );
  const model = env.NEAR_AI_MODEL || DEFAULT_NEAR_AI_MODEL;
  const response = await fetch('https://cloud-api.near.ai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.NEAR_AI_API_KEY}` },
    body: JSON.stringify(invoiceRequest(input.text, model)),
    signal: AbortSignal.timeout(45000),
  });
  if (!response.ok)
    throw new HttpError('Invoice processing is unavailable. Please try again.', 502);
  let parsed: unknown;
  try {
    const result = (await response.json()) as { choices?: { message?: { content?: string } }[] };
    parsed = JSON.parse(result.choices?.[0]?.message?.content ?? '');
  } catch {
    throw new HttpError('Some invoice fields need review. No payment was requested.', 422);
  }
  const checked = invoiceSchema.safeParse(parsed);
  if (!checked.success)
    throw new HttpError('Some invoice fields need review. No payment was requested.', 422);
  const i = checked.data;
  if (
    i.orderId !== order.id ||
    i.lineId !== order.terms.line_id ||
    i.amountBaseUnits !== (BigInt(i.quantity) * BigInt(order.terms.unit_price)).toString()
  )
    throw new HttpError(
      'The invoice does not match this order. Review the order, quantity, and price.',
      422,
    );
  return json({
    id: crypto.randomUUID(),
    orderId: order.id,
    mode: 'live',
    invoice: i,
    documentHash: await digest(input.text),
    model,
    recordedAt: new Date().toISOString(),
    providerRequestId: response.headers.get('x-request-id'),
  });
}
async function jobs(env: Env, scope: string) {
  return (
    await env.DB.prepare(
      'SELECT payload FROM chain_jobs WHERE scope=? ORDER BY created_at DESC LIMIT 100',
    )
      .bind(scope)
      .all<{ payload: string }>()
  ).results.map((r) => JSON.parse(r.payload) as Job);
}
async function save(env: Env, scope: string, job: Job) {
  await env.DB.prepare('UPDATE chain_jobs SET payload=? WHERE id=? AND scope=?')
    .bind(JSON.stringify(job), job.id, scope)
    .run();
}
async function processJobs(env: Env) {
  const { d, provider, scope } = config(env);
  if (!(await keyReady(env, provider, d))) return;
  await env.DB.prepare('INSERT OR IGNORE INTO operator_locks (scope,expires) VALUES (?,0)')
    .bind(scope)
    .run();
  const owner = crypto.randomUUID();
  const lock = await env.DB.prepare(
    'UPDATE operator_locks SET owner=?,expires=? WHERE scope=? AND expires<?',
  )
    .bind(owner, Date.now() + 300000, scope, Date.now())
    .run();
  if (lock.meta.changes !== 1) return;
  try {
    for (const job of (await jobs(env, scope))
      .filter((j) => ['queued', 'submitting', 'unresolved'].includes(j.status))
      .slice(0, 5)) {
      const attempt = await read<ChainAttempt | null>(provider, d, 'get_attempt', {
        request_id: job.id,
      });
      if (attempt) {
        job.status =
          attempt.status === 'Settled'
            ? 'settled'
            : attempt.status === 'TransferFailed'
              ? 'failed'
              : 'unresolved';
        await save(env, scope, job);
        continue;
      }
      if (job.status !== 'queued') {
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
            } else job.status = 'unresolved';
          } catch {
            job.status = 'unresolved';
          }
        }
        await save(env, scope, job);
        continue;
      }
      const signer = KeyPairSigner.fromSecretKey(env.OPERATOR_PRIVATE_KEY!);
      const account = new Account(d.operator, provider, signer);
      const transaction = await account.createTransaction({
        receiverId: d.vault,
        publicKey: env.OPERATOR_PUBLIC_KEY!,
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
      await save(env, scope, job);
      try {
        await provider.sendTransactionUntil(signed.signedTransaction, 'FINAL');
        const final = await read<ChainAttempt | null>(provider, d, 'get_attempt', {
          request_id: job.id,
        });
        job.status =
          final?.status === 'Settled'
            ? 'settled'
            : final?.status === 'TransferFailed'
              ? 'failed'
              : 'unresolved';
      } catch {
        job.status = 'unresolved';
        job.error = 'The outcome is being checked. Your request will not be sent twice.';
      }
      await save(env, scope, job);
    }
  } finally {
    await env.DB.prepare('UPDATE operator_locks SET expires=0,owner=NULL WHERE scope=? AND owner=?')
      .bind(scope, owner)
      .run();
  }
}
async function api(request: Request, env: Env, ctx: Context) {
  const url = new URL(request.url),
    path = url.pathname;
  const origin = request.headers.get('Origin');
  if (origin && origin !== url.origin) throw new HttpError('This request is not permitted.', 403);
  if (path === '/api/health') return json({ ok: true });
  const { d, provider, scope } = config(env);
  if (path === '/api/chain/state' && request.method === 'GET') {
    const account = url.searchParams.get('account');
    let orders: ChainOrder[] = [];
    if (account && accountSchema.safeParse(account).success) {
      const all = await read<ChainOrder[]>(provider, d, 'list_orders', { limit: 50 });
      orders = ordersForAccount(all, account);
    }
    const stored = await jobs(env, scope);
    const ids = [...new Set([...(d.trackedRequestIds ?? []), ...stored.map((j) => j.id)])];
    const attempts = orders.length
      ? (
          await Promise.all(
            ids
              .slice(-100)
              .map((id) =>
                read<ChainAttempt | null>(provider, d, 'get_attempt', { request_id: id }),
              ),
          )
        ).filter((a) => a && orders.some((o) => o.id === a.order_id))
      : [];
    let operatorReady = false;
    try {
      operatorReady = await keyReady(env, provider, d);
    } catch {
      /* unavailable signer does not prevent reading orders */
    }
    if (stored.some((j) => ['queued', 'submitting', 'unresolved'].includes(j.status)))
      ctx.waitUntil(processJobs(env).catch(() => {}));
    return json({
      configured: true,
      deployment: d,
      orders,
      attempts,
      operatorReady,
      liveAiAvailable: !!env.NEAR_AI_API_KEY,
    });
  }
  if (path === '/api/chain/jobs' && request.method === 'GET')
    return json({ jobs: await jobs(env, scope) });
  const invoiceId = path.match(/^\/api\/chain\/orders\/([^/]+)\/extract$/)?.[1];
  if (invoiceId && request.method === 'POST')
    return invoice(request, env, provider, d, decodeURIComponent(invoiceId));
  if (path === '/api/chain/challenge' && request.method === 'POST') {
    if (!(await keyReady(env, provider, d)))
      throw new HttpError('Payment processing is temporarily unavailable.', 503);
    const r = z
      .strictObject({
        orderId: z.string().min(1).max(64),
        quantity: z.string().regex(/^[1-9]\d{0,18}$/),
        auditHash: z.string().regex(/^[a-f0-9]{64}$/),
      })
      .parse(await body(request));
    const o = await read<ChainOrder | null>(provider, d, 'get_order', { order_id: r.orderId });
    if (!o) throw new HttpError('Purchase order not found.', 404);
    if (o.terms.operator !== d.operator)
      throw new HttpError('The payment operator does not match this order.', 403);
    if (BigInt(r.quantity) > BigInt(o.accepted) - BigInt(o.paid) - BigInt(o.pending))
      throw new HttpError('The requested quantity is no longer available. Refresh the order.', 409);
    const expires = Date.now() + 300000,
      id = crypto.randomUUID();
    const c: Challenge = {
      id,
      nonce: encode(crypto.getRandomValues(new Uint8Array(32))),
      message: JSON.stringify({
        application: 'Accord',
        network: d.network,
        vault: d.vault,
        requestId: id,
        ...r,
        expires,
      }),
      recipient,
      operator: d.operator,
      request: r,
    };
    await env.DB.prepare('INSERT INTO chain_challenges (id,scope,payload,expires) VALUES (?,?,?,?)')
      .bind(id, scope, JSON.stringify(c), expires)
      .run();
    return json({
      id,
      nonce: c.nonce,
      message: c.message,
      recipient,
      expires,
      accountId: d.operator,
    });
  }
  if (path === '/api/chain/submit' && request.method === 'POST') {
    const input = z
      .strictObject({
        challengeId: z.string().uuid(),
        accountId: accountSchema,
        publicKey: z.string().min(1).max(200),
        signature: z.string().min(1).max(256),
      })
      .parse(await body(request));
    const row = await env.DB.prepare(
      'SELECT payload,used,expires FROM chain_challenges WHERE id=? AND scope=?',
    )
      .bind(input.challengeId, scope)
      .first<{ payload: string; used: number; expires: number }>();
    if (!row || row.used || row.expires < Date.now())
      throw new HttpError('This authorization has expired or was already used.', 409);
    const c = JSON.parse(row.payload) as Challenge;
    if (input.accountId !== c.operator || input.accountId !== d.operator)
      throw new HttpError('This wallet cannot authorize the payment operator.', 403);
    try {
      await verifyMessage({
        signerAccountId: input.accountId,
        signerPublicKey: input.publicKey,
        payload: { message: c.message, nonce: decode(c.nonce), recipient },
        signature: decode(input.signature),
        provider,
      });
    } catch {
      throw new HttpError('The wallet authorization could not be verified.', 403);
    }
    const job: Job = {
      id: c.id,
      orderId: c.request.orderId,
      quantity: c.request.quantity,
      auditHash: c.request.auditHash,
      status: 'queued',
      transactionHash: null,
      error: null,
      createdAt: new Date().toISOString(),
    };
    const results = await env.DB.batch([
      env.DB.prepare(
        'INSERT INTO chain_jobs (id,scope,payload,created_at) SELECT ?,?,?,? WHERE EXISTS (SELECT 1 FROM chain_challenges WHERE id=? AND scope=? AND used=0 AND expires>=?)',
      ).bind(job.id, scope, JSON.stringify(job), Date.now(), c.id, scope, Date.now()),
      env.DB.prepare('UPDATE chain_challenges SET used=1 WHERE id=? AND scope=? AND used=0').bind(
        c.id,
        scope,
      ),
    ]);
    if (results[0].meta.changes !== 1)
      throw new HttpError('This authorization was already used.', 409);
    ctx.waitUntil(processJobs(env).catch(() => {}));
    return json(job, 202);
  }
  throw new HttpError('Not found.', 404);
}
export default {
  async fetch(request: Request, env: Env, ctx: Context) {
    try {
      if (new URL(request.url).pathname.startsWith('/api/')) return await api(request, env, ctx);
      const path = new URL(request.url).pathname;
      if (request.method !== 'GET' && request.method !== 'HEAD')
        return new Response('Method not allowed', { status: 405 });
      if (path.startsWith('/dev/')) return new Response('Not found', { status: 404 });
      const asset = assets[path] ?? (!path.includes('.') ? assets['/index.html'] : null);
      if (!asset) return new Response('Not found', { status: 404 });
      return new Response(request.method === 'HEAD' ? null : decode(asset.body), {
        headers: {
          'Content-Type': asset.mime,
          'Cache-Control': path.startsWith('/assets/')
            ? 'public,max-age=31536000,immutable'
            : 'no-cache',
          'X-Content-Type-Options': 'nosniff',
          'Referrer-Policy': 'strict-origin-when-cross-origin',
        },
      });
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message }, e.status);
      if (e instanceof z.ZodError) return json({ error: 'Please check the request details.' }, 400);
      console.error('Request failed', e instanceof Error ? e.name : 'Error');
      return json(
        { error: 'This action could not be completed. Refresh the order before trying again.' },
        503,
      );
    }
  },
};
