import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { FinalizedRpcProvider } from './rpc.ts';
import { verifyMessage } from 'near-api-js/nep413';
import { z } from 'zod';
import { accountSchema } from '../shared/schema.ts';
import type { ChainOrder } from '../shared/chain.ts';
import { DomainError } from './ledger.ts';

type Proof = { accountId: string; publicKey: string; signature: string };
type Challenge = {
  id: string;
  accountId: string;
  nonce: string;
  message: string;
  recipient: string;
  expires: number;
};
type Verifier = (proof: Proof, challenge: Challenge) => Promise<void>;
const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex');
const proofSchema = z.strictObject({
  challengeId: z.string().uuid(),
  accountId: accountSchema,
  publicKey: z.string().max(200),
  signature: z.string().max(256),
});

export class WalletSessions {
  constructor(
    private db: DatabaseSync,
    private origin: string,
    private verify: Verifier = verifyProof,
    private clock = Date.now,
  ) {
    db.exec(`CREATE TABLE IF NOT EXISTS wallet_challenges (id TEXT PRIMARY KEY, payload TEXT NOT NULL, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS wallet_sessions (hash TEXT PRIMARY KEY, account TEXT NOT NULL, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS invoice_quotas (scope TEXT NOT NULL, bucket INTEGER NOT NULL, used INTEGER NOT NULL, PRIMARY KEY(scope,bucket));`);
  }
  challenge(accountId: string) {
    accountSchema.parse(accountId);
    const expires = this.clock() + 300000;
    const challenge: Challenge = {
      id: randomUUID(),
      accountId,
      nonce: randomBytes(32).toString('base64'),
      expires,
      recipient: 'Accord invoice access',
      message: '',
    };
    challenge.message = JSON.stringify({
      application: 'Accord',
      purpose: 'Authorize invoice processing',
      website: this.origin,
      network: 'testnet',
      accountId,
      challengeId: challenge.id,
      expires,
    });
    this.db.prepare('DELETE FROM wallet_challenges WHERE expires<?').run(this.clock());
    this.db.prepare('DELETE FROM wallet_sessions WHERE expires<?').run(this.clock());
    this.db
      .prepare('INSERT INTO wallet_challenges (id,payload,expires) VALUES (?,?,?)')
      .run(challenge.id, JSON.stringify(challenge), expires);
    return challenge;
  }
  async accept(input: unknown) {
    const proof = proofSchema.parse(input);
    const row = this.db
      .prepare('SELECT payload,expires FROM wallet_challenges WHERE id=?')
      .get(proof.challengeId) as { payload: string; expires: number } | undefined;
    if (!row || row.expires <= this.clock())
      throw new DomainError('This sign-in request expired or was already used.', 401);
    const challenge = JSON.parse(row.payload) as Challenge;
    if (proof.accountId !== challenge.accountId)
      throw new DomainError('This wallet does not match the sign-in request.', 403);
    try {
      await this.verify(proof, challenge);
    } catch {
      throw new DomainError('Wallet ownership could not be verified.', 403);
    }
    const token = randomBytes(32).toString('base64url'),
      expires = this.clock() + 1800000;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const consumed = this.db
        .prepare('DELETE FROM wallet_challenges WHERE id=? AND expires>?')
        .run(challenge.id, this.clock());
      if (Number(consumed.changes) !== 1)
        throw new DomainError('This sign-in request was already used.', 401);
      this.db
        .prepare('INSERT INTO wallet_sessions (hash,account,expires) VALUES (?,?,?)')
        .run(tokenHash(token), proof.accountId, expires);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return { token, expires, accountId: proof.accountId };
  }
  account(authorization: string | undefined) {
    if (!authorization?.startsWith('Bearer '))
      throw new DomainError('Authorize your wallet to process this invoice.', 401);
    const token = authorization.slice(7);
    if (token.length !== 43) throw new DomainError('Wallet authorization is invalid.', 401);
    const row = this.db
      .prepare('SELECT account,expires FROM wallet_sessions WHERE hash=?')
      .get(tokenHash(token)) as { account: string; expires: number } | undefined;
    if (!row || row.expires <= this.clock())
      throw new DomainError('Wallet authorization expired. Please sign in again.', 401);
    return row.account;
  }
  authorizeOrder(authorization: string | undefined, order: ChainOrder) {
    const account = this.account(authorization);
    if (
      ![order.buyer, order.terms.supplier, order.terms.receiver, order.terms.operator].includes(
        account,
      )
    )
      throw new DomainError('This wallet is not authorized for this purchase order.', 403);
    return account;
  }
  authorizeInvoice(authorization: string | undefined, order: ChainOrder) {
    this.authorizeOrder(authorization, order);
    const minute = Math.floor(this.clock() / 60000),
      day = Math.floor(this.clock() / 86400000);
    const quotas = [
      { scope: `order-minute:${order.id}`, bucket: minute, limit: 5 },
      { scope: `order-day:${order.id}`, bucket: day, limit: 100 },
      { scope: 'global-day', bucket: day, limit: 1000 },
    ];
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const q of quotas) {
        const row = this.db
          .prepare('SELECT used FROM invoice_quotas WHERE scope=? AND bucket=?')
          .get(q.scope, q.bucket) as { used: number } | undefined;
        if ((row?.used ?? 0) >= q.limit)
          throw new DomainError('Invoice processing limit reached. Please try again later.', 429);
        this.db
          .prepare(
            'INSERT INTO invoice_quotas (scope,bucket,used) VALUES (?,?,1) ON CONFLICT(scope,bucket) DO UPDATE SET used=used+1',
          )
          .run(q.scope, q.bucket);
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  register(app: FastifyInstance) {
    app.post('/api/chain/session/challenge', async (req) =>
      this.challenge(z.strictObject({ accountId: accountSchema }).parse(req.body).accountId),
    );
    app.post('/api/chain/session', async (req) => this.accept(req.body));
  }
}
async function verifyProof(proof: Proof, challenge: Challenge) {
  await verifyMessage({
    signerAccountId: proof.accountId,
    signerPublicKey: proof.publicKey,
    payload: {
      message: challenge.message,
      nonce: Buffer.from(challenge.nonce, 'base64'),
      recipient: challenge.recipient,
    },
    signature: Buffer.from(proof.signature, 'base64'),
    provider: new FinalizedRpcProvider({ url: 'https://test.rpc.fastnear.com' }),
  });
}
export type InvoiceAuthorizer = (
  request: FastifyRequest,
  order: ChainOrder,
) => void | Promise<void>;
