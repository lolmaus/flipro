import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { test } from 'node:test';
import { serve } from '@hono/node-server';
import { createApp } from '../src/app.ts';
import { runSmoke } from '../scripts/live-smoke.ts';
import { downloadProblem, limits, selectSamples, SmokeClient } from '../scripts/smoke-probe.ts';
import type { Probe, Sample } from '../scripts/smoke-probe.ts';

const epub = Buffer.concat([Buffer.from([0x50, 0x4b, 3, 4]), Buffer.alloc(12_000, 0x61)]);
const fb2 = Buffer.from('<?xml version="1.0"?><FictionBook><body>fixture</body></FictionBook>');
const atom = 'http://www.w3.org/2005/Atom';
const acquisition = 'http://opds-spec.org/acquisition';
const bounds = { requestMs: 1000, totalMs: 10_000, backoffMs: 1 };
type Handler = (req: IncomingMessage, res: ServerResponse) => void;

async function fixture(
  handler: Handler,
  mutate?: (response: Response, request: Request) => Promise<Response> | Response,
) {
  const upstream = createServer(handler);
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const address = upstream.address();
  assert.ok(address && typeof address !== 'string');
  const received: Request[] = [];
  const direct: typeof fetch = (input, init) => {
    const request = new Request(input, init);
    received.push(request);
    const url = new URL(request.url);
    assert.ok(['flibusta.is', 'static.flibusta.is'].includes(url.hostname));
    const local = new URL(`http://127.0.0.1:${address.port}`);
    local.pathname = `${url.hostname === 'static.flibusta.is' ? '/static' : '/main'}${url.pathname}`;
    local.search = url.search;
    return fetch(new Request(local, request));
  };
  let origin = 'http://127.0.0.1';
  const proxy = serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: (request) =>
      createApp({ publicOrigin: origin, fetch: direct, headerTimeoutMs: 500 }).fetch(request),
  });
  if (!proxy.listening) await once(proxy, 'listening');
  const proxyAddress = proxy.address();
  assert.ok(proxyAddress && typeof proxyAddress !== 'string');
  origin = `http://127.0.0.1:${proxyAddress.port}`;
  const fetcher: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    if (new URL(request.url).origin !== origin) return direct(request);
    const response = await fetch(request);
    return mutate ? mutate(response, request) : response;
  };
  return {
    origin,
    fetcher,
    received,
    client: (extra = {}) =>
      new SmokeClient({ origin, fetch: fetcher, bounds, context: 'controlled', ...extra }),
    async close() {
      if ('closeAllConnections' in proxy) proxy.closeAllConnections();
      upstream.closeAllConnections();
      await Promise.all([
        new Promise<void>((resolve) => proxy.close(() => resolve())),
        new Promise<void>((resolve) => upstream.close(() => resolve())),
      ]);
    },
  };
}
function stream(res: ServerResponse, body = epub) {
  res.writeHead(200, {
    'Content-Type': body === fb2 ? 'application/fb2+xml' : 'application/epub+zip',
    ETag: '"fixture"',
  });
  // Explicit writes give a streamed response with no Content-Length.
  res.write(body.subarray(0, 16));
  res.end(body.subarray(16));
}
function sample(id = 1, format = 'epub'): Sample {
  return {
    href: `/b/${id}/${format}`,
    type: format === 'epub' ? 'application/epub+zip' : 'application/fb2+xml',
  };
}

function catalogs(req: IncomingMessage, res: ServerResponse): boolean {
  const path = new URL(req.url!, 'http://fixture').pathname;
  let body: string;
  if (path === '/main/opds/polka') {
    res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="fixture"' });
    res.end('Denied');
    return true;
  }
  if (path === '/main/opds-opensearch.xml') {
    body =
      '<OpenSearchDescription xmlns="http://a9.com/-/spec/opensearch/1.1/"><Url template="https://flibusta.is/opds/search?searchTerm={searchTerms}&amp;page={startPage?}"/></OpenSearchDescription>';
  } else if (path.startsWith('/main/opds')) {
    const root = path === '/main/opds';
    const nav = path === '/main/opds/new';
    body = `<feed xmlns="${atom}"><title>fixture</title>${root ? '<link href="https://flibusta.is/opds-opensearch.xml" type="application/opensearchdescription+xml"/>' : nav ? '<link href="/opds/new/0/0"/>' : `<entry><title>book</title><link rel="${acquisition}" href="/b/1/epub" type="application/epub+zip"/><link rel="${acquisition}" href="/b/2/fb2" type="application/fb2+xml"/><link rel="http://opds-spec.org/image" href="/i/cover"/></entry><link rel="next" href="/opds/new/0/1"/>`}</feed>`;
  } else if (path === '/main/i/cover') {
    res.writeHead(200, { 'Content-Type': 'image/jpeg' });
    res.end();
    return true;
  } else return false;
  res.writeHead(200, { 'Content-Type': 'application/xml' });
  res.end(body);
  return true;
}

test('real proxy + smoke verifies streamed prefixes with optional filename and length; retries are retained', async () => {
  let hits = 0;
  const f = await fixture((req, res) => {
    if (catalogs(req, res)) return;
    if (++hits === 1) {
      res.writeHead(503);
      res.end('Temporary');
      return;
    }
    stream(res);
  });
  try {
    const report = await runSmoke({
      origin: f.origin,
      fetch: f.fetcher,
      bounds,
      context: 'controlled',
    });
    assert.equal(report.outcome, 'passed', JSON.stringify(report));
    assert.equal(report.exitCode, 0);
    const attempts = report.evidence.filter((e) => e.stage === 'download');
    assert.equal(attempts[0]?.status, 503);
    assert.equal(attempts[1]?.attempt, 2);
    assert.equal(attempts[1]?.length, null);
    assert.equal(attempts[1]?.disposition, null);
    assert.equal(attempts[1]?.bytes, limits.probeBytes);
    const requests = f.received.filter((r) => new URL(r.url).pathname === '/b/1/epub');
    for (const request of requests) {
      assert.equal(request.method, 'GET');
      assert.equal(request.headers.get('range'), 'bytes=0-4095');
      assert.equal(request.headers.get('accept-encoding'), 'identity');
      assert.equal(request.headers.get('authorization'), null);
      assert.equal(request.headers.get('cookie'), null);
    }
    assert.deepEqual([...requests[1]!.headers], [...requests[2]!.headers]);
  } finally {
    await f.close();
  }
});

test('unavailable first candidate falls back across formats; persistent HTML and auth are never retried', async () => {
  const f = await fixture((req, res) => {
    if (catalogs(req, res)) return;
    if (new URL(req.url!, 'http://fixture').pathname.endsWith('/epub')) {
      res.writeHead(200, { 'Content-Type': 'application/epub+zip' });
      res.end('<!doctype html><html>Missing</html>');
    } else stream(res, fb2);
  });
  try {
    const report = await runSmoke({
      origin: f.origin,
      fetch: f.fetcher,
      bounds,
      context: 'controlled',
    });
    assert.equal(report.outcome, 'passed', JSON.stringify(report));
    assert.deepEqual(
      report.samples.map((s) => s.outcome),
      ['unavailable-sample', 'verified'],
    );
    assert.equal(
      report.evidence.filter((e) => e.stage === 'download' && e.path.endsWith('epub')).length,
      2,
    );
    const overridden = await runSmoke({
      origin: f.origin,
      fetch: f.fetcher,
      bounds,
      sample: '/b/891685/epub?private=secret',
      context: 'controlled',
    });
    assert.equal(overridden.outcome, 'incomplete');
    assert.equal(overridden.exitCode, 2);
    assert.equal(overridden.samples.length, 1);
    assert.ok(!JSON.stringify(overridden).includes('secret'));
  } finally {
    await f.close();
  }
});

test('transient connection failures retry; exhausted upstream 5xx and timeouts remain incomplete', async () => {
  const f = await fixture((_req, res) => {
    res.writeHead(503);
    res.end('Temporary');
  });
  try {
    const client = f.client();
    const result = await client.compare(sample());
    assert.equal(result.outcome, 'upstream-transient');
    assert.equal(client.evidence.length, 6);
    assert.deepEqual(
      client.evidence.filter((e) => e.side === 'proxy').map((e) => e.attempt),
      [1, 2, 3],
    );
    let attempts = 0;
    const retry = new SmokeClient({
      origin: f.origin,
      bounds,
      fetch: async () => {
        if (++attempts < 3) throw new TypeError('secret connection information');
        return new Response(epub, { headers: { 'Content-Type': 'application/epub+zip' } });
      },
    });
    const probe = await retry.request('/b/1/epub', 'download', 'proxy', 'GET', sample());
    assert.equal(probe.evidence.kind, 'ok');
    assert.deepEqual(
      retry.evidence.map((e) => e.kind),
      ['connection', 'connection', 'ok'],
    );
    assert.ok(!JSON.stringify(retry.evidence).includes('secret'));
    const timed = new SmokeClient({
      origin: f.origin,
      bounds: { ...bounds, requestMs: 20 },
      fetch: (_input, init) =>
        new Promise((_resolve, reject) => {
          init!.signal!.addEventListener('abort', () => reject(new Error('timeout')), {
            once: true,
          });
        }),
    });
    assert.equal((await timed.compare(sample())).outcome, 'upstream-timeout');
    assert.equal(timed.evidence.length, 6);
  } finally {
    await f.close();
  }
});

test('redirects use the static mapping, relative locations and equivalent ranges; foreign destinations and loops are bounded', async () => {
  const f = await fixture((req, res) => {
    if (req.url === '/main/b/1/epub') {
      res.writeHead(302, { Location: 'https://static.flibusta.is/files/book.epub' });
      res.end();
    } else if (req.url === '/static/files/book.epub') {
      res.writeHead(307, { Location: '/files/final.epub' });
      res.end();
    } else if (req.url === '/static/files/final.epub') {
      const prefix = epub.subarray(0, limits.probeBytes);
      res.writeHead(206, {
        'Content-Type': 'application/epub+zip',
        'Content-Disposition': "attachment; filename*=UTF-8''book.epub",
        'Content-Range': `bytes 0-4095/${epub.length}`,
        'Content-Length': prefix.length,
      });
      res.end(prefix);
    } else {
      res.writeHead(302, {
        Location: req.url?.includes('/b/2/') ? 'https://attacker.example/book' : '/b/3/epub',
      });
      res.end();
    }
  });
  try {
    const client = f.client();
    const result = await client.compare(sample());
    assert.equal(result.outcome, 'verified');
    assert.equal(client.evidence.length, 6);
    assert.equal(result.proxy.evidence.range, `bytes 0-4095/${epub.length}`);
    const foreign = f.client();
    await foreign.compare(sample(2));
    assert.equal(foreign.evidence.length, 2);
    assert.ok(foreign.evidence.every((e) => e.kind === 'policy'));
    const loop = f.client();
    await loop.compare(sample(3));
    assert.equal(loop.evidence.length, (limits.redirects + 1) * 2);
    assert.equal(loop.evidence.at(-1)?.kind, 'policy');
  } finally {
    await f.close();
  }
});

test('byte cap cancels ignored Range streams through the real Hono adapter', async () => {
  const closures: string[] = [];
  const f = await fixture((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/epub+zip' });
    res.write(epub);
    const timer = setInterval(() => res.write(epub), 10);
    res.once('close', () => {
      clearInterval(timer);
      closures.push(req.url!);
    });
  });
  try {
    const client = f.client();
    assert.equal((await client.compare(sample())).outcome, 'verified');
    assert.ok(client.evidence.every((e) => e.bytes === limits.probeBytes && !e.complete));
    // The fetch transport can deliver one oversized chunk before cancellation.
    assert.ok(client.evidence.every((e) => e.observedBytes >= e.bytes));
    const deadline = AbortSignal.timeout(2000);
    while (closures.length < 2) {
      deadline.throwIfAborted();
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  } finally {
    await f.close();
  }
});

test('real response header loss and byte corruption are detected; unknown live context is inconclusive', async () => {
  for (const defect of ['header', 'length', 'bytes']) {
    const f = await fixture(
      (req, res) => {
        if (catalogs(req, res)) return;
        res.writeHead(200, {
          'Content-Type': 'application/epub+zip',
          'Content-Disposition': 'attachment; filename="book.epub"',
          'Content-Length': epub.length,
          ETag: '"fixture"',
        });
        res.end(epub);
      },
      async (response, request) => {
        if (!new URL(request.url).pathname.startsWith('/b/')) return response;
        const headers = new Headers(response.headers);
        if (defect === 'header') headers.delete('content-disposition');
        if (defect === 'length') headers.delete('content-length');
        if (defect === 'bytes') {
          const body = Buffer.from(await response.arrayBuffer());
          body[10] = 0;
          return new Response(body, { status: response.status, headers });
        }
        return new Response(response.body, { status: response.status, headers });
      },
    );
    try {
      assert.equal((await f.client().compare(sample())).outcome, 'proxy-defect', defect);
      assert.equal(
        (await f.client({ context: 'different-or-unknown' }).compare(sample())).outcome,
        'unconfirmed-difference',
      );
      assert.equal(
        (await f.client({ context: 'same-egress' }).compare(sample())).outcome,
        'proxy-defect',
      );
      const report = await runSmoke({
        origin: f.origin,
        fetch: f.fetcher,
        bounds,
        context: 'controlled',
      });
      assert.equal(report.outcome, 'failed');
      assert.equal(report.exitCode, 1);
    } finally {
      await f.close();
    }
  }
});

function metadataProbe(headers: Record<string, string>, body = epub): Probe {
  return {
    body,
    headers: new Headers(headers),
    url: new URL('https://books.example/b/1/epub'),
    chain: [],
    evidence: {
      stage: 'download',
      side: 'proxy',
      path: '/b/1/epub',
      attempt: 1,
      hop: 0,
      method: 'GET',
      status: 200,
      contentType: null,
      disposition: null,
      length: null,
      range: null,
      etag: null,
      bytes: body.length,
      observedBytes: body.length,
      complete: true,
      digest: null,
      kind: 'ok',
      reason: '',
    },
  };
}

test('metadata semantics, body signatures, sampling and credential boundaries', () => {
  assert.equal(downloadProblem(metadataProbe({}), sample()), undefined);
  assert.equal(
    downloadProblem(metadataProbe({ 'Content-Disposition': 'attachment' }), sample()),
    undefined,
  );
  for (const header of [
    'attachment; filename=""',
    'attachment; filename="../book.epub"',
    'attachment; filename="unterminated.epub',
    'attachment; filename=one.epub; filename=two.epub',
    "attachment; filename=book.epub; filename*=UTF-8''%ZZ",
    "attachment; filename*=UTF-8''%ZZ",
  ]) {
    assert.match(
      downloadProblem(metadataProbe({ 'Content-Disposition': header }), sample())!,
      /filename/i,
    );
  }
  assert.equal(
    downloadProblem(
      metadataProbe({ 'Content-Disposition': "attachment; filename*=ISO-8859-1''b%E9.epub" }),
      sample(),
    ),
    undefined,
  );
  for (const length of ['0', '-1', 'nonsense', '1', '9007199254740992']) {
    assert.match(
      downloadProblem(metadataProbe({ 'Content-Length': length }), sample())!,
      /Content-Length/,
    );
  }
  assert.match(downloadProblem(metadataProbe({ 'Content-Type': 'text/html' }), sample())!, /HTML/);
  assert.match(
    downloadProblem(metadataProbe({}, Buffer.from('Not found')), sample())!,
    /error page/,
  );
  assert.match(
    downloadProblem(metadataProbe({}, Buffer.from('not a book')), sample())!,
    /unrecognized/,
  );
  assert.equal(
    selectSamples(
      [sample(1), sample(2), sample(3, 'fb2')],
      'https://books.example',
      undefined,
      2,
    )[1]?.type,
    'application/fb2+xml',
  );
  assert.equal(
    selectSamples(
      Array.from({ length: 50 }, (_, n) => sample(n)),
      'https://books.example',
    ).length,
    limits.candidates,
  );
  for (const href of [
    'https://attacker.example/b/1/epub',
    'https://user:pass@books.example/b/1/epub',
    '/b/1/epub#secret',
  ])
    assert.throws(() => selectSamples([], 'https://books.example', href));
  assert.throws(
    () => new SmokeClient({ origin: 'https://books.example', bounds: { attempts: 1000 } }),
  );
});

test('total runtime and stalled bodies are bounded, and local contract failures have a distinct exit', async () => {
  const f = await fixture((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/epub+zip' });
    res.flushHeaders();
  });
  try {
    const client = f.client({ bounds: { ...bounds, requestMs: 20, totalMs: 60 } });
    const start = performance.now();
    await assert.rejects(() => client.compare(sample()));
    assert.ok(performance.now() - start < 1000);
    assert.ok(client.evidence.some((e) => e.kind === 'timeout'));
    const report = await runSmoke({
      origin: f.origin,
      bounds: { ...bounds, requestMs: 20, totalMs: 60 },
      fetch: f.fetcher,
    });
    assert.equal(report.outcome, 'incomplete');
    assert.equal(report.exitCode, 2);
  } finally {
    await f.close();
  }
  const contract = await fixture((req, res) => {
    if (!catalogs(req, res)) stream(res);
  });
  try {
    const report = await runSmoke({
      origin: contract.origin,
      fetch: contract.fetcher,
      bounds,
      expectedRevision: 'f'.repeat(40),
    });
    assert.equal(report.outcome, 'failed');
    assert.equal(report.exitCode, 1);
    assert.ok(report.problems.some((p) => p.stage === 'version'));
  } finally {
    await contract.close();
  }
});

test('permanent HTML, auth, missing resources, invalid metadata and unsuitable 5xx are not retried', async () => {
  for (const status of [200, 401, 403, 404, 501]) {
    const f = await fixture((_req, res) => {
      res.writeHead(status, {
        'Content-Type': 'text/html',
        ...(status === 401 ? { 'WWW-Authenticate': 'Basic realm="fixture"' } : {}),
      });
      res.end('<html>Unavailable</html>');
    });
    try {
      const client = f.client();
      assert.equal((await client.compare(sample())).outcome, 'unavailable-sample');
      assert.equal(client.evidence.length, 2, String(status));
    } finally {
      await f.close();
    }
  }
  const f = await fixture((_req, res) => {
    res.writeHead(200, {
      'Content-Type': 'application/epub+zip',
      'Content-Disposition': 'attachment; filename=""',
    });
    res.end(epub);
  });
  try {
    const client = f.client();
    assert.equal((await client.compare(sample())).outcome, 'unavailable-sample');
    assert.equal(client.evidence.length, 2);
  } finally {
    await f.close();
  }
});

test('a later good sample cannot erase a demonstrated or unconfirmed difference', async () => {
  const f = await fixture(
    (req, res) => {
      if (catalogs(req, res)) return;
      if (req.url?.endsWith('/fb2')) {
        stream(res, fb2);
        return;
      }
      res.setHeader('Content-Disposition', 'attachment; filename="book.epub"');
      stream(res);
    },
    (response, request) => {
      if (new URL(request.url).pathname !== '/b/1/epub') return response;
      const headers = new Headers(response.headers);
      headers.delete('content-disposition');
      return new Response(response.body, { status: response.status, headers });
    },
  );
  try {
    for (const context of ['controlled', 'different-or-unknown'] as const) {
      const report = await runSmoke({ origin: f.origin, fetch: f.fetcher, bounds, context });
      assert.equal(report.samples.at(-1)?.outcome, 'verified');
      assert.equal(report.outcome, context === 'controlled' ? 'failed' : 'incomplete');
      assert.notEqual(report.exitCode, 0);
    }
  } finally {
    await f.close();
  }
});

test('catalog upstream failures remain incomplete while an explicit sample is still inspected', async () => {
  const f = await fixture((req, res) => {
    if (req.url === '/main/opds') {
      res.writeHead(504);
      res.end('Unavailable');
      return;
    }
    if (catalogs(req, res)) return;
    stream(res);
  });
  try {
    const report = await runSmoke({
      origin: f.origin,
      fetch: f.fetcher,
      bounds,
      context: 'controlled',
      sample: '/b/891685/epub',
    });
    assert.equal(report.outcome, 'incomplete');
    assert.equal(report.exitCode, 2);
    assert.equal(report.samples[0]?.outcome, 'verified');
    assert.ok(
      report.problems.some(
        (p) => p.stage === 'catalog' && p.reason.includes('Upstream unavailable'),
      ),
    );
    assert.equal(report.evidence.filter((e) => e.stage === 'catalog').length, 6);
  } finally {
    await f.close();
  }
});
