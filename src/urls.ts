export const MAIN_ORIGIN = 'https://flibusta.is';
export const STATIC_ORIGIN = 'https://static.flibusta.is';
export const STATIC_PREFIX = '/_flipro/static';

export function upstreamUrl(incoming: URL): URL {
  const isStatic =
    incoming.pathname === STATIC_PREFIX || incoming.pathname.startsWith(`${STATIC_PREFIX}/`);
  const target = new URL(isStatic ? STATIC_ORIGIN : MAIN_ORIGIN);
  // Assigning pathname, rather than resolving a client-supplied URL, fixes the authority.
  target.pathname = isStatic
    ? incoming.pathname.slice(STATIC_PREFIX.length) || '/'
    : incoming.pathname;
  target.search = incoming.search;
  return target;
}

export function rewriteUrl(value: string, base: string, publicOrigin: string): string {
  // URL normalizes braces in paths. Mask OpenSearch templates so they stay literal.
  let marker = 'FLIPRO_TEMPLATE_';
  while (value.includes(marker) || base.includes(marker)) marker += '_';
  const templates: string[] = [];
  const masked = value.replace(/\{[^{}]+\}/g, (template) => {
    templates.push(template);
    return `${marker}${templates.length - 1}_END`;
  });
  let target: URL;
  try {
    target = new URL(masked, base);
  } catch {
    return value;
  }
  if (!['http:', 'https:'].includes(target.protocol) || target.port) return value;
  let prefix: string;
  if (target.hostname === 'flibusta.is') prefix = '';
  else if (target.hostname === 'static.flibusta.is') prefix = STATIC_PREFIX;
  else return value;

  let rewritten = `${publicOrigin}${prefix}${target.pathname}${target.search}${target.hash}`;
  templates.forEach((template, index) => {
    rewritten = rewritten.replaceAll(`${marker}${index}_END`, template);
  });
  return rewritten;
}

export function isCatalogPath(target: URL): boolean {
  return (
    target.origin === MAIN_ORIGIN &&
    (target.pathname === '/opds' ||
      target.pathname.startsWith('/opds/') ||
      target.pathname === '/opds-opensearch.xml')
  );
}
