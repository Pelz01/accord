import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import proxy from '../api/proxy.ts';

test('Vercel proxy forwards only allowed API paths and replaces untrusted origin credentials', async () => {
  const oldFetch = globalThis.fetch,
    oldUrl = process.env.ACCORD_API_URL,
    oldSecret = process.env.ACCORD_PROXY_SECRET,
    oldNetwork = process.env.ACCORD_NETWORK,
    oldTestnetUrl = process.env.ACCORD_TESTNET_API_URL,
    oldTestnetSecret = process.env.ACCORD_TESTNET_PROXY_SECRET;
  process.env.ACCORD_NETWORK = 'testnet';
  process.env.ACCORD_API_URL = 'https://backend.example/accord/';
  process.env.ACCORD_PROXY_SECRET = 'test-proxy-secret';
  const received: { target: string; options?: RequestInit }[] = [];
  globalThis.fetch = async (target, options) => {
    received.push({ target: String(target), options });
    return Response.json({ ok: true });
  };
  const server = createServer((req, res) => {
    void proxy(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number };
  const send = (path: string, body?: string, network?: string) =>
    new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = httpRequest(
        {
          host: '127.0.0.1',
          port: address.port,
          path,
          method: body ? 'POST' : 'GET',
          headers: {
            'x-accord-proxy-secret': 'visitor-supplied-value',
            Cookie: 'private-browser-cookie',
            ...(network ? { 'x-accord-network': network } : {}),
            ...(body ? { 'Content-Type': 'application/json' } : {}),
          },
        },
        (res) => {
          let text = '';
          res.on('data', (chunk) => {
            text += chunk;
          });
          res.on('end', () => resolve({ status: res.statusCode!, body: text }));
        },
      );
      req.on('error', reject);
      req.end(body);
    });
  try {
    assert.equal(
      (await send('/api/proxy?__accord_path=chain/state&account=buyer.testnet')).status,
      200,
    );
    assert.equal(
      received[0].target,
      'https://backend.example/accord/api/chain/state?account=buyer.testnet',
    );
    const headers = received[0].options!.headers as Record<string, string>;
    assert.equal(headers['x-accord-proxy-secret'], 'test-proxy-secret');
    assert.equal(headers.cookie, undefined);
    assert.equal(received[0].options!.redirect, 'error');
    assert.equal((await send('/api/proxy?__accord_path=https://attacker.example')).status, 404);
    assert.equal(
      (await send('/api/proxy?__accord_path=chain/orders/%252e%252e/extract')).status,
      404,
    );
    assert.equal(received.length, 1);
    assert.equal(
      (
        await send(
          '/api/proxy?__accord_path=chain/session',
          JSON.stringify({ accountId: 'buyer.testnet' }),
        )
      ).status,
      200,
    );
    assert.equal(received[1].options!.body, JSON.stringify({ accountId: 'buyer.testnet' }));
    assert.equal(
      (received[1].options!.headers as Record<string, string>)['content-type'],
      'application/json',
    );
    assert.equal(
      Object.keys(received[1].options!.headers!).filter(
        (key) => key.toLowerCase() === 'content-type',
      ).length,
      1,
    );
    process.env.ACCORD_API_URL = 'http://backend.example';
    process.env.ACCORD_API_URL = 'https://backend.example/accord/';
    assert.equal(
      (await send('/api/proxy?__accord_path=chain/orders/PO-1/documents', 'x'.repeat(50000)))
        .status,
      200,
    );
    assert.equal(
      (await send('/api/proxy?__accord_path=chain/orders/PO-1/extract', 'x'.repeat(50000))).status,
      413,
    );
    assert.equal(
      (
        await send(
          '/api/proxy?__accord_path=chain/orders/PO-1/documents/11111111-1111-4111-8111-111111111111&download=1',
        )
      ).status,
      200,
    );
    process.env.ACCORD_API_URL = 'http://backend.example';
    assert.equal((await send('/api/proxy?__accord_path=health')).status, 503);
    process.env.ACCORD_API_URL = 'https://backend.example/accord/';
    globalThis.fetch = async () =>
      new Response('<html>Bad gateway</html>', {
        status: 502,
        headers: { 'Content-Type': 'text/html' },
      });
    const unavailable = await send('/api/proxy?__accord_path=health');
    assert.equal(unavailable.status, 502);
    assert.ok(!unavailable.body.includes('<html>'));
    process.env.ACCORD_NETWORK = 'mainnet';
    process.env.ACCORD_API_URL = 'https://backend.example/accord-mainnet/';
    process.env.ACCORD_PROXY_SECRET = 'mainnet-secret';
    process.env.ACCORD_TESTNET_API_URL = 'https://backend.example/accord/';
    process.env.ACCORD_TESTNET_PROXY_SECRET = 'testnet-secret';
    globalThis.fetch = async (target, options) => {
      received.push({ target: String(target), options });
      return Response.json({ ok: true });
    };
    const count = received.length;
    assert.equal((await send('/api/proxy?__accord_path=chain/state')).status, 409);
    assert.equal(
      (await send('/api/proxy?__accord_path=chain/state', undefined, 'unknown')).status,
      400,
    );
    assert.equal(received.length, count);
    assert.equal(
      (await send('/api/proxy?__accord_path=chain/state', undefined, 'mainnet')).status,
      200,
    );
    assert.equal(received.at(-1)!.target, 'https://backend.example/accord-mainnet/api/chain/state');
    assert.equal(
      (received.at(-1)!.options!.headers as Record<string, string>)['x-accord-proxy-secret'],
      'mainnet-secret',
    );
    assert.equal(
      (await send('/api/proxy?__accord_path=chain/state', undefined, 'testnet')).status,
      200,
    );
    assert.equal(received.at(-1)!.target, 'https://backend.example/accord/api/chain/state');
    assert.equal(
      (received.at(-1)!.options!.headers as Record<string, string>)['x-accord-proxy-secret'],
      'testnet-secret',
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    globalThis.fetch = oldFetch;
    if (oldUrl) process.env.ACCORD_API_URL = oldUrl;
    else delete process.env.ACCORD_API_URL;
    if (oldSecret) process.env.ACCORD_PROXY_SECRET = oldSecret;
    else delete process.env.ACCORD_PROXY_SECRET;
    for (const [name, value] of [
      ['ACCORD_NETWORK', oldNetwork],
      ['ACCORD_TESTNET_API_URL', oldTestnetUrl],
      ['ACCORD_TESTNET_PROXY_SECRET', oldTestnetSecret],
    ])
      if (value === undefined) delete process.env[name!];
      else process.env[name!] = value;
  }
});
