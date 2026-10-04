import { execFileSync } from 'node:child_process';
import { rmSync, writeFileSync } from 'node:fs';
import { resolveBuildIdentity } from './build-identity.ts';

const identity = resolveBuildIdentity(process.cwd(), process.env.FLIPRO_BUILD_REVISION);
rmSync('dist', { recursive: true, force: true });
execFileSync(process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.json'], {
  stdio: 'inherit',
});
writeFileSync(
  'dist/build-identity.js',
  `// Generated at build time.\nexport const buildIdentity = Object.freeze(${JSON.stringify(identity)});\n`,
);
rmSync('dist/build-identity.js.map', { force: true });
console.log(`Built ${identity.name} ${identity.version} (${identity.revision})`);
