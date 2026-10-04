import { serve } from '@hono/node-server';
import { createApp } from './app.ts';
import { readConfig } from './config.ts';

const config = readConfig();
const app = createApp({
  publicOrigin: config.publicOrigin,
  log: (event) => console.log(JSON.stringify(event)),
});
const server = serve({ fetch: app.fetch, hostname: config.host, port: config.port }, () => {
  console.log(
    `Flipro listening on http://${config.host}:${config.port}; catalog: ${config.publicOrigin}/opds`,
  );
});
server.on('error', (error: NodeJS.ErrnoException) => {
  console.error(
    `Unable to listen on ${config.host}:${config.port}: ${error.code ?? 'server error'}`,
  );
  process.exitCode = 1;
});

function shutdown(): void {
  console.log('Shutting down Flipro');
  server.close(() => process.exit(0));
  if ('closeIdleConnections' in server) server.closeIdleConnections();
  setTimeout(() => {
    if ('closeAllConnections' in server) server.closeAllConnections();
    process.exit(0);
  }, 10_000).unref();
}
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
