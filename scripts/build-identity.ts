import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';

export function validateRevision(revision: string): string {
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(revision)) {
    throw new Error(
      'FLIPRO_BUILD_REVISION must be a full 40- or 64-character hexadecimal Git hash',
    );
  }
  return revision.toLowerCase();
}

export function resolveBuildIdentity(root: string, suppliedRevision?: string) {
  const supplied = suppliedRevision === undefined ? undefined : validateRevision(suppliedRevision);
  const { name, version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
    name: string;
    version: string;
  };
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', root, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  let checkout = false;
  let revision = 'unknown';
  try {
    checkout = realpathSync(git('rev-parse', '--show-toplevel')) === realpathSync(root);
    if (checkout) {
      const head = validateRevision(git('rev-parse', '--verify', 'HEAD'));
      const dirty = git(
        'status',
        '--porcelain=v1',
        '--untracked-files=all',
        '--ignore-submodules=none',
      );
      revision = `${head}${dirty ? '-dirty' : ''}`;
      if (supplied !== undefined && supplied !== head) {
        throw new Error('FLIPRO_BUILD_REVISION does not match checkout HEAD');
      }
    }
  } catch (error) {
    // A supplied revision must never bypass unreadable/broken checkout metadata.
    if (supplied !== undefined && (checkout || existsSync(join(root, '.git')))) throw error;
    revision = 'unknown';
  }
  if (!checkout && supplied !== undefined) revision = supplied;
  return { name, version, revision };
}
