import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, rmdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { KeyPair, KeyPairSigner, Transaction, actions, baseEncode } from 'near-api-js';
import { Ledger } from '../server/ledger.ts';
import { productionApp } from '../server/production.ts';
import {
  paymentArguments,
  preparedPayment,
  publicPaymentJob,
  runPaymentJob,
  type StoredPaymentJob,
} from '../server/payment-worker.ts';
import type { ChainAttempt, Deployment } from '../shared/chain.ts';

async function fixture() {
  const d: Deployment = {
    network: 'testnet',
    rpcUrl: '',
    vault: 'vault.testnet',
    token: 'token.testnet',
    operator: 'operator.testnet',
    wasmSha256: { vault: 'a'.repeat(64) },
    accounts: {},
  };
  const job: StoredPaymentJob = {
    network: d.network,
    vault: d.vault,
    id: 'recover-1',
    orderId: 'PO-1',
    quantity: '4',
    auditHash: 'b'.repeat(64),
    status: 'queued',
    transactionHash: null,
    error: null,
    createdAt: new Date().toISOString(),
  };
  const pair = KeyPair.fromRandom('ed25519');
  const signer = KeyPairSigner.fromSecretKey(pair.toString());
  const transaction = new Transaction({
    signerId: d.operator,
    publicKey: pair.getPublicKey(),
    receiverId: d.vault,
    nonce: 1n,
    blockHash: new Uint8Array(32).fill(7),
    actions: [
      actions.functionCall('request_payment', paymentArguments(job), 150_000_000_000_000n, 0n),
    ],
  });
  const signed = await signer.signTransaction(transaction);
  const stored: StoredPaymentJob = {
    ...job,
    status: 'submitting',
    transactionHash: baseEncode(signed.txHash),
    preparedTransaction: Buffer.from(signed.signedTransaction.encode()).toString('base64'),
    preparedCodeHash: d.wasmSha256.vault,
  };
  const attempt: ChainAttempt = {
    request_id: job.id,
    order_id: job.orderId,
    quantity: '4',
    amount: '40000000',
    recipient: 'supplier.testnet',
    audit_hash: job.auditHash,
    status: 'Settled',
  };
  return { d, job, stored, signed: signed.signedTransaction, attempt };
}

test('a process restart after durable preparation broadcasts the saved authorization without signing again', async () => {
  const f = await fixture();
  const dir = await mkdtemp(join(tmpdir(), 'accord-worker-restart-'));
  const path = join(dir, 'jobs.sqlite');
  let ledger = new Ledger(path);
  ledger.db.exec('CREATE TABLE chain_jobs(id TEXT PRIMARY KEY, payload TEXT NOT NULL)');
  let signatures = 0,
    broadcasts = 0;
  const persist = (job: StoredPaymentJob) =>
    ledger.db
      .prepare('INSERT OR REPLACE INTO chain_jobs VALUES(?,?)')
      .run(job.id, JSON.stringify(job));
  try {
    await assert.rejects(
      runPaymentJob(f.d, f.job, {
        attempt: async () => null,
        transactionStatus: async () => {
          throw new Error('Unknown transaction');
        },
        prepare: async () => {
          signatures++;
          return f.signed;
        },
        broadcast: async () => {
          broadcasts++;
        },
        save: (job) => {
          persist(job);
          throw new Error('Process stopped before broadcast');
        },
      }),
      /Process stopped/,
    );
    assert.equal(broadcasts, 0);
    ledger.close();
    ledger = new Ledger(path);
    const row = ledger.db.prepare('SELECT payload FROM chain_jobs WHERE id=?').get(f.job.id) as {
      payload: string;
    };
    const recovered = JSON.parse(row.payload) as StoredPaymentJob;
    const savedBytes = recovered.preparedTransaction;
    let sent = false;
    await runPaymentJob(f.d, recovered, {
      attempt: async () => (sent ? f.attempt : null),
      transactionStatus: async () => {
        throw new Error('Unknown transaction');
      },
      prepare: async () => {
        signatures++;
        throw new Error('Must not sign again');
      },
      broadcast: async (transaction) => {
        broadcasts++;
        assert.equal(Buffer.from(transaction.encode()).toString('base64'), savedBytes);
        sent = true;
      },
      save: persist,
    });
    assert.equal(signatures, 1);
    assert.equal(broadcasts, 1);
    assert.equal(recovered.status, 'settled');
    assert.equal(recovered.preparedTransaction, undefined);
  } finally {
    ledger.close();
    for (const suffix of ['', '-wal', '-shm']) await rm(path + suffix, { force: true });
    await rmdir(dir);
  }
});

test('an ambiguous broadcast retains identical bytes, while an existing chain reservation stops rebroadcast', async () => {
  const f = await fixture();
  const before = f.stored.preparedTransaction;
  let broadcasts = 0;
  await runPaymentJob(f.d, f.stored, {
    attempt: async () => null,
    transactionStatus: async () => {
      throw new Error('RPC unavailable');
    },
    prepare: async () => {
      throw new Error('Must not sign again');
    },
    broadcast: async () => {
      broadcasts++;
      throw new Error('Response lost');
    },
    save: () => {},
  });
  assert.equal(f.stored.status, 'unresolved');
  assert.equal(f.stored.preparedTransaction, before);
  await runPaymentJob(f.d, f.stored, {
    attempt: async () => ({ ...f.attempt, status: 'Reserved' }),
    transactionStatus: async () => {
      throw new Error('Should not query a known reservation');
    },
    prepare: async () => {
      throw new Error('Must not sign again');
    },
    broadcast: async () => {
      broadcasts++;
    },
    save: () => {},
  });
  assert.equal(broadcasts, 1);
  assert.equal(f.stored.status, 'unresolved');
});

test('altered amount, signature, destination, deployment and hash cannot use a stored payment authorization', async () => {
  const f = await fixture();
  for (const edit of [
    (job: StoredPaymentJob) => {
      job.quantity = '5';
    },
    (job: StoredPaymentJob) => {
      job.transactionHash = 'wrong-hash';
    },
    (job: StoredPaymentJob) => {
      job.preparedCodeHash = 'c'.repeat(64);
    },
    (job: StoredPaymentJob) => {
      job.vault = 'other.testnet';
    },
    (job: StoredPaymentJob) => {
      job.network = 'mainnet';
    },
    (job: StoredPaymentJob) => {
      const bytes = Buffer.from(job.preparedTransaction!, 'base64');
      bytes[bytes.length - 1] ^= 1;
      job.preparedTransaction = bytes.toString('base64');
    },
  ]) {
    const job = { ...f.stored };
    edit(job);
    assert.throws(() => preparedPayment(job, f.d), /needs review/);
  }
  const changed = f.signed.transaction;
  changed.receiverId = 'attacker.testnet';
  const redirected = {
    ...f.stored,
    preparedTransaction: Buffer.from(f.signed.encode()).toString('base64'),
    transactionHash: baseEncode(createHash('sha256').update(changed.encode()).digest()),
  };
  assert.throws(() => preparedPayment(redirected, f.d), /needs review/);
});

test('legacy ambiguous jobs without signed bytes stay held and are never re-signed', async () => {
  const f = await fixture();
  const job = {
    ...f.job,
    status: 'unresolved' as const,
    transactionHash: f.stored.transactionHash,
  };
  await runPaymentJob(f.d, job, {
    attempt: async () => null,
    transactionStatus: async () => {
      throw new Error('Unknown transaction');
    },
    prepare: async () => {
      throw new Error('Must not sign again');
    },
    broadcast: async () => {
      throw new Error('Must not broadcast');
    },
    save: () => {},
  });
  assert.equal(job.status, 'unresolved');
});

test('the public jobs API excludes signed authorizations and private metadata', async () => {
  const f = await fixture();
  const ledger = new Ledger(':memory:');
  const secret = 'test-origin-secret-at-least-32-characters';
  const app = productionApp(ledger, {
    origin: 'https://accord.example',
    proxySecret: secret,
    worker: false,
  });
  try {
    await app.ready();
    ledger.db
      .prepare('INSERT INTO chain_jobs VALUES(?,?)')
      .run(f.stored.id, JSON.stringify(f.stored));
    const response = await app.inject({
      url: '/api/chain/jobs',
      headers: { 'x-accord-proxy-secret': secret },
    });
    assert.equal(response.statusCode, 200);
    const [job] = response.json().jobs;
    assert.equal(job.id, f.stored.id);
    assert.equal(job.transactionHash, f.stored.transactionHash);
    assert.equal(job.preparedTransaction, undefined);
    assert.equal(job.preparedCodeHash, undefined);
    assert.ok(!response.body.includes(f.stored.preparedTransaction!));
    assert.equal(publicPaymentJob(f.stored).id, f.stored.id);
  } finally {
    await app.close();
    ledger.close();
  }
});
