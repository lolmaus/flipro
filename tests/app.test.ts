import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { after, before, test } from 'node:test';
import { gzipSync } from 'node:zlib';
import { serve } from '@hono/node-server';
import { createApp } from '../src/app.ts';
import type { AppOptions, RequestLog } from '../src/app.ts';
import { buildIdentity } from '../src/build-identity.ts';

const origin = 'https://books.example.com';
const feed =
  '<feed xmlns="http://www.w3.org/2005/Atom"><title>Книги</title><link href="/opds/new"/></feed>';
const book = Buffer.from([0, 1, 255, 128, 10, 80, 75]);
const fb2 = '<?xml version="1.0"?><FictionBook><body>https://flibusta.is/b/1</body></FictionBook>';
const credentials = `Basic ${Buffer.from('fixture:password').toString('base64')}`;
const received: Array<{ url: string; headers: Headers; method: string }> = [];
let fixtureOrigin: string;
let notifyStreamClosed: (() => void) | undefined;

const upstream = createServer((req, res) => {
  const path = new URL(req.url!, 'http://fixture').pathname;
  const sendFeed = () => {
    res.writeHead(200, {
      'Content-Type': 'application/atom+xml;charset=utf-8',
      'Content-Length': Buffer.byteLength(feed),
      ETag: '"original"',
      'Last-Modified': 'Sat, 03 Oct 2026 00:00:00 GMT',
      'Accept-Ranges': 'bytes',
    });
    res.end(feed);
  };
  if (path === '/main/opds' || path === '/main/opds/search') return sendFeed();
  if (path === '/main/opds/polka') {
    if (req.headers.authorization !== credentials) {
      res.writeHead(401, {
        'WWW-Authenticate': 'Basic realm="Flibusta authentication"',
        'Cache-Control': 'public, max-age=600',
      });
      return res.end('HTTP Basic: Access denied.');
    }
    res.setHeader('Set-Cookie', [
      'session=one; Domain=.flibusta.is; Path=/; HttpOnly',
      'second=two; Path=/',
    ]);
    res.setHeader('Cache-Control', 'public, max-age=600');
    return sendFeed();
  }
  if (path === '/main/b/1/epub') {
    res.writeHead(302, { Location: 'https://static.flibusta.is:443/files/book.epub' });
    return res.end();
  }
  if (path === '/main/redirect-relative') {
    res.writeHead(301, { Location: '/opds?q=%D0%B0&x=one+two' });
    return res.end();
  }
  if (path === '/static/files/book.epub' || path === '/main/i/1/cover.jpg') {
    res.setHeader('Content-Type', path.endsWith('.jpg') ? 'image/jpeg' : 'application/epub+zip');
    res.setHeader('Content-Disposition', 'attachment; filename="book.epub"');
    res.setHeader('ETag', '"book"');
    res.setHeader('Accept-Ranges', 'bytes');
    if (req.headers.range === 'bytes=1-3') {
      res.writeHead(206, { 'Content-Range': `bytes 1-3/${book.length}`, 'Content-Length': 3 });
      return res.end(book.subarray(1, 4));
    }
    res.setHeader('Content-Length', book.length);
    return res.end(book);
  }
  if (path === '/main/b/1/fb2') {
    res.writeHead(200, {
      'Content-Type': 'application/xml',
      'Content-Length': Buffer.byteLength(fb2),
    });
    return res.end(fb2);
  }
  if (path === '/main/opds/bad') return res.end('<feed');
  if (path === '/main/opds/wrong-document') return res.end('<html>Challenge</html>');
  if (path === '/main/opds/large') {
    res.setHeader('Content-Length', 1000);
    return res.end('x'.repeat(1000));
  }
  if (path === '/main/opds/chunked-large') {
    res.write('x'.repeat(40));
    return res.end('x'.repeat(40));
  }
  if (path === '/main/opds/gzip') {
    const compressed = gzipSync(feed);
    res.writeHead(200, {
      'Content-Type': 'application/atom+xml',
      'Content-Encoding': 'gzip',
      'Content-Length': compressed.length,
      ETag: '"compressed"',
    });
    return res.end(compressed);
  }
  if (path === '/main/slow-headers' || path === '/main/opds/slow-body') {
    if (path.endsWith('slow-body')) {
      res.writeHead(200);
      res.flushHeaders();
    }
    const timer = setTimeout(() => res.end(feed), 1000);
    res.once('close', () => clearTimeout(timer));
    return;
  }
  if (path === '/main/stream') {
    res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
    res.write('first');
    res.once('close', () => notifyStreamClosed?.());
    return;
  }
  if (path === '/main/denied') {
    res.writeHead(403);
    return res.end('Denied');
  }
  res.writeHead(404);
  res.end('Missing');
});

before(async () => {
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const address = upstream.address();
  assert.ok(address && typeof address !== 'string');
  fixtureOrigin = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  upstream.closeAllConnections();
  await new Promise<void>((resolve) => upstream.close(() => resolve()));
});

const fixtureFetch: typeof fetch = async (input, init) => {
  const request = new Request(input, init);
  received.push({
    url: request.url,
    headers: new Headers(request.headers),
    method: request.method,
  });
  const target = new URL(request.url);
  const local = new URL(fixtureOrigin);
  local.pathname = `${target.hostname === 'static.flibusta.is' ? '/static' : '/main'}${target.pathname}`;
  local.search = target.search;
  return fetch(new Request(local, request));
};

function app(extra: Partial<AppOptions> = {}) {
  return createApp({ publicOrigin: origin, fetch: fixtureFetch, ...extra });
}

test('root, health, and method rejection work without touching upstream', async () => {
  const server = app();
  const initial = received.length;
  const root = await server.request('/');
  assert.equal(root.status, 307);
  assert.equal(root.headers.get('location'), `${origin}/opds`);
  assert.deepEqual(await (await server.request('/_flipro/health')).json(), { status: 'ok' });
  for (const method of ['POST', 'OPTIONS', 'PUT', 'DELETE']) {
    const response = await server.request('/opds', { method });
    assert.equal(response.status, 405);
    assert.equal(response.headers.get('allow'), 'GET, HEAD');
  }
  assert.equal((await server.request('/_flipro/unknown')).status, 404);
  assert.equal(received.length, initial);
});

test('version reports local identity and the actual runtime without upstream access', async () => {
  const server = app({
    fetch: async () => {
      throw new Error('Version and health must not contact upstream');
    },
  });
  const response = await server.request('/_flipro/version');
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') ?? '', /^application\/json/);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await response.json(), { ...buildIdentity, node: process.version });
  const head = await server.request('/_flipro/version', { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
  assert.equal((await server.request('/_flipro/version', { method: 'POST' })).status, 405);
  assert.deepEqual(await (await server.request('/_flipro/health')).json(), { status: 'ok' });
});

test('catalog rewriting strips ranges and conditional validators and uses configured origin', async () => {
  const response = await app().request('https://attacker.example/opds?x=%D0%B0&x=two+words', {
    headers: {
      Range: 'bytes=1-3',
      'If-None-Match': '"original"',
      'If-Modified-Since': 'yesterday',
      'X-Forwarded-Host': 'attacker.example',
      'Proxy-Authorization': 'secret',
    },
  });
  assert.equal(response.status, 200);
  assert.match(await response.text(), /href="https:\/\/books.example.com\/opds\/new"/);
  assert.equal(received.at(-1)?.url, 'https://flibusta.is/opds?x=%D0%B0&x=two+words');
  for (const header of [
    'range',
    'if-none-match',
    'if-modified-since',
    'x-forwarded-host',
    'proxy-authorization',
    'host',
  ]) {
    assert.equal(received.at(-1)?.headers.has(header), false);
  }
  for (const header of [
    'content-length',
    'content-encoding',
    'etag',
    'last-modified',
    'accept-ranges',
  ]) {
    assert.equal(response.headers.has(header), false);
  }
});

test('upstream auth challenges, credentials, cookies, and account feeds pass through', async () => {
  const server = app();
  const anonymous = await server.request('/opds/polka');
  assert.equal(anonymous.status, 401);
  assert.equal(anonymous.headers.get('www-authenticate'), 'Basic realm="Flibusta authentication"');
  assert.equal(anonymous.headers.get('cache-control'), 'private, no-store');
  assert.equal(await anonymous.text(), 'HTTP Basic: Access denied.');
  const wrong = await server.request('/opds/polka', {
    headers: { Authorization: 'Basic invalid' },
  });
  assert.equal(wrong.status, 401);
  const authenticated = await server.request('/opds/polka', {
    headers: { Authorization: credentials, Cookie: 'session=test' },
  });
  assert.equal(authenticated.status, 200);
  assert.equal(received.at(-1)?.headers.get('authorization'), credentials);
  assert.equal(received.at(-1)?.headers.get('cookie'), 'session=test');
  assert.equal(authenticated.headers.get('cache-control'), 'private, no-store');
  assert.equal(authenticated.headers.getSetCookie().length, 2);
  assert.ok(authenticated.headers.getSetCookie().every((cookie) => !cookie.includes('Domain=')));
  await authenticated.text();
  // A new anonymous request must not inherit another reader's identity.
  assert.equal((await server.request('/opds/polka')).status, 401);
  assert.equal((await server.request('/denied')).status, 403);
});

test('redirected acquisitions stay on the proxy and credentials never reach static host', async () => {
  const server = app();
  const redirect = await server.request('/b/1/epub', { headers: { Authorization: credentials } });
  assert.equal(redirect.status, 302);
  assert.equal(redirect.headers.get('location'), `${origin}/_flipro/static/files/book.epub`);
  assert.equal(received.at(-1)?.url, 'https://flibusta.is/b/1/epub');
  const response = await server.request(redirect.headers.get('location')!, {
    headers: { Authorization: credentials, Cookie: 'session=secret' },
  });
  assert.equal(received.at(-1)?.url, 'https://static.flibusta.is/files/book.epub');
  assert.equal(received.at(-1)?.headers.has('authorization'), false);
  assert.equal(received.at(-1)?.headers.has('cookie'), false);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), book);
  assert.equal(response.headers.get('content-disposition'), 'attachment; filename="book.epub"');
  assert.equal(response.headers.get('etag'), '"book"');
  assert.equal(response.headers.get('content-length'), String(book.length));
  const relative = await server.request('/redirect-relative');
  assert.equal(relative.status, 301);
  assert.equal(relative.headers.get('location'), `${origin}/opds?q=%D0%B0&x=one+two`);
});

test('binary ranges, covers, and XML ebook contents remain unchanged', async () => {
  const server = app();
  const partial = await server.request('/_flipro/static/files/book.epub', {
    headers: { Range: 'bytes=1-3', 'If-Range': '"book"' },
  });
  assert.equal(partial.status, 206);
  assert.equal(partial.headers.get('content-range'), `bytes 1-3/${book.length}`);
  assert.equal(partial.headers.get('content-length'), '3');
  assert.equal(received.at(-1)?.headers.get('if-range'), '"book"');
  assert.deepEqual(Buffer.from(await partial.arrayBuffer()), book.subarray(1, 4));
  const cover = await server.request('/i/1/cover.jpg');
  assert.equal(cover.headers.get('content-type'), 'image/jpeg');
  assert.deepEqual(Buffer.from(await cover.arrayBuffer()), book);
  assert.equal(await (await server.request('/b/1/fb2')).text(), fb2);
  assert.equal(await (await server.request('/missing')).text(), 'Missing');
});

test('HEAD has no body and only unmodified resources retain original lengths', async () => {
  const server = app();
  const catalog = await server.request('/opds', { method: 'HEAD' });
  assert.equal(catalog.status, 200);
  assert.equal(await catalog.text(), '');
  assert.equal(catalog.headers.has('content-length'), false);
  assert.equal(catalog.headers.has('etag'), false);
  assert.equal(received.at(-1)?.method, 'HEAD');
  const binary = await server.request('/_flipro/static/files/book.epub', { method: 'HEAD' });
  assert.equal(binary.headers.get('content-length'), String(book.length));
  assert.equal(await binary.text(), '');
});

test('compressed upstream catalog is decompressed and safely rewritten', async () => {
  const response = await app().request('/opds/gzip');
  assert.equal(response.status, 200);
  assert.match(await response.text(), /books.example.com\/opds\/new/);
  assert.equal(response.headers.has('content-encoding'), false);
  assert.equal(response.headers.has('content-length'), false);
  assert.equal(response.headers.has('etag'), false);
});

test('invalid and oversized catalog responses produce 502 without upstream data', async () => {
  for (const path of ['/opds/bad', '/opds/wrong-document', '/opds/large', '/opds/chunked-large']) {
    const response = await app({ maxCatalogBytes: 64 }).request(path);
    assert.equal(response.status, 502, path);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(await response.text(), 'Unable to retrieve the Flibusta resource.\n');
  }
  const response = await app({
    fetch: async () => {
      throw new Error('Network unavailable');
    },
  }).request('/opds');
  assert.equal(response.status, 502);
});

test('header and catalog-body timeouts are bounded', async () => {
  for (const path of ['/slow-headers', '/opds/slow-body']) {
    const response = await app({ headerTimeoutMs: 80, catalogTimeoutMs: 80 }).request(path);
    assert.equal(response.status, 504, path);
    await response.text();
  }
});

test('logs omit credentials, cookies, and search parameters', async () => {
  const events: RequestLog[] = [];
  const response = await app({ log: (event) => events.push(event) }).request(
    '/opds/search?q=private-search',
    {
      headers: { Authorization: credentials, Cookie: 'private-cookie' },
    },
  );
  await response.text();
  assert.equal(events[0]?.path, '/opds/search');
  const text = JSON.stringify(events);
  for (const secret of ['private-search', 'private-cookie', credentials])
    assert.ok(!text.includes(secret));
});

test('download streams survive the header deadline and cancel when the reader disconnects', async () => {
  const server = serve({
    fetch: app({ headerTimeoutMs: 100 }).fetch,
    hostname: '127.0.0.1',
    port: 0,
  });
  if (!server.listening) await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  let deadline: ReturnType<typeof setTimeout> | undefined;
  const closed = new Promise<void>((resolve, reject) => {
    notifyStreamClosed = resolve;
    deadline = setTimeout(() => reject(new Error('Upstream stream was not canceled')), 3000);
  });
  const controller = new AbortController();
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/stream`, {
      signal: controller.signal,
    });
    const reader = response.body!.getReader();
    assert.equal(new TextDecoder().decode((await reader.read()).value), 'first');
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(controller.signal.aborted, false);
    controller.abort();
    await closed;
    reader.releaseLock();
  } finally {
    clearTimeout(deadline);
    notifyStreamClosed = undefined;
    controller.abort();
    if ('closeAllConnections' in server) server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
