import { Hono } from 'hono';
import { proxy } from 'hono/proxy';
import { parsePublicOrigin } from './config.ts';
import { isCatalogPath, MAIN_ORIGIN, rewriteUrl, STATIC_PREFIX, upstreamUrl } from './urls.ts';
import { rewriteCatalog } from './xml.ts';

export interface RequestLog {
  method: string;
  path: string;
  status: number;
  durationMs: number;
}

export interface AppOptions {
  publicOrigin: string;
  fetch?: typeof globalThis.fetch;
  headerTimeoutMs?: number;
  catalogTimeoutMs?: number;
  maxCatalogBytes?: number;
  log?: (event: RequestLog) => void;
}

class UpstreamFailure extends Error {
  readonly status: 502 | 504;
  constructor(status: 502 | 504) {
    super(status === 504 ? 'Upstream timed out' : 'Upstream request failed');
    this.status = status;
  }
}

const conditionalHeaders = [
  'range',
  'if-range',
  'if-match',
  'if-none-match',
  'if-modified-since',
  'if-unmodified-since',
];
const forwardedHeaders = ['accept', 'accept-language', 'user-agent', ...conditionalHeaders];
const transformedHeaders = [
  'content-length',
  'content-encoding',
  'etag',
  'last-modified',
  'accept-ranges',
  'content-range',
  'content-md5',
  'digest',
  'content-digest',
  'repr-digest',
];

function requestHeaders(request: Request, target: URL, catalog: boolean): Headers {
  const headers = new Headers();
  for (const name of [
    ...forwardedHeaders,
    ...(target.origin === MAIN_ORIGIN ? ['authorization', 'cookie'] : []),
  ]) {
    const value = request.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  if (catalog) conditionalHeaders.forEach((name) => headers.delete(name));
  return headers;
}

function rewriteResponseHeaders(
  headers: Headers,
  target: URL,
  publicOrigin: string,
  privateRequest: boolean,
): void {
  const location = headers.get('location');
  if (location !== null) headers.set('location', rewriteUrl(location, target.href, publicOrigin));
  const contentLocation = headers.get('content-location');
  if (contentLocation !== null)
    headers.set('content-location', rewriteUrl(contentLocation, target.href, publicOrigin));

  const cookies = headers.getSetCookie();
  headers.delete('set-cookie');
  if (target.origin === MAIN_ORIGIN) {
    for (const cookie of cookies)
      headers.append('set-cookie', cookie.replace(/;\s*Domain=[^;]*/gi, ''));
  }
  // Upstream sometimes marks even its auth challenge public. Never let shared
  // caches reuse an authenticated response or a cookie-bearing response.
  if (privateRequest || cookies.length || headers.has('www-authenticate')) {
    headers.set('cache-control', 'private, no-store');
    headers.delete('expires');
    headers.delete('age');
  }
}

async function readCatalog(
  response: Response,
  signal: AbortSignal,
  controller: AbortController,
  timeoutMs: number,
  maxBytes: number,
): Promise<string> {
  const declaredSize = Number(response.headers.get('content-length'));
  if (declaredSize > maxBytes) throw new UpstreamFailure(502);
  if (!response.body) throw new UpstreamFailure(502);
  const reader = response.body.getReader();
  const timer = setTimeout(() => controller.abort(new UpstreamFailure(504)), timeoutMs);
  const onAbort = () => {
    void reader.cancel(signal.reason).catch(() => {});
  };
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new UpstreamFailure(502);
      chunks.push(value);
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, size));
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', onAbort);
    reader.releaseLock();
  }
}

export function createApp(options: AppOptions): Hono {
  const publicOrigin = parsePublicOrigin(options.publicOrigin);
  const fetchUpstream = options.fetch ?? globalThis.fetch;
  const headerTimeoutMs = options.headerTimeoutMs ?? 30_000;
  const catalogTimeoutMs = options.catalogTimeoutMs ?? 30_000;
  const maxCatalogBytes = options.maxCatalogBytes ?? 8 * 1024 * 1024;
  const app = new Hono();

  app.use('*', async (c, next) => {
    const started = performance.now();
    await next();
    options.log?.({
      method: c.req.method,
      path: new URL(c.req.url).pathname,
      status: c.res.status,
      durationMs: Math.round(performance.now() - started),
    });
  });

  app.all('*', async (c) => {
    const incoming = new URL(c.req.url);
    if (!['GET', 'HEAD'].includes(c.req.method)) {
      return c.text('Method not allowed\n', 405, { Allow: 'GET, HEAD' });
    }
    if (incoming.pathname === '/_flipro/health') return c.json({ status: 'ok' });
    if (incoming.pathname === '/') return c.redirect(`${publicOrigin}/opds`, 307);
    if (
      incoming.pathname.startsWith('/_flipro') &&
      incoming.pathname !== STATIC_PREFIX &&
      !incoming.pathname.startsWith(`${STATIC_PREFIX}/`)
    )
      return c.notFound();

    const target = upstreamUrl(incoming);
    const catalog = isCatalogPath(target);
    const controller = new AbortController();
    const signal = AbortSignal.any([c.req.raw.signal, controller.signal]);
    const timer = setTimeout(() => controller.abort(new UpstreamFailure(504)), headerTimeoutMs);
    let response: Response | undefined;
    try {
      // The helper handles transport headers and decompression. Force identity
      // upstream to retain lengths and byte ranges for unmodified book streams.
      response = await proxy(target, {
        method: c.req.method,
        headers: requestHeaders(c.req.raw, target, catalog),
        redirect: 'manual',
        signal,
        customFetch: (request) => {
          request.headers.set('accept-encoding', 'identity');
          return fetchUpstream(request);
        },
      });
      clearTimeout(timer);
      signal.throwIfAborted();
      rewriteResponseHeaders(
        response.headers,
        target,
        publicOrigin,
        c.req.raw.headers.has('authorization') || c.req.raw.headers.has('cookie'),
      );
      if (catalog && response.ok && response.status !== 204) {
        if (c.req.method !== 'HEAD') {
          const source = await readCatalog(
            response,
            signal,
            controller,
            catalogTimeoutMs,
            maxCatalogBytes,
          );
          const rewritten = rewriteCatalog(source, target.href, publicOrigin);
          transformedHeaders.forEach((name) => response!.headers.delete(name));
          response.headers.set('content-type', rewritten.contentType);
          return new Response(rewritten.xml, {
            status: response.status,
            headers: response.headers,
          });
        }
        transformedHeaders.forEach((name) => response!.headers.delete(name));
      }
      return response;
    } catch {
      controller.abort(controller.signal.reason ?? new UpstreamFailure(502));
      if (response?.body && !response.body.locked) void response.body.cancel().catch(() => {});
      if (c.req.raw.signal.aborted) return new Response(null, { status: 499 });
      const failure = controller.signal.reason;
      const status = failure instanceof UpstreamFailure ? failure.status : 502;
      return c.text(
        status === 504
          ? 'Flibusta did not respond in time.\n'
          : 'Unable to retrieve the Flibusta resource.\n',
        status,
        { 'Cache-Control': 'no-store' },
      );
    } finally {
      clearTimeout(timer);
    }
  });
  return app;
}
