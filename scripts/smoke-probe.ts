import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { MAIN_ORIGIN, STATIC_ORIGIN, upstreamUrl } from '../src/urls.ts';

export const limits = {
  attempts: 3,
  candidates: 4,
  redirects: 5,
  probeBytes: 4096,
  documentBytes: 8 * 1024 * 1024,
  requestMs: 35_000,
  totalMs: 180_000,
  backoffMs: 500,
};
export type Kind =
  | 'ok'
  | 'unavailable'
  | 'timeout'
  | 'connection'
  | 'transient'
  | 'assertion'
  | 'policy';
export interface Evidence {
  stage: string;
  side: 'proxy' | 'upstream';
  path: string;
  attempt: number;
  hop: number;
  method: string;
  status: number | null;
  contentType: string | null;
  disposition: string | null;
  length: string | null;
  range: string | null;
  etag: string | null;
  bytes: number;
  observedBytes: number;
  complete: boolean;
  digest: string | null;
  kind: Kind;
  reason: string;
}
export interface Probe {
  evidence: Evidence;
  headers: Headers;
  body: Buffer;
  url: URL;
  chain: string[];
}
export interface Sample {
  href: string;
  type: string;
}
export type Comparison =
  | 'verified'
  | 'unavailable-sample'
  | 'upstream-timeout'
  | 'upstream-transient'
  | 'comparison-unavailable'
  | 'unconfirmed-difference'
  | 'proxy-defect';
export interface ProbeOptions {
  origin: string;
  fetch?: typeof fetch;
  signal?: AbortSignal;
  bounds?: Partial<typeof limits>;
  // Same egress still does not guarantee the same representation. Strong ETags
  // are required before attributing live differences to the proxy.
  context?: 'different-or-unknown' | 'same-egress' | 'controlled';
  onEvidence?: (evidence: Evidence) => void;
}

function hasControl(value: string): boolean {
  return Array.from(value).some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127);
}
function identify(hint: string): string | undefined {
  if (/epub/i.test(hint)) return 'epub';
  if (/fb2|fictionbook/i.test(hint)) return 'fb2';
  if (/mobi|mobipocket/i.test(hint)) return 'mobi';
  if (/pdf/i.test(hint)) return 'pdf';
  if (/djvu/i.test(hint)) return 'djvu';
  if (/zip/i.test(hint)) return 'zip';
}
function safe(value: string | null): string | null {
  return value === null
    ? null
    : Array.from(value)
        .map((char) => (hasControl(char) ? '?' : char))
        .join('')
        .slice(0, 160);
}
export function samplePath(url: URL): string {
  return safe(url.pathname)!;
}
function allowed(url: URL, side: Evidence['side'], origin: string): void {
  if (
    url.username ||
    url.password ||
    url.hash ||
    (side === 'proxy' ? url.origin !== origin : ![MAIN_ORIGIN, STATIC_ORIGIN].includes(url.origin))
  ) {
    throw new Error('Unsafe smoke destination');
  }
}
function canonical(url: URL, side: Evidence['side']): string {
  return (side === 'proxy' ? upstreamUrl(url) : url).href;
}

export function downloadProblem(
  probe: Probe,
  sample: Sample,
  maxBytes = limits.probeBytes,
): string | undefined {
  const { body, headers, evidence } = probe;
  if (![200, 206].includes(evidence.status ?? 0)) return 'HTTP response is not a download';
  if (headers.has('www-authenticate')) return 'Authentication required';
  if (!body.length) return 'Empty download prefix';
  const contentType = headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() ?? '';
  const text = new TextDecoder(body[0] === 0xff && body[1] === 0xfe ? 'utf-16le' : 'utf-8')
    .decode(body)
    .replace(/^\uFEFF/, '')
    .trimStart();
  if (
    /(?:html|json)/i.test(contentType) ||
    /^(?:<!doctype\s+html|<html\b|<head\b|<body\b)/i.test(text) ||
    /<(?:html|head)\b/i.test(text.slice(0, 1024)) ||
    /^(?:HTTP Basic:|Access denied|Forbidden|Not found|Error\b|Flibusta did not|Unable to retrieve)/i.test(
      text,
    )
  )
    return 'HTML or error page instead of book bytes';

  const disposition = headers.get('content-disposition');
  if (disposition !== null) {
    if (!/^(?:attachment|inline)(?:\s*;|$)/i.test(disposition))
      return 'Invalid Content-Disposition';
    const filenames = Array.from(
      disposition.matchAll(
        /(?:^|;)\s*filename(\*)?\s*=\s*("(?:[^"\\]|\\.)*"|[^;]*)(?=\s*(?:;|$))/gi,
      ),
    );
    const names = new Set<string>();
    if (/(?:^|;)\s*filename\*?\b/i.test(disposition) && !filenames.length)
      return 'Invalid filename metadata';
    for (const filename of filenames) {
      const name = filename[1] ? 'filename*' : 'filename';
      if (names.has(name)) return 'Duplicate filename metadata';
      names.add(name);
      let value = filename[2]!.trim();
      if (filename[1]) {
        const extended = /^(UTF-8|ISO-8859-1)'[^']*'(.*)$/i.exec(value);
        if (!extended || /%(?![0-9a-f]{2})/i.test(extended[2]!)) return 'Invalid extended filename';
        try {
          value =
            extended[1]!.toUpperCase() === 'UTF-8'
              ? decodeURIComponent(extended[2]!)
              : extended[2]!.replace(/%([0-9a-f]{2})/gi, (_match, hex: string) =>
                  String.fromCharCode(parseInt(hex, 16)),
                );
        } catch {
          return 'Invalid extended filename';
        }
      } else if (value.startsWith('"')) {
        if (!/^"(?:[^"\\]|\\.)*"$/.test(value)) return 'Invalid quoted filename';
        value = value.slice(1, -1).replace(/\\(.)/g, '$1');
      } else if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(value)) {
        return 'Invalid filename token';
      }
      if (!value.trim() || hasControl(value) || /[/\\]/.test(value))
        return 'Invalid filename metadata';
    }
  }
  const length = headers.get('content-length');
  if (length !== null) {
    if (!/^\d+$/.test(length) || !Number.isSafeInteger(Number(length)) || Number(length) <= 0)
      return 'Invalid Content-Length';
    if (Number(length) < body.length || (evidence.complete && Number(length) !== body.length))
      return 'Content-Length disagrees with received bytes';
  }
  if (headers.has('content-encoding') && headers.get('content-encoding') !== 'identity')
    return 'Unexpected encoding prevents an equivalent byte comparison';
  const range = headers.get('content-range');
  if (evidence.status === 206 || range !== null) {
    const match = /^bytes 0-(\d+)\/(\d+|\*)$/.exec(range ?? '');
    if (!match || evidence.status !== 206) return 'Invalid Content-Range';
    const end = Number(match[1]);
    if (
      !Number.isSafeInteger(end) ||
      end >= maxBytes ||
      (match[2] !== '*' && (!Number.isSafeInteger(Number(match[2])) || Number(match[2]) <= end)) ||
      (length !== null && Number(length) !== end + 1) ||
      (evidence.complete && body.length !== end + 1) ||
      body.length > end + 1
    )
      return 'Content-Range disagrees with probe';
  }

  const format =
    identify(sample.type) ??
    identify(new URL(sample.href, 'https://sample').pathname) ??
    identify(contentType);
  const zip = body.length >= 4 && body.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 3, 4]));
  if (['epub', 'zip', 'fb2'].includes(format ?? '') && zip) return;
  if (format === 'fb2' && /<(?:\w+:)?FictionBook(?:\s|>)/.test(text)) return;
  if (format === 'pdf' && body.subarray(0, 5).toString() === '%PDF-') return;
  if (format === 'mobi' && body.subarray(60, 68).toString() === 'BOOKMOBI') return;
  if (format === 'djvu' && body.subarray(0, 8).toString() === 'AT&TFORM') return;
  return 'Unsupported format or unrecognized book prefix';
}

export class SmokeClient {
  readonly origin: string;
  readonly bounds: typeof limits;
  readonly signal: AbortSignal;
  readonly evidence: Evidence[] = [];
  readonly context: NonNullable<ProbeOptions['context']>;
  private readonly fetcher: typeof fetch;
  private readonly onEvidence: ProbeOptions['onEvidence'];
  constructor(options: ProbeOptions) {
    this.origin = options.origin;
    this.bounds = { ...limits, ...options.bounds };
    for (const [key, value] of Object.entries(this.bounds)) {
      if (
        !Number.isSafeInteger(value) ||
        value < (key === 'backoffMs' ? 0 : 1) ||
        value > limits[key as keyof typeof limits]
      )
        throw new Error(`Invalid smoke bound: ${key}`);
    }
    this.signal = AbortSignal.any([
      AbortSignal.timeout(this.bounds.totalMs),
      ...(options.signal ? [options.signal] : []),
    ]);
    this.context = options.context ?? 'different-or-unknown';
    this.fetcher = options.fetch ?? globalThis.fetch;
    this.onEvidence = options.onEvidence;
  }

  private record(evidence: Evidence): void {
    this.evidence.push(evidence);
    this.onEvidence?.(evidence);
  }

  async request(
    href: string,
    stage: string,
    side: Evidence['side'] = 'proxy',
    method = 'GET',
    download?: Sample,
  ): Promise<Probe> {
    let last: Probe | undefined;
    for (let attempt = 1; attempt <= this.bounds.attempts; attempt++) {
      this.signal.throwIfAborted();
      let url = new URL(href, this.origin);
      const chain: string[] = [];
      let retry = false;
      for (let hop = 0; hop <= this.bounds.redirects; hop++) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.bounds.requestMs);
        const signal = AbortSignal.any([this.signal, controller.signal]);
        const evidence: Evidence = {
          stage,
          side,
          path: samplePath(url),
          attempt,
          hop,
          method,
          status: null,
          contentType: null,
          disposition: null,
          length: null,
          range: null,
          etag: null,
          bytes: 0,
          observedBytes: 0,
          complete: false,
          digest: null,
          kind: 'ok',
          reason: 'Response received',
        };
        let response: Response | undefined;
        let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
        let body = Buffer.alloc(0);
        let next: URL | undefined;
        try {
          allowed(url, side, this.origin);
          chain.push(canonical(url, side));
          const headers = new Headers({
            Accept: download?.type || '*/*',
            'Accept-Encoding': 'identity',
            'Accept-Language': '*',
            'User-Agent': 'flipro-smoke/1',
          });
          if (download) headers.set('Range', `bytes=0-${this.bounds.probeBytes - 1}`);
          response = await this.fetcher(url, {
            method,
            headers,
            redirect: 'manual',
            credentials: 'omit',
            signal,
          });
          evidence.status = response.status;
          evidence.contentType = safe(response.headers.get('content-type'));
          evidence.disposition = safe(response.headers.get('content-disposition'));
          evidence.length = safe(response.headers.get('content-length'));
          evidence.range = safe(response.headers.get('content-range'));
          evidence.etag = safe(response.headers.get('etag'));
          if ([301, 302, 303, 307, 308].includes(response.status)) {
            const location = response.headers.get('location');
            if (!location || hop === this.bounds.redirects) throw new Error('Invalid redirect');
            next = new URL(location, url);
            allowed(next, side, this.origin);
            evidence.reason = 'Redirect';
          } else {
            if (method !== 'HEAD' && response.body) {
              reader = response.body.getReader();
              const cancel = () => {
                void reader?.cancel().catch(() => {});
              };
              signal.addEventListener('abort', cancel, { once: true });
              const chunks: Uint8Array[] = [];
              try {
                const cap =
                  download || response.status >= 400
                    ? this.bounds.probeBytes
                    : this.bounds.documentBytes;
                while (evidence.bytes < cap) {
                  signal.throwIfAborted();
                  const { done, value } = await reader.read();
                  signal.throwIfAborted();
                  if (done) {
                    evidence.complete = true;
                    break;
                  }
                  evidence.observedBytes += value.byteLength;
                  const kept = value.subarray(0, cap - evidence.bytes);
                  chunks.push(kept);
                  evidence.bytes += kept.byteLength;
                }
                if (!download && response.status < 400 && !evidence.complete)
                  throw new Error('Document byte limit');
              } finally {
                body = Buffer.concat(chunks, evidence.bytes);
                evidence.digest = createHash('sha256').update(body).digest('hex');
                signal.removeEventListener('abort', cancel);
              }
            }
            if ([500, 502, 503, 504].includes(response.status)) {
              evidence.kind = response.status === 504 ? 'timeout' : 'transient';
              evidence.reason = 'Transient HTTP failure';
            } else if (response.status >= 400) {
              evidence.kind = 'unavailable';
              evidence.reason = [401, 403].includes(response.status)
                ? 'Authentication or access restriction'
                : 'Resource unavailable';
            } else if (download) {
              const problem = downloadProblem(
                { evidence, body, headers: response.headers, url, chain },
                download,
                this.bounds.probeBytes,
              );
              if (problem) {
                evidence.kind = 'unavailable';
                evidence.reason = problem;
              }
            }
          }
        } catch {
          next = undefined;
          evidence.kind = signal.aborted ? 'timeout' : response ? 'assertion' : 'connection';
          // Destination and redirect policy violations are permanent, not network retries.
          try {
            allowed(url, side, this.origin);
          } catch {
            evidence.kind = 'policy';
          }
          if (response && [301, 302, 303, 307, 308].includes(response.status))
            evidence.kind = 'policy';
          evidence.reason =
            evidence.kind === 'timeout'
              ? 'Request or total deadline exceeded'
              : evidence.kind === 'connection'
                ? 'Connection failure'
                : evidence.kind === 'policy'
                  ? 'Blocked or exhausted redirect/destination'
                  : 'Response body or byte limit failure';
          // A broken transport during body retrieval is transient; deterministic size limits are not.
          if (
            response &&
            evidence.kind === 'assertion' &&
            evidence.bytes < (download ? this.bounds.probeBytes : this.bounds.documentBytes)
          ) {
            evidence.kind = 'connection';
            evidence.reason = 'Response stream interrupted';
          }
        } finally {
          clearTimeout(timer);
          // Cancel even for ignored Range, redirects, errors and aborted reads. Do
          // not wait for a remote peer to acknowledge cancellation.
          if (reader) {
            void reader.cancel().catch(() => {});
            reader.releaseLock();
          } else {
            void response?.body?.cancel().catch(() => {});
          }
          controller.abort();
        }
        this.record(evidence);
        last = { evidence, body, headers: response?.headers ?? new Headers(), url, chain };
        if (next) {
          url = next;
          continue;
        }
        retry = ['connection', 'timeout', 'transient'].includes(evidence.kind);
        break;
      }
      if (!retry || attempt === this.bounds.attempts || this.signal.aborted) break;
      await delay(this.bounds.backoffMs * 2 ** (attempt - 1), undefined, { signal: this.signal });
    }
    if (!last) throw new Error('No request completed');
    return last;
  }

  async compare(sample: Sample): Promise<{ outcome: Comparison; proxy: Probe; upstream: Probe }> {
    const proxyUrl = new URL(sample.href, this.origin);
    allowed(proxyUrl, 'proxy', this.origin);
    // Both legs use anonymous GET, identical Accept, Range, User-Agent and
    // identity encoding. No credentials, cookies or response cookies are reused.
    const proxy = await this.request(proxyUrl.href, 'download', 'proxy', 'GET', sample);
    const upstream = await this.request(
      upstreamUrl(proxyUrl).href,
      'download',
      'upstream',
      'GET',
      sample,
    );
    return { outcome: compareProbes(proxy, upstream, this.context), proxy, upstream };
  }
}

export function compareProbes(
  proxy: Probe,
  upstream: Probe,
  context: SmokeClient['context'],
): Comparison {
  const p = proxy.evidence;
  const u = upstream.evidence;
  if (u.kind !== 'ok') {
    if (
      p.kind === u.kind ||
      (['transient', 'timeout', 'connection'].includes(p.kind) &&
        ['transient', 'timeout', 'connection'].includes(u.kind))
    ) {
      if (u.kind === 'timeout') return 'upstream-timeout';
      if (['connection', 'transient'].includes(u.kind)) return 'upstream-transient';
      if (p.status === u.status && p.reason === u.reason) return 'unavailable-sample';
    }
    return 'comparison-unavailable';
  }
  const metadata = [
    'content-type',
    'content-disposition',
    'content-length',
    'content-range',
    'etag',
  ];
  const same =
    p.kind === 'ok' &&
    p.status === u.status &&
    proxy.chain.join('\n') === upstream.chain.join('\n') &&
    metadata.every((name) => proxy.headers.get(name) === upstream.headers.get(name)) &&
    proxy.body.equals(upstream.body);
  if (same) return 'verified';
  const strong = upstream.headers.get('etag');
  const stable =
    context === 'controlled' ||
    (context === 'same-egress' &&
      strong !== null &&
      /^"[^"]*"$/.test(strong) &&
      !hasControl(strong) &&
      strong === proxy.headers.get('etag') &&
      canonical(proxy.url, 'proxy') === canonical(upstream.url, 'upstream'));
  return stable ? 'proxy-defect' : 'unconfirmed-difference';
}

export function selectSamples(
  samples: Sample[],
  origin: string,
  override?: string,
  count = limits.candidates,
): Sample[] {
  if (override !== undefined) {
    const url = new URL(override, origin);
    allowed(url, 'proxy', origin);
    if (
      !/^\/b\/\d+\/(?:epub|fb2|mobi|pdf|djvu|download)(?:\/(?:epub|fb2|mobi|pdf|djvu))?$/.test(
        url.pathname,
      )
    )
      throw new Error('SMOKE_SAMPLE must be a book acquisition path on PUBLIC_ORIGIN');
    return [{ href: url.href, type: '' }];
  }
  const unique = [
    ...new Map(samples.map((sample) => [new URL(sample.href, origin).href, sample])).values(),
  ];
  const selected: Sample[] = [];
  const formats = new Set<string>();
  // First take one per advertised format, then fill the remaining slots.
  for (const sample of unique) {
    allowed(new URL(sample.href, origin), 'proxy', origin);
    if (!formats.has(sample.type)) {
      selected.push(sample);
      formats.add(sample.type);
    }
    if (selected.length === count) return selected;
  }
  for (const sample of unique) {
    if (!selected.includes(sample)) selected.push(sample);
    if (selected.length === count) break;
  }
  return selected;
}
