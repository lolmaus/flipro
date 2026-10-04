import { buildIdentity } from './build-identity.ts';

export function versionInfo() {
  return { ...buildIdentity, node: process.version };
}
