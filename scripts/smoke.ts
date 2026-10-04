import { parsePublicOrigin } from '../src/config.ts';
import { runSmoke } from './live-smoke.ts';

try {
  const context = process.env.SMOKE_COMPARISON_CONTEXT ?? 'different-or-unknown';
  if (!['different-or-unknown', 'same-egress'].includes(context))
    throw new Error('SMOKE_COMPARISON_CONTEXT must be different-or-unknown or same-egress');
  const report = await runSmoke({
    origin: parsePublicOrigin(process.env.PUBLIC_ORIGIN),
    ...(process.env.SMOKE_SAMPLE !== undefined ? { sample: process.env.SMOKE_SAMPLE } : {}),
    ...(process.env.EXPECTED_REVISION !== undefined
      ? { expectedRevision: process.env.EXPECTED_REVISION }
      : {}),
    ...(process.env.EXPECTED_NODE_VERSION !== undefined
      ? { expectedNode: process.env.EXPECTED_NODE_VERSION }
      : {}),
    context: context as 'different-or-unknown' | 'same-egress',
    onEvidence: (evidence) => console.log(JSON.stringify({ event: 'smoke-attempt', ...evidence })),
  });
  console.log(JSON.stringify({ event: 'smoke-result', ...report }));
  process.exitCode = report.exitCode;
} catch {
  // Never print arbitrary exception text containing URLs, query values or credentials.
  console.error(
    JSON.stringify({
      event: 'smoke-result',
      outcome: 'failed',
      exitCode: 1,
      stage: 'configuration',
      reason: 'Invalid smoke configuration or unexpected tooling error',
    }),
  );
  process.exitCode = 1;
}
