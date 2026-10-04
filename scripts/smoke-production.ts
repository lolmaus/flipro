import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { checkVersion } from './check-version.ts';

const expectedRevision = process.env.EXPECTED_REVISION;
assert.ok(expectedRevision, 'Set EXPECTED_REVISION to the expected embedded build revision');
const { version } = JSON.parse(readFileSync('package.json', 'utf8')) as { version: string };
// Reserve an ephemeral port, then release it just before starting the real server.
const reservation = createServer();
reservation.listen(0, '127.0.0.1');
await once(reservation, 'listening');
const address = reservation.address();
assert.ok(address && typeof address !== 'string');
await new Promise<void>((resolve) => reservation.close(() => resolve()));
const localOrigin = `http://127.0.0.1:${address.port}`;
const publicOrigin = 'https://reader.example.com';
let output = '';
const child = spawn(process.execPath, ['dist/server.js'], {
  env: {
    NODE_ENV: 'production',
    PUBLIC_ORIGIN: publicOrigin,
    HOST: '127.0.0.1',
    PORT: String(address.port),
    // Deliberately hostile runtime values must not override build identity.
    FLIPRO_BUILD_REVISION: 'f'.repeat(64),
    npm_package_version: '999.0.0',
    // No Git, pnpm, or other executables are available to the application.
    PATH: '',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()));
child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString()));
const exited = once(child, 'exit');
try {
  let health: Response | undefined;
  for (let attempt = 0; attempt < 100; attempt++) {
    assert.equal(child.exitCode, null, output);
    try {
      health = await fetch(`${localOrigin}/_flipro/health`, { signal: AbortSignal.timeout(1000) });
      break;
    } catch {
      await delay(50);
    }
  }
  assert.ok(health, `Server did not become ready: ${output}`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { status: 'ok' });
  const identity = await checkVersion(localOrigin, expectedRevision, process.version);
  assert.equal(identity.version, version);
  const redirect = await fetch(localOrigin, {
    redirect: 'manual',
    headers: { 'X-Forwarded-Host': 'attacker.example.com' },
    signal: AbortSignal.timeout(5000),
  });
  assert.equal(redirect.status, 307);
  assert.equal(redirect.headers.get('location'), `${publicOrigin}/opds`);
  const startup = output
    .split('\n')
    .filter((line) => line.startsWith('{'))
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .find((event) => event.event === 'startup');
  assert.deepEqual(startup, { event: 'startup', ...identity });
  child.kill('SIGTERM');
  const stopped = await Promise.race([
    exited,
    delay(12_000, undefined, { ref: false }).then(() => {
      throw new Error(`Server did not exit after SIGTERM: ${output}`);
    }),
  ]);
  assert.deepEqual(stopped, [0, null]);
  assert.ok(output.includes('Shutting down Flipro'));
  console.log(`Production smoke checks passed: ${JSON.stringify(identity)}`);
  console.log('OK: health, immutable identity, configured-origin redirect, startup log, SIGTERM');
} finally {
  if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL');
    await exited;
  }
}
