export interface Config {
  publicOrigin: string;
  host: string;
  port: number;
}

export function parsePublicOrigin(value: string | undefined): string {
  if (!value) throw new Error('PUBLIC_ORIGIN is required (for example https://books.example.com)');
  const url = new URL(value);
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      'PUBLIC_ORIGIN must be an HTTP(S) origin without credentials, a path, query, or fragment',
    );
  }
  return url.origin;
}

export function readConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const port = env.PORT ?? '3000';
  if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) {
    throw new Error('PORT must be an integer between 1 and 65535');
  }
  return {
    publicOrigin: parsePublicOrigin(env.PUBLIC_ORIGIN),
    host: env.HOST || '127.0.0.1',
    port: Number(port),
  };
}
