import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Ledger } from '../server/ledger.ts';
import { productionApp } from '../server/production.ts';
import { WalletSessions } from '../server/sessions.ts';
import type { ChainOrder } from '../shared/chain.ts';

const origin = 'https://accord.example',
  secret = 'test-proxy-secret-that-is-at-least-32-characters';
const headers = { 'x-accord-proxy-secret': secret, origin };
const proof = (id: string, accountId = 'operator.testnet') => ({
  challengeId: id,
  accountId,
  publicKey: 'test-public-key',
  signature: 'test-signature',
});
const order = {
  id: 'PO-1',
  buyer: 'buyer.testnet',
  terms: {
    supplier: 'supplier.testnet',
    receiver: 'receiver.testnet',
    operator: 'operator.testnet',
  },
} as ChainOrder;

test('production API requires its trusted proxy and excludes all simulator endpoints', async () => {
  const ledger = new Ledger(':memory:');
  const app = productionApp(ledger, { origin, proxySecret: secret, worker: false });
  try {
    assert.equal((await app.inject({ url: '/api/health' })).statusCode, 403);
    assert.equal(
      (
        await app.inject({
          url: '/api/health',
          headers: { ...headers, origin: 'https://other.example' },
        })
      ).statusCode,
      403,
    );
    const healthy = await app.inject({ url: '/api/health', headers });
    assert.equal(healthy.statusCode, 200);
    assert.equal(healthy.headers['cache-control'], 'no-store');
    assert.equal(
      (await app.inject({ method: 'POST', url: '/api/demo/seed', headers, payload: {} }))
        .statusCode,
      404,
    );
    assert.equal((await app.inject({ url: '/api/state', headers })).statusCode, 404);
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: '/api/chain/orders/PO-1/extract',
          headers,
          payload: { text: 'Invoice', mode: 'live' },
        })
      ).statusCode,
      401,
    );
  } finally {
    await app.close();
    ledger.close();
  }
});

test('wallet sign-in binds account and website, consumes its challenge, and stores only a token hash', async () => {
  const ledger = new Ledger(':memory:');
  const sessions = new WalletSessions(ledger.db, origin, async (input, challenge) => {
    assert.equal(input.accountId, 'operator.testnet');
    assert.equal(JSON.parse(challenge.message).website, origin);
    assert.equal(Buffer.from(challenge.nonce, 'base64').length, 32);
  });
  try {
    const challenge = sessions.challenge('operator.testnet');
    await assert.rejects(sessions.accept(proof(challenge.id, 'other.testnet')), /does not match/);
    const session = await sessions.accept(proof(challenge.id));
    assert.equal(sessions.account(`Bearer ${session.token}`), 'operator.testnet');
    const stored = ledger.db.prepare('SELECT hash FROM wallet_sessions').all() as {
      hash: string;
    }[];
    assert.ok(stored.every((row) => row.hash !== session.token));
    await assert.rejects(sessions.accept(proof(challenge.id)), /already used/);
    assert.throws(() => sessions.account(undefined), /Authorize/);
  } finally {
    ledger.close();
  }
});

test('invalid signatures, expired sessions, and simultaneous challenge replay fail closed', async () => {
  const ledger = new Ledger(':memory:');
  let clock = 1000000;
  let valid = false;
  const sessions = new WalletSessions(
    ledger.db,
    origin,
    async () => {
      if (!valid) throw new Error('Invalid signature');
    },
    () => clock,
  );
  try {
    const first = sessions.challenge('operator.testnet');
    await assert.rejects(sessions.accept(proof(first.id)), /could not be verified/);
    valid = true;
    const results = await Promise.allSettled([
      sessions.accept(proof(first.id)),
      sessions.accept(proof(first.id)),
    ]);
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    const accepted = results.find((r) => r.status === 'fulfilled')! as PromiseFulfilledResult<{
      token: string;
    }>;
    clock += 1800001;
    assert.throws(() => sessions.account(`Bearer ${accepted.value.token}`), /expired/);
    const expired = sessions.challenge('operator.testnet');
    clock += 300001;
    await assert.rejects(sessions.accept(proof(expired.id)), /expired/);
  } finally {
    ledger.close();
  }
});

test('invoice access is limited to order members and paid requests have persistent quotas', async () => {
  const ledger = new Ledger(':memory:');
  let clock = 1000000;
  const sessions = new WalletSessions(
    ledger.db,
    origin,
    async () => {},
    () => clock,
  );
  try {
    const challenge = sessions.challenge('operator.testnet');
    const session = await sessions.accept(proof(challenge.id));
    const auth = `Bearer ${session.token}`;
    assert.throws(
      () =>
        sessions.authorizeInvoice(auth, {
          ...order,
          terms: { ...order.terms, operator: 'different.testnet' },
        }),
      /not authorized/,
    );
    for (let i = 0; i < 5; i++) sessions.authorizeInvoice(auth, order);
    assert.throws(() => sessions.authorizeInvoice(auth, order), /limit reached/);
    // Reopening the access layer must not reset the billing boundary.
    const reopened = new WalletSessions(
      ledger.db,
      origin,
      async () => {},
      () => clock,
    );
    assert.throws(() => reopened.authorizeInvoice(auth, order), /limit reached/);
    clock += 60000;
    reopened.authorizeInvoice(auth, order);
  } finally {
    ledger.close();
  }
});
