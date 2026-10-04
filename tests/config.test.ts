import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parsePublicOrigin, readConfig } from '../src/config.ts';

test('configuration requires an explicit origin and validates ports', () => {
  assert.deepEqual(readConfig({ PUBLIC_ORIGIN: 'https://books.example.com/' }), {
    publicOrigin: 'https://books.example.com',
    host: '127.0.0.1',
    port: 3000,
  });
  assert.deepEqual(
    readConfig({ PUBLIC_ORIGIN: 'http://10.77.0.3:3000', HOST: '10.77.0.3', PORT: '3000' }),
    { publicOrigin: 'http://10.77.0.3:3000', host: '10.77.0.3', port: 3000 },
  );
  for (const port of ['0', '65536', '3000garbage', '-1', '3.5']) {
    assert.throws(() => readConfig({ PUBLIC_ORIGIN: 'http://localhost', PORT: port }));
  }
  for (const origin of [
    undefined,
    '',
    'file:///tmp/file',
    'https://user:pass@example.com',
    'https://example.com/prefix',
    'https://example.com?q=1',
    'https://example.com/#fragment',
  ]) {
    assert.throws(() => parsePublicOrigin(origin));
  }
});
