import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { resolveBuildIdentity, validateRevision } from '../scripts/build-identity.ts';

const supplied = 'a'.repeat(40);

function fixture(t: { after: (cleanup: () => void) => void }): string {
  const root = mkdtempSync(join(tmpdir(), 'flipro-identity-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'flipro', version: '1.2.3' }));
  return root;
}

function git(root: string, ...args: string[]): string {
  return execFileSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function checkout(root: string): string {
  git(root, 'init');
  git(root, 'add', 'package.json');
  git(
    root,
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.com',
    'commit',
    '-m',
    'Fixture',
  );
  return git(root, 'rev-parse', 'HEAD');
}

test('archives report unknown unless given a validated full revision', (t) => {
  const root = fixture(t);
  assert.deepEqual(resolveBuildIdentity(root), {
    name: 'flipro',
    version: '1.2.3',
    revision: 'unknown',
  });
  for (const revision of [supplied, 'B'.repeat(64)]) {
    assert.equal(resolveBuildIdentity(root, revision).revision, revision.toLowerCase());
  }
});

test('supplied revisions reject short hashes, refs, whitespace, and injection', (t) => {
  const root = fixture(t);
  for (const revision of [
    '',
    'abc123',
    'main',
    'v1.0.0',
    'g'.repeat(40),
    ` ${supplied}`,
    `${supplied}\n`,
    'a'.repeat(41),
    "'; process.exit(1)",
  ]) {
    assert.throws(() => resolveBuildIdentity(root, revision), /full 40- or 64-character/);
  }
  assert.equal(validateRevision(supplied.toUpperCase()), supplied);
});

test('clean checkout uses HEAD and refuses a contradictory supplied revision', (t) => {
  const root = fixture(t);
  const head = checkout(root);
  assert.equal(resolveBuildIdentity(root).revision, head);
  assert.equal(resolveBuildIdentity(root, head.toUpperCase()).revision, head);
  assert.throws(() => resolveBuildIdentity(root, supplied), /does not match checkout HEAD/);
});

test('unstaged, staged, and untracked changes cannot report a clean revision', (t) => {
  const root = fixture(t);
  const head = checkout(root);
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'flipro', version: '2.0.0' }));
  assert.equal(resolveBuildIdentity(root).revision, `${head}-dirty`);
  assert.equal(resolveBuildIdentity(root).version, '2.0.0');
  git(root, 'add', 'package.json');
  assert.equal(resolveBuildIdentity(root, head).revision, `${head}-dirty`);
  git(root, 'reset', '--hard', 'HEAD');
  writeFileSync(join(root, 'extra.ts'), '// untracked source');
  assert.equal(resolveBuildIdentity(root, head).revision, `${head}-dirty`);
});

test('archive nested in another repository does not inherit the parent revision', (t) => {
  const parent = fixture(t);
  checkout(parent);
  const root = join(parent, 'archive');
  cpSync(join(parent, 'package.json'), join(root, 'package.json'));
  assert.equal(resolveBuildIdentity(root).revision, 'unknown');
  assert.equal(resolveBuildIdentity(root, supplied).revision, supplied);
});

test('broken checkout metadata cannot be bypassed with an explicit revision', (t) => {
  const root = fixture(t);
  writeFileSync(join(root, '.git'), 'gitdir: nonexistent');
  assert.equal(resolveBuildIdentity(root).revision, 'unknown');
  assert.throws(() => resolveBuildIdentity(root, supplied));
});

test('actual build embeds identity and needs no source, manifest identity, Git, or runtime variables', (t) => {
  const root = fixture(t);
  for (const path of ['src', 'scripts', 'tsconfig.json']) {
    cpSync(resolve(path), join(root, path), { recursive: true });
  }
  symlinkSync(resolve('node_modules'), join(root, 'node_modules'), 'dir');
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: 'flipro', version: '1.2.3', type: 'module' }),
  );
  const build = (revision: string | undefined) => {
    const env: NodeJS.ProcessEnv = { ...process.env, PATH: '' };
    delete env.FLIPRO_BUILD_REVISION;
    if (revision !== undefined) env.FLIPRO_BUILD_REVISION = revision;
    execFileSync(process.execPath, ['scripts/build.ts'], { cwd: root, env, stdio: 'pipe' });
  };
  build(undefined);
  assert.match(readFileSync(join(root, 'dist/build-identity.js'), 'utf8'), /"revision":"unknown"/);
  build(supplied);
  const emitted = readFileSync(join(root, 'dist/build-identity.js'), 'utf8');
  assert.throws(() => build('main'));
  assert.equal(readFileSync(join(root, 'dist/build-identity.js'), 'utf8'), emitted);
  for (const path of ['src', 'scripts', 'tsconfig.json']) {
    rmSync(join(root, path), { recursive: true, force: true });
  }
  writeFileSync(join(root, 'package.json'), '{"type":"module"}');
  for (const runtimeRevision of ['b'.repeat(40), 'invalid']) {
    const result = execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        "import { createApp } from './dist/app.js'; const app = createApp({ publicOrigin: 'https://books.example.com', fetch: () => { throw Error('No upstream'); } }); console.log(await (await app.request('/_flipro/version')).text());",
      ],
      {
        cwd: root,
        env: { PATH: '', FLIPRO_BUILD_REVISION: runtimeRevision, npm_package_version: '999.0.0' },
        encoding: 'utf8',
      },
    );
    assert.deepEqual(JSON.parse(result), {
      name: 'flipro',
      version: '1.2.3',
      revision: supplied,
      node: process.version,
    });
  }
});
