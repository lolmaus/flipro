import assert from 'node:assert/strict';
import { DOMParser } from '@xmldom/xmldom';
import type { Document, Element } from '@xmldom/xmldom';
import { parsePublicOrigin } from '../src/config.ts';
import { upstreamUrl } from '../src/urls.ts';
import { validateVersion } from './check-version.ts';
import { selectSamples, SmokeClient, samplePath } from './smoke-probe.ts';
import type { Comparison, Evidence, Probe, ProbeOptions, Sample } from './smoke-probe.ts';

const atom = 'http://www.w3.org/2005/Atom';
const searchNamespace = 'http://a9.com/-/spec/opensearch/1.1/';
export interface SmokeOptions extends ProbeOptions {
  sample?: string;
  expectedRevision?: string;
  expectedNode?: string;
}
export interface SmokeReport {
  outcome: 'passed' | 'incomplete' | 'failed';
  exitCode: 0 | 1 | 2;
  context: SmokeClient['context'];
  stages: Array<{ stage: string; outcome: string }>;
  samples: Array<{ path: string; outcome: Comparison }>;
  evidence: Evidence[];
  problems: Array<{ stage: string; reason: string }>;
  scope: string;
}
class FailedProbe extends Error {
  readonly probe: Probe;
  constructor(probe: Probe) {
    super(probe.evidence.reason);
    this.probe = probe;
  }
}

function links(doc: Document): Element[] {
  return Array.from(doc.getElementsByTagNameNS(atom, 'link'));
}

export async function runSmoke(options: SmokeOptions): Promise<SmokeReport> {
  const origin = parsePublicOrigin(options.origin);
  const client = new SmokeClient({ ...options, origin });
  const report: SmokeReport = {
    outcome: 'incomplete',
    exitCode: 2,
    context: client.context,
    stages: [],
    samples: [],
    evidence: client.evidence,
    problems: [],
    scope:
      'Anonymous partial book prefix only; no full-book integrity, reader compatibility or authenticated-download verification.',
  };
  let failed = false;
  let stage = 'configuration';
  let last: Probe | undefined;
  let candidates: Sample[] = [];
  let selected: Sample[] = [];
  async function request(path: string, method = 'GET'): Promise<Probe> {
    last = await client.request(path, stage, 'proxy', method);
    if (last.evidence.kind !== 'ok') throw new FailedProbe(last);
    return last;
  }
  async function document(path: string): Promise<Document> {
    const probe = await request(path);
    assert.equal(probe.evidence.status, 200, 'Catalog status');
    const result = new DOMParser({
      onError() {
        throw new Error('Invalid XML');
      },
    }).parseFromString(
      new TextDecoder('utf-8', { fatal: true }).decode(probe.body),
      'application/xml',
    );
    for (const element of Array.from(result.getElementsByTagName('*'))) {
      for (const attribute of ['href', 'src', 'template']) {
        const value = element.getAttribute(attribute);
        if (value && /^https?:\/\/(?:static\.)?flibusta\.is(?:[:/]|$)/i.test(value)) {
          failed = true;
          throw new Error('Unrewritten Flibusta URL');
        }
      }
    }
    return result;
  }
  async function problem(error: unknown, local = false): Promise<void> {
    if (local && !(error instanceof FailedProbe)) failed = true;
    let reason =
      error instanceof FailedProbe
        ? error.probe.evidence.reason
        : client.signal.aborted
          ? 'Total runtime exhausted'
          : failed
            ? 'Local contract or rewriting assertion failed'
            : 'Catalog/response assertion failed';
    if (last && !local && !failed && !client.signal.aborted) {
      try {
        const direct = await client.request(
          upstreamUrl(last.url).href,
          stage,
          'upstream',
          last.evidence.method,
        );
        if (
          direct.evidence.kind !== 'ok' &&
          (direct.evidence.status === last.evidence.status ||
            ['timeout', 'connection', 'transient'].includes(direct.evidence.kind))
        ) {
          reason = `Upstream unavailable (${direct.evidence.kind}); proxy stage remains unverified`;
        } else {
          reason +=
            '; direct comparison is inconclusive (catalog bodies are transformed and requests may differ in time/context)';
        }
      } catch {
        reason += '; direct comparison could not finish within bounds';
      }
    }
    report.problems.push({ stage, reason });
    report.stages.push({ stage, outcome: failed ? 'failed' : 'incomplete' });
  }
  function passed(): void {
    report.stages.push({ stage, outcome: 'passed' });
  }

  try {
    selected = selectSamples([], origin, options.sample, client.bounds.candidates);
  } catch {
    failed = true;
    report.problems.push({ stage, reason: 'Invalid explicit acquisition sample' });
    report.outcome = 'failed';
    report.exitCode = 1;
    return report;
  }

  stage = 'health';
  try {
    const health = await request('/_flipro/health');
    assert.equal(health.evidence.status, 200);
    assert.deepEqual(JSON.parse(health.body.toString()), { status: 'ok' });
    passed();
  } catch (error) {
    await problem(error, true);
  }
  stage = 'version';
  try {
    const identity = await request('/_flipro/version');
    await validateVersion(
      new Response(new Uint8Array(identity.body), {
        status: identity.evidence.status!,
        headers: identity.headers,
      }),
      options.expectedRevision,
      options.expectedNode,
    );
    passed();
  } catch (error) {
    await problem(error, true);
  }

  try {
    stage = 'catalog';
    const root = await document('/opds');
    assert.equal(root.documentElement?.localName, 'feed');
    passed();
    stage = 'opensearch';
    const searchLink = links(root).find(
      (link) => link.getAttribute('type') === 'application/opensearchdescription+xml',
    );
    assert.ok(searchLink, 'Missing OpenSearch link');
    const searchDescription = await document(searchLink.getAttribute('href')!);
    const template = searchDescription
      .getElementsByTagNameNS(searchNamespace, 'Url')
      .item(0)
      ?.getAttribute('template');
    assert.ok(template, 'Missing search template');
    assert.ok(template.includes('{searchTerms}'), 'Missing search terms');
    passed();
    stage = 'navigation';
    const navigation = await document('/opds/new');
    const newBooksLink = links(navigation).find((link) =>
      link.getAttribute('href')?.includes('/opds/new/0/'),
    );
    assert.ok(newBooksLink, 'Missing new books navigation');
    const books = await document(newBooksLink.getAttribute('href')!);
    candidates = links(books)
      .filter((link) => link.getAttribute('rel')?.startsWith('http://opds-spec.org/acquisition'))
      .map((link) => ({
        href: link.getAttribute('href') ?? '',
        type: link.getAttribute('type') ?? '',
      }));
    // Save acquisitions before dependent checks, so a broken cover/pagination
    // does not prevent download diagnostics.
    if (options.sample === undefined)
      selected = selectSamples(candidates, origin, undefined, client.bounds.candidates);
    passed();
    stage = 'pagination';
    const next = links(books).find((link) => link.getAttribute('rel') === 'next');
    assert.ok(next, 'Missing next page');
    assert.ok(
      (await document(next.getAttribute('href')!)).getElementsByTagNameNS(atom, 'entry').length > 0,
    );
    passed();
    stage = 'cover';
    const cover = links(books).find(
      (link) => link.getAttribute('rel') === 'http://opds-spec.org/image',
    );
    assert.ok(cover, 'Missing cover');
    const coverProbe = await request(cover.getAttribute('href')!, 'HEAD');
    assert.equal(coverProbe.evidence.status, 200);
    assert.ok(coverProbe.headers.get('content-type')?.startsWith('image/'));
    passed();
    stage = 'search';
    const search = await document(
      template
        .replace('{searchTerms}', encodeURIComponent('Евгений Онегин'))
        .replace('{startPage?}', '0'),
    );
    assert.ok(search.getElementsByTagNameNS(atom, 'entry').length > 0);
    passed();
  } catch (error) {
    await problem(error);
  }

  stage = 'authentication';
  try {
    // 401 is expected at this stage, and is never retried.
    last = await client.request('/opds/polka', stage);
    assert.equal(last.evidence.status, 401);
    assert.match(last.headers.get('www-authenticate') ?? '', /^Basic /);
    passed();
  } catch (error) {
    await problem(error);
  }

  stage = 'download';
  let verified = false;
  let difference = false;
  try {
    if (!selected.length)
      report.problems.push({
        stage,
        reason: 'No advertised acquisition samples available within completed catalog stages',
      });
    for (const sample of selected) {
      const comparison = await client.compare(sample);
      report.samples.push({
        path: samplePath(new URL(sample.href, origin)),
        outcome: comparison.outcome,
      });
      if (comparison.outcome === 'proxy-defect') failed = true;
      if (comparison.outcome === 'unconfirmed-difference') difference = true;
      if (comparison.outcome === 'verified') {
        verified = true;
        break;
      }
    }
    if (verified && !failed && !difference) passed();
    else
      report.problems.push({
        stage,
        reason: failed
          ? 'Demonstrated proxy difference'
          : difference
            ? 'Unconfirmed proxy/upstream difference requires investigation'
            : 'No sample verified; upstream availability is not proxy correctness',
      });
  } catch (error) {
    await problem(error);
  }
  report.outcome = failed
    ? 'failed'
    : report.problems.length || !verified
      ? 'incomplete'
      : 'passed';
  report.exitCode = report.outcome === 'passed' ? 0 : report.outcome === 'failed' ? 1 : 2;
  return report;
}
