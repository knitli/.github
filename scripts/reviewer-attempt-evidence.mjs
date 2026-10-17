import { closeSync, fsyncSync, linkSync, mkdtempSync, openSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { captureAttemptContext, readProducerBundle } from './reviewer-producer-run.mjs';
import { collectSdkExecution } from './reviewer-execution-receipt.mjs';

const fail = code => { throw new Error(`Reviewer attempt evidence refused: ${code}`); };
const equalAttempt = (a, b) => Object.keys(a).every(key => a[key] === b[key]);

/** Dormant trusted-host API. Both ports must be supplied independently of the producer bundle.
 * readTrustedHandoff acquires the protected host's exact attempt and envelope digest;
 * get acquires GitHub API responses with host-owned credentials. Neither is an untrusted plugin. */
export async function composeAttemptEvidence({ directory, outputPath, readTrustedHandoff, get }) {
  if (typeof directory !== 'string' || typeof outputPath !== 'string'
    || typeof readTrustedHandoff !== 'function' || typeof get !== 'function') fail('arguments');
  // Keep output separate even if a caller accidentally selects an existing producer artifact.
  if (['envelope.json', 'snapshot.json', 'completion.json'].some(file => resolve(outputPath) === resolve(directory, file))) fail('output_path');
  const supplied = await readTrustedHandoff();
  if (!supplied || Object.keys(supplied).sort().join('|') !== 'attempt|envelopeSha256') fail('handoff');
  const attempt = captureAttemptContext(supplied.attempt);
  const envelopeSha256 = supplied.envelopeSha256;
  const bundle = readProducerBundle(directory, envelopeSha256);
  if (!equalAttempt(attempt, bundle.attempt)) fail('attempt_mismatch');
  const execution = collectSdkExecution(get, {
    repository: attempt.repository, repositoryId: attempt.repositoryId, runId: attempt.runId, runAttempt: attempt.runAttempt,
    checkRunId: attempt.checkRunId, reviewWorkflowRef: attempt.workflowRef, collectorWorkflowRef: attempt.workflowRef,
    reviewWorkflowSha: attempt.workflowSha, collectorWorkflowSha: attempt.workflowSha, producerRevision: attempt.producerRevision,
  });
  // Acquisition ports may yield control internally; never retain a bundle that changed during acquisition.
  readProducerBundle(directory, envelopeSha256);
  const result = {
    schema: 'knitli-reviewer-attempt-evidence:v1', provenance: 'unverified', roundCompletion: 'unknown',
    status: execution.execution === 'succeeded' ? 'matched' : 'unavailable',
    attempt, envelopeSha256, executionId: bundle.envelope.executionId,
    applicability: bundle.envelope.applicability, execution,
  };
  const bytes = Buffer.from(`${JSON.stringify(result, null, 2)}\n`);
  if (bytes.length > 64 * 1024) fail('output_limit');
  const stage = mkdtempSync(join(dirname(outputPath), '.attempt-evidence-'));
  try {
    const file = join(stage, 'evidence.json'), fd = openSync(file, 'wx', 0o444);
    try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
    linkSync(file, outputPath);
  } finally { rmSync(stage, { recursive: true, force: true }); }
  return result;
}
