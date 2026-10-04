import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isCatalogPath, rewriteUrl, upstreamUrl } from '../src/urls.ts';

const origin = 'http://10.77.0.3:3000';

test('rewrite URLs without losing encoded queries, templates, or fragments', () => {
  const cases = [
    ['/opds/new?x=%D0%B0&x=two+words#top', `${origin}/opds/new?x=%D0%B0&x=two+words#top`],
    ['../authors', `${origin}/opds/authors`],
    [
      'http://flibusta.is/opds/search?q={searchTerms}&page={startPage?}',
      `${origin}/opds/search?q={searchTerms}&page={startPage?}`,
    ],
    ['//static.flibusta.is:443/files/one.epub', `${origin}/_flipro/static/files/one.epub`],
    ['https://flibusta.is/opds/{searchTerms}', `${origin}/opds/{searchTerms}`],
    ['https://example.org/book', 'https://example.org/book'],
    ['https://flibusta.is.evil.example/book', 'https://flibusta.is.evil.example/book'],
    ['https://flibusta.is:9000/book', 'https://flibusta.is:9000/book'],
    ['tag:book:123', 'tag:book:123'],
    ['mailto:person@example.org', 'mailto:person@example.org'],
  ];
  for (const [input, expected] of cases)
    assert.equal(rewriteUrl(input!, 'https://flibusta.is/opds/new/', origin), expected);
});

test('upstream destinations are fixed even for suspicious paths and queries', () => {
  for (const path of [
    '/opds?q=https://evil.example',
    '//evil.example/book',
    '/%2F%2Fevil.example/',
  ]) {
    assert.equal(upstreamUrl(new URL(`${origin}${path}`)).origin, 'https://flibusta.is');
  }
  assert.equal(
    upstreamUrl(new URL(`${origin}/_flipro/static/files/a%20b.epub?q=1&q=2`)).href,
    'https://static.flibusta.is/files/a%20b.epub?q=1&q=2',
  );
});

test('catalog transformation is limited to catalog paths on the main host', () => {
  for (const path of ['/opds', '/opds/author/1', '/opds-opensearch.xml']) {
    assert.equal(isCatalogPath(new URL(`https://flibusta.is${path}`)), true);
  }
  for (const target of [
    'https://flibusta.is/b/1/fb2',
    'https://flibusta.is/opds-other.xml',
    'https://static.flibusta.is/opds',
  ]) {
    assert.equal(isCatalogPath(new URL(target)), false);
  }
});
