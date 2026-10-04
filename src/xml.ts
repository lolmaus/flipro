import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
import type { Element } from '@xmldom/xmldom';
import { rewriteUrl } from './urls.ts';

const ATOM = 'http://www.w3.org/2005/Atom';
const OPENSEARCH = 'http://a9.com/-/spec/opensearch/1.1/';
const XML = 'http://www.w3.org/XML/1998/namespace';
const XHTML = 'http://www.w3.org/1999/xhtml';

export interface RewrittenCatalog {
  xml: string;
  contentType: string;
}

export function rewriteCatalog(
  source: string,
  upstream: string,
  publicOrigin: string,
): RewrittenCatalog {
  // Catalogs need no DTDs; do not accept entity declarations or external resources.
  if (/<!DOCTYPE\b/i.test(source)) throw new Error('Catalog DTDs are unsupported');
  const document = new DOMParser({
    onError() {
      throw new Error('Invalid catalog XML');
    },
  }).parseFromString(source, 'application/xml');
  const root = document.documentElement;
  const isAtom = root?.namespaceURI === ATOM && ['feed', 'entry'].includes(root.localName ?? '');
  const isSearch = root?.namespaceURI === OPENSEARCH && root.localName === 'OpenSearchDescription';
  if (!root || (!isAtom && !isSearch)) throw new Error('Expected an Atom or OpenSearch document');

  // Iterative traversal avoids call-stack overflow on deeply nested upstream XML.
  const stack: Array<{ element: Element; base: string }> = [{ element: root, base: upstream }];
  while (stack.length) {
    const { element, base: parentBase } = stack.pop()!;
    let base = parentBase;
    const xmlBase = element.getAttributeNS(XML, 'base');
    if (xmlBase !== null) {
      base = new URL(xmlBase, parentBase).href;
      element.setAttributeNS(XML, 'xml:base', rewriteUrl(xmlBase, parentBase, publicOrigin));
    }
    const namespace = element.namespaceURI;
    const name = element.localName ?? '';

    const attributes =
      namespace === ATOM && name === 'link'
        ? ['href']
        : namespace === ATOM && name === 'content'
          ? ['src']
          : namespace === OPENSEARCH && name === 'Url'
            ? ['template']
            : namespace === XHTML
              ? ['href', 'src']
              : [];
    for (const attribute of attributes) {
      const value = element.getAttribute(attribute);
      if (value !== null) element.setAttribute(attribute, rewriteUrl(value, base, publicOrigin));
    }

    const textIsUrl =
      (namespace === ATOM && ['icon', 'logo', 'uri'].includes(name)) ||
      (namespace === OPENSEARCH && ['Image', 'SearchForm'].includes(name));
    if (textIsUrl) {
      const value = element.textContent;
      if (value) element.textContent = rewriteUrl(value.trim(), base, publicOrigin);
    }
    for (let child = element.lastChild; child; child = child.previousSibling) {
      if (child.nodeType === child.ELEMENT_NODE) stack.push({ element: child as Element, base });
    }
  }
  return {
    xml: new XMLSerializer().serializeToString(document),
    contentType: isAtom
      ? 'application/atom+xml; charset=utf-8'
      : 'application/opensearchdescription+xml; charset=utf-8',
  };
}
