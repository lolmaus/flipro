import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DOMParser } from '@xmldom/xmldom';
import { rewriteCatalog } from '../src/xml.ts';

const origin = 'https://books.example.com';
const atom = 'http://www.w3.org/2005/Atom';

test('rewrite catalog links and nested bases while preserving identifiers and metadata', () => {
  const source = `<?xml version="1.0" encoding="utf-8"?>
    <feed xmlns="${atom}" xmlns:other="https://example.org/extension" xml:base="/opds/">
      <id>https://flibusta.is/id/unchanged</id><title>Книги &amp; авторы</title>
      <icon>/favicon.ico</icon><logo>//static.flibusta.is/logo.jpg</logo>
      <link rel="http://opds-spec.org/acquisition" href="search?q={searchTerms}&amp;page={startPage?}"/>
      <entry xml:base="authors/"><author><uri>../author/7</uri></author>
        <link href="https://flibusta.is/b/7/epub"/><link href="https://example.org/reference"/>
        <content type="text/html">&lt;p&gt;Описание &amp;amp; текст&lt;/p&gt;</content>
        <other:link href="https://flibusta.is/extension-id"/>
      </entry>
    </feed>`;
  const rewritten = rewriteCatalog(source, 'https://flibusta.is/opds', origin);
  const doc = new DOMParser().parseFromString(rewritten.xml, 'application/xml');
  const links = doc.getElementsByTagNameNS(atom, 'link');
  assert.equal(
    links.item(0)?.getAttribute('href'),
    `${origin}/opds/search?q={searchTerms}&page={startPage?}`,
  );
  assert.equal(links.item(0)?.getAttribute('rel'), 'http://opds-spec.org/acquisition');
  assert.equal(links.item(1)?.getAttribute('href'), `${origin}/b/7/epub`);
  assert.equal(links.item(2)?.getAttribute('href'), 'https://example.org/reference');
  assert.equal(
    doc.getElementsByTagNameNS(atom, 'id').item(0)?.textContent,
    'https://flibusta.is/id/unchanged',
  );
  assert.equal(doc.getElementsByTagNameNS(atom, 'title').item(0)?.textContent, 'Книги & авторы');
  assert.equal(
    doc.getElementsByTagNameNS(atom, 'uri').item(0)?.textContent,
    `${origin}/opds/author/7`,
  );
  assert.equal(
    doc.getElementsByTagNameNS(atom, 'content').item(0)?.textContent,
    '<p>Описание &amp; текст</p>',
  );
  assert.equal(
    doc.getElementsByTagNameNS(atom, 'entry').item(0)?.getAttribute('xml:base'),
    `${origin}/opds/authors/`,
  );
  assert.match(rewritten.xml, /href="https:\/\/flibusta.is\/extension-id"/);
  assert.match(rewritten.xml, /xmlns="http:\/\/www.w3.org\/2005\/Atom"/);
});

test('OpenSearch rewrites absolute templates, search forms, and image text', () => {
  const result = rewriteCatalog(
    `<OpenSearchDescription xmlns="http://a9.com/-/spec/opensearch/1.1/">
    <Url template="http://flibusta.is/opds/opensearch?searchTerm={searchTerms}&amp;pageNumber={startPage?}"/>
    <SearchForm>http://flibusta.is/booksearch</SearchForm>
    <Image>http://flibusta.is/favicon.ico</Image></OpenSearchDescription>`,
    'https://flibusta.is/opds-opensearch.xml',
    origin,
  );
  assert.match(result.xml, /searchTerm=\{searchTerms\}&amp;pageNumber=\{startPage\?\}/);
  assert.ok(!result.xml.includes('http://flibusta.is'));
  assert.equal(result.contentType, 'application/opensearchdescription+xml; charset=utf-8');
});

test('reject malformed XML, DTDs, and unexpected documents', () => {
  for (const source of [
    '<feed',
    '<feed xmlns="http://www.w3.org/2005/Atom"><entry></feed>',
    '<html><body>Challenge</body></html>',
    '<!DOCTYPE feed [<!ENTITY data SYSTEM "file:///etc/passwd">]><feed/>',
  ]) {
    assert.throws(() => rewriteCatalog(source, 'https://flibusta.is/opds', origin));
  }
});
