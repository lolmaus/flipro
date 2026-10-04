import assert from 'node:assert/strict';

export async function checkVersion(
  origin: string,
  expectedRevision?: string,
  expectedNode?: string,
) {
  const response = await fetch(new URL('/_flipro/version', origin), {
    redirect: 'manual',
    signal: AbortSignal.timeout(5000),
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') ?? '', /^application\/json/);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const identity = (await response.json()) as Record<string, unknown>;
  assert.deepEqual(Object.keys(identity).toSorted(), ['name', 'node', 'revision', 'version']);
  assert.equal(identity.name, 'flipro');
  assert.equal(typeof identity.version, 'string');
  assert.equal(typeof identity.revision, 'string');
  assert.match(String(identity.revision), /^(?:unknown|(?:[0-9a-f]{40}|[0-9a-f]{64})(?:-dirty)?)$/);
  assert.match(String(identity.node), /^v\d+\.\d+\.\d+/);
  if (expectedRevision !== undefined) assert.equal(identity.revision, expectedRevision);
  if (expectedNode !== undefined) assert.equal(identity.node, expectedNode);
  return identity;
}
