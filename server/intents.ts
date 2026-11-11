import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { DatabaseSync } from 'node:sqlite';
import type { FinalizedRpcProvider } from './rpc.ts';
import { DomainError } from './ledger.ts';
import type { Deployment } from '../shared/chain.ts';
import {
  fundingActions,
  fundingRequest,
  validateFundingQuote,
  WRAPPED_NEAR,
  WRAPPED_NEAR_ASSET,
  type FundingRecord,
  type FundingStage as Stage,
} from '../shared/intents.ts';
import { MAINNET_USDC, verifySettlementAsset, nativeAmount } from '../shared/mainnet-readiness.ts';

export type { FundingRecord } from '../shared/intents.ts';
type Receipt = {
  status: unknown;
  transaction: { signer_id: string; receiver_id: string; actions: unknown[] };
  receipts_outcome: { outcome: { executor_id: string; status: unknown; logs: string[] } }[];
};
const success = (v: unknown) => !!v && typeof v === 'object' && 'SuccessValue' in v;
const hashPattern = /^[1-9A-HJ-NP-Za-km-z]{32,60}$/;

export function verifyFundingTransaction(tx: Receipt, record: FundingRecord) {
  if (
    !success(tx.status) ||
    tx.transaction.signer_id !== record.account ||
    tx.transaction.receiver_id !== WRAPPED_NEAR
  )
    throw new Error('The funding receipt does not match this wallet and wrapped-NEAR contract.');
  const actual = tx.transaction.actions.map((action) => {
    const call = (
      action as { FunctionCall?: { method_name: string; args: string; deposit: string } }
    ).FunctionCall;
    if (!call) throw new Error('Unexpected funding action.');
    return {
      method: call.method_name,
      args: JSON.parse(Buffer.from(call.args, 'base64').toString()),
      deposit: call.deposit,
    };
  });
  const expected = fundingActions(record.quote, record.registrations).map((a) => ({
    method: a.params.methodName,
    args: a.params.args,
    deposit: a.params.deposit,
  }));
  if (!isDeepStrictEqual(actual, expected))
    throw new Error('The funding transaction changed the approved instructions.');
}
export function verifiedUSDCReceipt(tx: Receipt, token: string, account: string, minimum: string) {
  let delivered = 0n;
  for (const receipt of tx.receipts_outcome ?? []) {
    const outcome = receipt.outcome;
    if (outcome.executor_id !== token || !success(outcome.status)) continue;
    for (const log of outcome.logs) {
      if (!log.startsWith('EVENT_JSON:')) continue;
      let event;
      try {
        event = JSON.parse(log.slice(11));
      } catch {
        continue;
      }
      if (
        event.standard !== 'nep141' ||
        event.event !== 'ft_transfer' ||
        !Array.isArray(event.data)
      )
        continue;
      for (const entry of event.data)
        if (
          entry.new_owner_id === account &&
          typeof entry.amount === 'string' &&
          /^[0-9]{1,39}$/.test(entry.amount)
        )
          delivered += BigInt(entry.amount);
    }
  }
  return delivered >= BigInt(minimum) && delivered > 0n;
}

export class IntentsFunding {
  constructor(
    private db: DatabaseSync,
    private rpc: FinalizedRpcProvider,
    private fetcher: typeof fetch = fetch,
    private clock = Date.now,
  ) {
    db.exec(
      'CREATE TABLE IF NOT EXISTS chain_funding (id TEXT PRIMARY KEY, network TEXT NOT NULL, vault TEXT NOT NULL, account TEXT NOT NULL, payload TEXT NOT NULL);',
    );
  }
  private save(r: FundingRecord, clearUnverifiedHash?: string) {
    const row = this.db.prepare('SELECT payload FROM chain_funding WHERE id=?').get(r.id) as
      | { payload: string }
      | undefined;
    if (row) {
      const current = JSON.parse(row.payload) as FundingRecord;
      const rank: Record<Stage, number> = {
        quoted: 0,
        'awaiting-wallet': 1,
        submitted: 2,
        'needs-review': 3,
        settled: 4,
        cancelled: 4,
      };
      // A slow status read must never restore a spent or in-flight request to quoted.
      if (['settled', 'cancelled'].includes(current.stage) || rank[current.stage] > rank[r.stage]) {
        r.stage = current.stage;
        r.error = current.error;
      }
      r.sourceVerified = current.sourceVerified || r.sourceVerified;
      if (
        current.sourceHash &&
        !(clearUnverifiedHash === current.sourceHash && !current.sourceVerified)
      )
        r.sourceHash = current.sourceHash;
      if (current.destinationHash) r.destinationHash = current.destinationHash;
    }
    this.db
      .prepare(
        'INSERT INTO chain_funding(id,network,vault,account,payload) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload',
      )
      .run(r.id, r.network, r.vault, r.account, JSON.stringify(r));
  }
  private owned(d: Deployment, account: string, id: string) {
    const row = this.db
      .prepare(
        'SELECT payload FROM chain_funding WHERE id=? AND network=? AND vault=? AND account=?',
      )
      .get(id, d.network, d.vault, account) as { payload: string } | undefined;
    if (!row) throw new DomainError('Funding request not found.', 404);
    return JSON.parse(row.payload) as FundingRecord;
  }
  current(d: Deployment, account: string) {
    const rows = this.db
      .prepare(
        'SELECT payload FROM chain_funding WHERE network=? AND vault=? AND account=? ORDER BY rowid DESC LIMIT 1',
      )
      .all(d.network, d.vault, account) as { payload: string }[];
    return rows.length ? (JSON.parse(rows[0].payload) as FundingRecord) : null;
  }
  private async upstream(path: string, body?: unknown) {
    const key = process.env.NEAR_INTENTS_API_KEY;
    const r = await this.fetcher('https://1click.chaindefuser.com/v0/' + path, {
      method: body === undefined ? 'GET' : 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(15000),
      headers: {
        Accept: 'application/json',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(key ? { Authorization: 'Bearer ' + key } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!r.ok)
      throw new DomainError(
        'NEAR Intents is temporarily unavailable for these funding details.',
        503,
      );
    return r.json();
  }
  async quote(d: Deployment, account: string, amount: string) {
    if (d.network !== 'mainnet' || d.token !== MAINNET_USDC)
      throw new DomainError('Intents funding requires mainnet and native USDC.', 409);
    if (account !== d.accounts.buyer)
      throw new DomainError('Funding is not enabled for this account yet.', 403);
    const existing = this.current(d, account);
    if (existing && !['settled', 'cancelled'].includes(existing.stage)) {
      if (existing.stage === 'quoted' && Date.parse(existing.quote.deadline) <= this.clock()) {
        existing.stage = 'cancelled';
        this.save(existing);
      } else return existing;
    }
    const request = fundingRequest(
      account,
      amount,
      new Date(this.clock() + 9 * 60000).toISOString(),
    );
    const metadata = await this.rpc.callFunction<{ symbol: string; decimals: number }>({
      contractId: d.token,
      method: 'ft_metadata',
      args: {},
    });
    const token = await this.rpc.viewAccount({
      accountId: d.token,
      blockQuery: { finality: 'final' },
    });
    const assets = await this.upstream('tokens');
    if (!metadata) throw new DomainError('USDC metadata is unavailable.', 503);
    verifySettlementAsset(metadata, token.code_hash, assets);
    if (
      !assets.some(
        (a: { assetId: string; contractAddress?: string; decimals: number; blockchain: string }) =>
          a.assetId === WRAPPED_NEAR_ASSET &&
          a.contractAddress === WRAPPED_NEAR &&
          a.decimals === 24 &&
          a.blockchain === 'near',
      )
    )
      throw new DomainError('Wrapped NEAR is unavailable for funding.', 503);
    const response = await this.upstream('quote', request);
    const quote = validateFundingQuote(response, request, this.clock());
    if ([d.vault, d.token, d.operator, ...Object.values(d.accounts)].includes(quote.depositAddress))
      throw new DomainError('Invalid funding deposit address.', 503);
    const bounds = await this.rpc.callFunction<{ min: string }>({
      contractId: WRAPPED_NEAR,
      method: 'storage_balance_bounds',
      args: {},
    });
    if (!bounds || BigInt(bounds.min) <= 0n || BigInt(bounds.min) > nativeAmount('0.002'))
      throw new DomainError('Wrapped NEAR storage terms changed.', 503);
    const registrations = [];
    for (const target of [account, quote.depositAddress]) {
      const registered = await this.rpc.callFunction({
        contractId: WRAPPED_NEAR,
        method: 'storage_balance_of',
        args: { account_id: target },
      });
      if (!registered) registrations.push({ account: target, deposit: bounds.min });
    }
    const r: FundingRecord = {
      id: randomUUID(),
      account,
      network: 'mainnet',
      vault: d.vault,
      createdAt: this.clock(),
      stage: 'quoted',
      request,
      quote,
      registrations,
      sourceHash: null,
      sourceVerified: false,
      destinationHash: null,
      providerStatus: 'PENDING_DEPOSIT',
      error: null,
    };
    // Atomically keep at most one unresolved request per wallet, even when quotes race.
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const active = this.current(d, account);
      if (active && !['settled', 'cancelled'].includes(active.stage)) {
        this.db.exec('COMMIT');
        return active;
      }
      this.save(r);
      this.db.exec('COMMIT');
      return r;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }
  begin(d: Deployment, account: string, id: string) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const r = this.owned(d, account, id);
      if (r.stage !== 'quoted' || Date.parse(r.quote.deadline) <= this.clock() + 30000)
        throw new DomainError('Refresh this quote before approving funding.', 409);
      r.stage = 'awaiting-wallet';
      this.save(r);
      this.db.exec('COMMIT');
      return r;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }
  cancel(d: Deployment, account: string, id: string) {
    const r = this.owned(d, account, id);
    if (r.stage !== 'quoted')
      throw new DomainError(
        'A submitted or uncertain funding request must be reconciled first.',
        409,
      );
    r.stage = 'cancelled';
    this.save(r);
    return r;
  }
  async record(d: Deployment, account: string, id: string, hash: string) {
    if (!hashPattern.test(hash))
      throw new DomainError('Enter a valid public NEAR transaction hash.', 400);
    let r = this.owned(d, account, id);
    if (r.sourceHash && r.sourceHash !== hash)
      throw new DomainError('This request already has a different transaction reference.', 409);
    if (!['awaiting-wallet', 'submitted', 'needs-review'].includes(r.stage))
      throw new DomainError('Funding has not been requested for this quote.', 409);
    // Keep the original hash durable before reading its result; outages never enable another spend.
    r.sourceHash = hash;
    this.save(r);
    const tx = (await this.rpc.viewTransactionStatus({
      accountId: account,
      txHash: hash,
    })) as unknown as Receipt;
    try {
      verifyFundingTransaction(tx, r);
    } catch (e) {
      r.sourceHash = null;
      this.save(r, hash);
      throw e;
    }
    r = this.owned(d, account, id);
    r.stage = 'submitted';
    r.sourceVerified = true;
    r.error = null;
    this.save(r);
    try {
      await this.upstream('deposit/submit', {
        depositAddress: r.quote.depositAddress,
        txHash: hash,
        nearSenderAccount: account,
      });
    } catch {
      /* A notification outage does not change an on-chain deposit. */
    }
    return r;
  }
  async status(d: Deployment, account: string, id: string) {
    let r = this.owned(d, account, id);
    if (['settled', 'cancelled'].includes(r.stage)) return r;
    const status = await this.upstream(
      'status?depositAddress=' + encodeURIComponent(r.quote.depositAddress),
    );
    const repeated = validateFundingQuote(status.quoteResponse, r.request, r.createdAt);
    if (!isDeepStrictEqual(repeated, r.quote))
      throw new DomainError('Funding status does not match the original quote.', 503);
    const known = [
      'PENDING_DEPOSIT',
      'KNOWN_DEPOSIT_TX',
      'PROCESSING',
      'SUCCESS',
      'REFUNDED',
      'FAILED',
      'INCOMPLETE_DEPOSIT',
    ];
    if (!known.includes(status.status))
      throw new DomainError('The funding status needs review.', 503);
    r.providerStatus = status.status;
    const origins = (status.swapDetails?.originChainTxHashes ?? []).slice(0, 4) as {
      hash: string;
    }[];
    if (r.sourceHash && !r.sourceVerified) {
      try {
        r = await this.record(d, account, id, r.sourceHash);
      } catch {
        /* An unknown source remains held. */
      }
    }
    if (!r.sourceHash && r.stage !== 'quoted') {
      for (const source of origins) {
        try {
          r = await this.record(d, account, id, source.hash);
          break;
        } catch {
          /* Keep uncertain funding held. */
        }
      }
    }
    r.providerStatus = status.status;
    if (status.status === 'SUCCESS' && r.sourceVerified) {
      // Provider success alone cannot declare receipt. Require a successful native-USDC transfer.
      const token = await this.rpc.viewAccount({
        accountId: d.token,
        blockQuery: { finality: 'final' },
      });
      const metadata = await this.rpc.callFunction<{ symbol: string; decimals: number }>({
        contractId: d.token,
        method: 'ft_metadata',
        args: {},
      });
      if (!metadata) throw new DomainError('USDC metadata is unavailable.', 503);
      verifySettlementAsset(metadata, token.code_hash, await this.upstream('tokens'));
      const targets = (status.swapDetails?.destinationChainTxHashes ?? []).slice(0, 4) as {
        hash: string;
      }[];
      for (const target of targets) {
        if (!hashPattern.test(target.hash)) continue;
        try {
          const tx = (await this.rpc.viewTransactionStatus({
            accountId: account,
            txHash: target.hash,
          })) as unknown as Receipt;
          if (verifiedUSDCReceipt(tx, d.token, account, r.quote.minAmountOut)) {
            r.stage = 'settled';
            r.destinationHash = target.hash;
            r.error = null;
            break;
          }
        } catch {
          /* Never replace missing chain confirmation with provider success. */
        }
      }
    }
    if (['FAILED', 'REFUNDED', 'INCOMPLETE_DEPOSIT'].includes(status.status)) {
      r.stage = 'needs-review';
      r.error =
        'Funding needs review. Check the original deposit and any refund before starting another swap.';
    }
    this.save(r);
    return r;
  }
}
