import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import proxy from '../api/proxy.ts';

test('Vercel proxy forwards only allowed API paths and replaces untrusted origin credentials', async () => {
  const oldFetch = globalThis.fetch,
    oldUrl = process.env.ACCORD_API_URL,
    oldSecret = process.env.ACCORD_PROXY_SECRET;
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
  const send = (path: string, body?: string) =>
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
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    globalThis.fetch = oldFetch;
    if (oldUrl) process.env.ACCORD_API_URL = oldUrl;
    else delete process.env.ACCORD_API_URL;
    if (oldSecret) process.env.ACCORD_PROXY_SECRET = oldSecret;
    else delete process.env.ACCORD_PROXY_SECRET;
  }
});
