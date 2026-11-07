import type { IncomingMessage, ServerResponse } from 'node:http';

type Request = IncomingMessage & { body?: unknown };
function fail(response: ServerResponse, status: number, message: string) {
  response.statusCode = status;
  response.setHeader('Content-Type', 'application/json');
  response.setHeader('Cache-Control', 'no-store');
  response.end(JSON.stringify({ error: message }));
}

export default async function proxy(request: Request, response: ServerResponse) {
  if (!['GET', 'POST'].includes(request.method ?? ''))
    return fail(response, 405, 'Method not allowed.');
  const origin = process.env.ACCORD_API_URL;
  const secret = process.env.ACCORD_PROXY_SECRET;
  if (!origin || !secret) return fail(response, 503, 'The workspace is temporarily unavailable.');
  let backend: URL;
  try {
    backend = new URL(origin);
    if (
      backend.protocol !== 'https:' ||
      backend.username ||
      backend.password ||
      backend.search ||
      backend.hash
    )
      throw new Error('Invalid API origin.');
    backend.pathname = backend.pathname.replace(/\/$/, '') + '/';
  } catch {
    return fail(response, 503, 'The workspace is temporarily unavailable.');
  }
  const url = new URL(request.url ?? '/', 'https://accord.invalid');
  const path = url.searchParams.get('__accord_path') ?? '';
  if (
    !/^(health|chain\/(state|jobs|challenge|submit|session(?:\/challenge)?|orders\/[A-Za-z0-9_-]{1,64}\/extract))$/.test(
      path,
    )
  )
    return fail(response, 404, 'Not found.');
  url.searchParams.delete('__accord_path');
  // Fixed, configured origin and a bounded path allowlist prevent this route
  // from becoming an arbitrary forwarding endpoint.
  const target = new URL('api/' + path, backend);
  target.search = url.searchParams.toString();
  const headers: Record<string, string> = {
    'x-accord-proxy-secret': secret,
    Accept: 'application/json',
  };
  for (const name of ['content-type', 'authorization', 'origin']) {
    const value = request.headers[name];
    if (typeof value === 'string') headers[name] = value;
  }
  let body: string | undefined;
  if (request.method === 'POST') {
    if (request.body !== undefined)
      body = typeof request.body === 'string' ? request.body : JSON.stringify(request.body);
    else {
      const chunks: Buffer[] = [];
      let length = 0;
      for await (const chunk of request) {
        const buffer = Buffer.from(chunk);
        length += buffer.length;
        if (length > 40000) return fail(response, 413, 'This request is too large.');
        chunks.push(buffer);
      }
      body = Buffer.concat(chunks).toString('utf8');
    }
    if (Buffer.byteLength(body) > 40000) return fail(response, 413, 'This request is too large.');
    headers['content-type'] = 'application/json';
  }
  try {
    const upstream = await fetch(target, {
      method: request.method,
      headers,
      body,
      redirect: 'error',
      signal: AbortSignal.timeout(50000),
    });
    if (!upstream.headers.get('Content-Type')?.includes('application/json'))
      return fail(response, 502, 'The workspace could not be reached. Please try again shortly.');
    response.statusCode = upstream.status;
    response.setHeader('Content-Type', 'application/json');
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('CDN-Cache-Control', 'no-store');
    response.end(await upstream.text());
  } catch {
    return fail(response, 502, 'The workspace could not be reached. Please try again shortly.');
  }
}
