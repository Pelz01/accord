import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RpcReadCache } from '../server/read-cache.ts';

test('simultaneous dashboards share a read; expired data is loaded again', async () => {
  let now = 0;
  let reads = 0;
  const cache = new RpcReadCache({ intervalMs: 0, now: () => now });
  const load = async () => ({ paid: ++reads });
  const [first, second] = await Promise.all([cache.read('order', load), cache.read('order', load)]);
  assert.deepEqual(first, { paid: 1 });
  assert.equal(first, second);
  now = 4999;
  assert.deepEqual(await cache.read('order', load), { paid: 1 });
  now = 5000;
  assert.deepEqual(await cache.read('order', load), { paid: 2 });
});

test('a burst of different RPC reads is paced and a failed read can recover', async () => {
  let now = 0;
  const starts: number[] = [];
  const cache = new RpcReadCache({
    now: () => now,
    sleep: async (ms) => {
      now += ms;
    },
  });
  await Promise.all(
    ['a', 'b', 'c'].map((key) =>
      cache.read(key, async () => {
        starts.push(now);
        return key;
      }),
    ),
  );
  assert.deepEqual(starts, [0, 500, 1000]);
  await assert.rejects(
    cache.read('failed', async () => {
      throw new Error('RPC unavailable');
    }),
  );
  assert.equal(await cache.read('failed', async () => 'recovered'), 'recovered');
});

test('settled records can have longer TTLs and completed entries are bounded', async () => {
  let now = 0;
  const cache = new RpcReadCache({ intervalMs: 0, maxEntries: 2, now: () => now });
  let reads = 0;
  const settled = () =>
    cache.read(
      'settled',
      async () => ++reads,
      () => 60000,
    );
  assert.equal(await settled(), 1);
  now = 10000;
  assert.equal(await settled(), 1);
  await cache.read('b', async () => true);
  await cache.read('c', async () => true);
  assert.equal(await settled(), 2);
});
