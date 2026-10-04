import assert from 'node:assert/strict';
import { DOMParser } from '@xmldom/xmldom';
import type { Document, Element } from '@xmldom/xmldom';
import { parsePublicOrigin } from '../src/config.ts';

const origin = parsePublicOrigin(process.env.PUBLIC_ORIGIN);
const atom = 'http://www.w3.org/2005/Atom';
const searchNamespace = 'http://a9.com/-/spec/opensearch/1.1/';

async function request(path: string, method = 'GET'): Promise<Response> {
  const url = new URL(path, origin);
  assert.equal(url.origin, origin, 'All requests must stay on the proxy origin');
  return fetch(url, { method, redirect: 'manual', signal: AbortSignal.timeout(35_000) });
}

async function document(path: string): Promise<Document> {
  const response = await request(path);
  assert.equal(response.status, 200, path);
  const result = new DOMParser({
    onError() {
      throw new Error('Invalid live XML');
    },
  }).parseFromString(await response.text(), 'application/xml');
  for (const element of Array.from(result.getElementsByTagName('*'))) {
    for (const attribute of ['href', 'src', 'template']) {
      const value = element.getAttribute(attribute);
      if (value)
        assert.ok(
          !/^https?:\/\/(?:static\.)?flibusta\.is(?:[:/]|$)/i.test(value),
          'Unrewritten Flibusta URL',
        );
    }
  }
  return result;
}

function links(doc: Document): Element[] {
  return Array.from(doc.getElementsByTagNameNS(atom, 'link'));
}

const health = await request('/_flipro/health');
assert.equal(health.status, 200);
assert.deepEqual(await health.json(), { status: 'ok' });
const root = await document('/opds');
assert.equal(root.documentElement?.localName, 'feed');
console.log('OK: health and root catalog');

const searchLink = links(root).find(
  (link) => link.getAttribute('type') === 'application/opensearchdescription+xml',
);
assert.ok(searchLink);
const searchDescription = await document(searchLink.getAttribute('href')!);
const template = searchDescription
  .getElementsByTagNameNS(searchNamespace, 'Url')
  .item(0)
  ?.getAttribute('template');
assert.ok(template);
assert.ok(template.includes('{searchTerms}'));
console.log('OK: OpenSearch templates');

const navigation = await document('/opds/new');
const newBooksLink = links(navigation).find((link) =>
  link.getAttribute('href')?.includes('/opds/new/0/'),
);
assert.ok(newBooksLink);
const books = await document(newBooksLink.getAttribute('href')!);
const next = links(books).find((link) => link.getAttribute('rel') === 'next');
assert.ok(next);
assert.ok(
  (await document(next.getAttribute('href')!)).getElementsByTagNameNS(atom, 'entry').length > 0,
);
console.log('OK: navigation and pagination');

const cover = links(books).find(
  (link) => link.getAttribute('rel') === 'http://opds-spec.org/image',
);
assert.ok(cover);
const coverResponse = await request(cover.getAttribute('href')!, 'HEAD');
assert.equal(coverResponse.status, 200);
assert.ok(coverResponse.headers.get('content-type')?.startsWith('image/'));
console.log('OK: cover headers');

const acquisition = links(books).find(
  (link) =>
    link.getAttribute('rel')?.startsWith('http://opds-spec.org/acquisition') &&
    link.getAttribute('type') === 'application/epub+zip',
);
assert.ok(acquisition);
let downloadUrl = acquisition.getAttribute('href')!;
let download: Response | undefined;
let redirects = 0;
for (let attempt = 0; attempt < 6; attempt++) {
  download = await request(downloadUrl, 'HEAD');
  if (![301, 302, 303, 307, 308].includes(download.status)) break;
  const location = download.headers.get('location');
  assert.ok(location);
  downloadUrl = new URL(location, downloadUrl).href;
  assert.equal(new URL(downloadUrl).origin, origin);
  redirects++;
}
assert.equal(download?.status, 200);
assert.ok(download.headers.get('content-disposition')?.includes('filename'));
assert.ok(Number(download.headers.get('content-length')) > 0);
console.log(`OK: download headers (${redirects} proxy redirects, book body not fetched)`);

const shelf = await request('/opds/polka');
assert.equal(shelf.status, 401);
assert.match(shelf.headers.get('www-authenticate') ?? '', /^Basic /);
await shelf.body?.cancel();
console.log('OK: Flibusta authentication challenge');
const search = await document(
  template
    .replace('{searchTerms}', encodeURIComponent('Евгений Онегин'))
    .replace('{startPage?}', '0'),
);
assert.ok(search.getElementsByTagNameNS(atom, 'entry').length > 0);
console.log('OK: Cyrillic search');
console.log(`Live smoke checks passed: ${origin}/opds`);
