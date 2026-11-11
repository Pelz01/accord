import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Ledger } from '../server/ledger.ts';
import {
  IntentsFunding,
  verifiedUSDCReceipt,
  verifyFundingTransaction,
  type FundingRecord,
} from '../server/intents.ts';
import type { FinalizedRpcProvider } from '../server/rpc.ts';
import { fundingActions, WRAPPED_NEAR_ASSET } from '../shared/intents.ts';
import {
  MAINNET_USDC,
  MAINNET_USDC_ASSET,
  VERIFIED_USDC_CODE_HASH,
} from '../shared/mainnet-readiness.ts';
import type { Deployment } from '../shared/chain.ts';

const d: Deployment = {
  network: 'mainnet',
  rpcUrl: 'https://rpc.fastnear.com',
  vault: 'vault.near',
  token: MAINNET_USDC,
  operator: 'operator.near',
  accounts: { buyer: 'buyer.near' },
  wasmSha256: {},
};
const source = 'A'.repeat(43),
  destination = 'B'.repeat(43);
function receipt(r: FundingRecord) {
  return {
    status: { SuccessValue: '' },
    transaction: {
      signer_id: r.account,
      receiver_id: 'wrap.near',
      actions: fundingActions(r.quote, r.registrations).map((a) => ({
        FunctionCall: {
          method_name: a.params.methodName,
          args: Buffer.from(JSON.stringify(a.params.args)).toString('base64'),
          deposit: a.params.deposit,
        },
      })),
    },
    receipts_outcome: [],
  };
}
function payout(
  account = 'buyer.near',
  token = MAINNET_USDC,
  status: unknown = { SuccessValue: '' },
) {
  return {
    status: { SuccessValue: '' },
    transaction: { signer_id: 'solver.near', receiver_id: 'intents.near', actions: [] },
    receipts_outcome: [
      {
        outcome: {
          executor_id: token,
          status,
          logs: [
            'EVENT_JSON:' +
              JSON.stringify({
                standard: 'nep141',
                event: 'ft_transfer',
                data: [{ new_owner_id: account, amount: '30000' }],
              }),
          ],
        },
      },
    ],
  };
}
function harness() {
  const ledger = new Ledger(':memory:');
  let response: unknown,
    status = 'PENDING_DEPOSIT',
    requests = 0,
    barrier: Promise<void> | null = null;
  const receipts = new Map<string, unknown>();
  const rpc = {
    callFunction: async ({ method }: { method: string }) =>
      method === 'ft_metadata'
        ? { symbol: 'USDC', decimals: 6 }
        : method === 'storage_balance_bounds'
          ? { min: '1250000000000000000000' }
          : { total: '1250000000000000000000' },
    viewAccount: async () => ({ code_hash: VERIFIED_USDC_CODE_HASH }),
    viewTransactionStatus: async ({ txHash }: { txHash: string }) => {
      if (!receipts.has(txHash)) throw new Error('Unknown receipt');
      return receipts.get(txHash);
    },
  } as unknown as FinalizedRpcProvider;
  const fetcher = (async (url, init) => {
    const path = String(url);
    if (path.endsWith('/tokens'))
      return Response.json([
        {
          assetId: MAINNET_USDC_ASSET,
          contractAddress: MAINNET_USDC,
          blockchain: 'near',
          decimals: 6,
        },
        {
          assetId: WRAPPED_NEAR_ASSET,
          contractAddress: 'wrap.near',
          blockchain: 'near',
          decimals: 24,
        },
      ]);
    if (path.endsWith('/quote')) {
      requests++;
      const request = JSON.parse(String(init?.body));
      response = {
        quoteRequest: request,
        quote: {
          amountIn: request.amount,
          amountOut: '30000',
          minAmountOut: '29700',
          depositAddress: 'deposit.near',
        },
      };
      return Response.json(response);
    }
    if (path.includes('/status?')) {
      if (barrier) await barrier;
      return Response.json({
        status,
        quoteResponse: response,
        swapDetails: { originChainTxHashes: [], destinationChainTxHashes: [{ hash: destination }] },
      });
    }
    if (path.endsWith('/deposit/submit')) return Response.json({});
    throw new Error('Unexpected endpoint');
  }) as typeof fetch;
  const service = new IntentsFunding(ledger.db, rpc, fetcher);
  return {
    ledger,
    service,
    receipts,
    setStatus: (value: string) => {
      status = value;
    },
    holdStatus: () => {
      let release!: () => void;
      barrier = new Promise<void>((r) => {
        release = r;
      });
      return release;
    },
    requests: () => requests,
  };
}
test('a funding request reserves once and provider success cannot replace an unknown source receipt', async () => {
  const h = harness();
  try {
    const q = await h.service.quote(d, 'buyer.near', '0.01');
    h.service.begin(d, 'buyer.near', q.id);
    assert.throws(() => h.service.begin(d, 'buyer.near', q.id));
    assert.throws(() => h.service.cancel(d, 'buyer.near', q.id));
    assert.equal((await h.service.quote(d, 'buyer.near', '0.01')).id, q.id);
    assert.equal(h.requests(), 1);
    await assert.rejects(h.service.record(d, 'buyer.near', q.id, source));
    h.receipts.set(destination, payout());
    h.setStatus('SUCCESS');
    const uncertain = await h.service.status(d, 'buyer.near', q.id);
    assert.equal(uncertain.stage, 'awaiting-wallet');
    assert.equal(uncertain.sourceVerified, false);
    h.receipts.set(source, receipt(q));
    const settled = await h.service.status(d, 'buyer.near', q.id);
    assert.equal(settled.stage, 'settled');
    assert.equal(settled.destinationHash, destination);
    assert.equal(h.requests(), 1);
  } finally {
    h.ledger.close();
  }
});
test('funding receipts reject another signer, recipient, token or failed transfer outcome', async () => {
  const h = harness();
  try {
    const q = await h.service.quote(d, 'buyer.near', '0.01');
    const tx = receipt(q);
    verifyFundingTransaction(tx, q);
    assert.throws(() =>
      verifyFundingTransaction(
        { ...tx, transaction: { ...tx.transaction, signer_id: 'attacker.near' } },
        q,
      ),
    );
    const changed = structuredClone(tx);
    changed.transaction.actions[1].FunctionCall.args = Buffer.from(
      JSON.stringify({ receiver_id: 'attacker.near', amount: q.quote.amountIn }),
    ).toString('base64');
    assert.throws(() => verifyFundingTransaction(changed, q));
    assert.equal(verifiedUSDCReceipt(payout(), d.token, q.account, q.quote.minAmountOut), true);
    assert.equal(
      verifiedUSDCReceipt(payout('attacker.near'), d.token, q.account, q.quote.minAmountOut),
      false,
    );
    assert.equal(
      verifiedUSDCReceipt(
        payout(q.account, 'fake-usdc.near'),
        d.token,
        q.account,
        q.quote.minAmountOut,
      ),
      false,
    );
    assert.equal(
      verifiedUSDCReceipt(
        payout(q.account, d.token, { Failure: {} }),
        d.token,
        q.account,
        q.quote.minAmountOut,
      ),
      false,
    );
    assert.throws(() => h.service.begin(d, 'other.near', q.id));
  } finally {
    h.ledger.close();
  }
});
test('a provider-reported failure or refund stays held for review and cannot authorize another deposit', async () => {
  const h = harness();
  try {
    const q = await h.service.quote(d, 'buyer.near', '0.01');
    h.service.begin(d, q.account, q.id);
    h.setStatus('REFUNDED');
    const held = await h.service.status(d, q.account, q.id);
    assert.equal(held.stage, 'needs-review');
    assert.equal((await h.service.quote(d, q.account, '0.01')).id, q.id);
    assert.throws(() => h.service.cancel(d, q.account, q.id));
  } finally {
    h.ledger.close();
  }
});
test('a status read racing wallet approval cannot reopen the funding button', async () => {
  const h = harness();
  try {
    const q = await h.service.quote(d, 'buyer.near', '0.01');
    const release = h.holdStatus();
    const slow = h.service.status(d, q.account, q.id);
    h.service.begin(d, q.account, q.id);
    release();
    const result = await slow;
    assert.equal(result.stage, 'awaiting-wallet');
    assert.equal(h.service.current(d, q.account)!.stage, 'awaiting-wallet');
    assert.throws(() => h.service.begin(d, q.account, q.id));
  } finally {
    h.ledger.close();
  }
});
