import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { linkSync, lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { composeAttemptEvidence } from './reviewer-attempt-evidence.mjs';
import { collectPages, sdkStepName } from './reviewer-execution-receipt.mjs';
import { readProducerBundle } from './reviewer-producer-run.mjs';
import { HOST_HANDOFF_LIMIT, QUALIFICATION_STEP, SEAL_STEP, REVIEW_WORKFLOW, readQualificationHandoff } from './reviewer-host-handoff.mjs';

export const GH_VERIFY_PIN = Object.freeze({
  version: '2.101.0', revision: '0cf1092493af067646fc5f3db9421c6a6ec9c938',
  executable: '/Users/adampoulemanos/.local/share/mise/installs/gh/2.101.0/gh_2.101.0_macOS_arm64/bin/gh',
  sha256: 'aa97dfb4a82f7c56063cdcbfaa39a738b923c1bdca29bd5a041b8e959ca38e04',
  trustedRoot: fileURLToPath(new URL('./fixtures/reviewer-host-qualification/github-trusted-root.jsonl', import.meta.url)),
  trustedRootSha256: '26b3382d5700afbcd84f980d1d5b6c52bff743dc2a8ee86b8b44c8e1245ce485',
});
const ATTESTATION_LIMIT = 2 * 1024 * 1024;
const CALLER_WORKFLOW = '.github/workflows/reviewer-host-qualification.yml';
const ISSUER = 'https://token.actions.githubusercontent.com';
const PREDICATE = 'https://slsa.dev/provenance/v1';
const fail = code => { throw new Error(`Reviewer host acquisition refused: ${code}`); };
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const exact = (value, keys) => value && !Array.isArray(value) && typeof value === 'object'
  && Object.keys(value).sort().join('|') === [...keys].sort().join('|');

function policyOf(value) {
  if (!exact(value, ['repository', 'repositoryId', 'runId', 'runAttempt', 'workflowSha', 'sourceHeadSha'])) fail('policy');
  const policy = Object.freeze({ ...value });
  if (typeof policy.repository !== 'string' || !/^knitli\/[A-Za-z0-9_.-]+$/.test(policy.repository)
    || ['knitli/.', 'knitli/..'].includes(policy.repository)
    || !Number.isSafeInteger(policy.repositoryId) || policy.repositoryId < 1
    || ['runId', 'runAttempt'].some(key => typeof policy[key] !== 'string' || !/^[1-9][0-9]{0,19}$/.test(policy[key]))
    || ['workflowSha', 'sourceHeadSha'].some(key => typeof policy[key] !== 'string' || !/^[a-f0-9]{40}$/.test(policy[key]))) fail('policy');
  return policy;
}
function fixedBytes(value, limit) {
  if (!Buffer.isBuffer(value) || value.length === 0 || value.length > limit) fail('input_limit');
  return Buffer.from(value);
}
function requirePinnedFile(path, maximum, expected) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.size > maximum || digest(readFileSync(path)) !== expected) fail('runtime_pin');
}

/** Actual offline verifier. Local macOS pin only; no PATH lookup, caller flags, credentials or unsigned fallback. */
export function verifyPinnedGhAttestation({ handoffBytes, attestationBytes, policy: supplied }) {
  const policy = policyOf(supplied);
  const handoff = fixedBytes(handoffBytes, HOST_HANDOFF_LIMIT), attestation = fixedBytes(attestationBytes, ATTESTATION_LIMIT);
  let scratch;
  try {
    if (process.platform !== 'darwin' || process.arch !== 'arm64') fail('runtime_platform');
    requirePinnedFile(GH_VERIFY_PIN.executable, 128 * 1024 * 1024, GH_VERIFY_PIN.sha256);
    requirePinnedFile(GH_VERIFY_PIN.trustedRoot, 128 * 1024, GH_VERIFY_PIN.trustedRootSha256);
    scratch = mkdtempSync(join(tmpdir(), 'reviewer-host-verify-'));
    const subject = join(scratch, 'reviewer-host-handoff.json'), bundle = join(scratch, 'attestation.json');
    writeFileSync(subject, handoff, { flag: 'wx', mode: 0o600 });
    writeFileSync(bundle, attestation, { flag: 'wx', mode: 0o600 });
    const args = ['attestation', 'verify', subject, '--bundle', bundle,
      '--custom-trusted-root', GH_VERIFY_PIN.trustedRoot, '--repo', policy.repository,
      '--cert-identity', `https://github.com/${REVIEW_WORKFLOW}@${policy.workflowSha}`,
      '--signer-digest', policy.workflowSha, '--cert-oidc-issuer', ISSUER,
      '--source-ref', 'refs/heads/main', '--source-digest', policy.sourceHeadSha,
      '--deny-self-hosted-runners', '--no-public-good', '--format', 'json'];
    const bytes = execFileSync(GH_VERIFY_PIN.executable, args, { timeout: 30_000, maxBuffer: ATTESTATION_LIMIT,
      stdio: ['ignore', 'pipe', 'pipe'], cwd: scratch,
      env: { PATH: '/usr/bin:/bin', HOME: scratch, GH_CONFIG_DIR: scratch, GH_HOST: 'github.com', GH_PROMPT_DISABLED: '1',
        GH_NO_UPDATE_NOTIFIER: '1', GH_NO_EXTENSION_UPDATE_NOTIFIER: '1' } });
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch { fail('verification_failed'); }
  finally { if (scratch) rmSync(scratch, { recursive: true, force: true }); }
}

function verifyIdentity(results, bytes, policy) {
  if (!Array.isArray(results) || results.length !== 1) fail('verification_result');
  const result = results[0]?.verificationResult, certificate = result?.signature?.certificate;
  const signer = `https://github.com/${REVIEW_WORKFLOW}@${policy.workflowSha}`;
  const expected = { issuer: ISSUER, subjectAlternativeName: signer, buildSignerURI: signer,
    buildSignerDigest: policy.workflowSha, runnerEnvironment: 'github-hosted',
    sourceRepositoryURI: `https://github.com/${policy.repository}`, sourceRepositoryIdentifier: String(policy.repositoryId),
    sourceRepositoryDigest: policy.sourceHeadSha, sourceRepositoryRef: 'refs/heads/main',
    sourceRepositoryVisibilityAtSigning: 'private', buildTrigger: 'workflow_dispatch',
    buildConfigURI: `https://github.com/${policy.repository}/${CALLER_WORKFLOW}@refs/heads/main`,
    buildConfigDigest: policy.sourceHeadSha,
    runInvocationURI: `https://github.com/${policy.repository}/actions/runs/${policy.runId}/attempts/${policy.runAttempt}` };
  if (!certificate || Object.entries(expected).some(([key, value]) => certificate[key] !== value)) fail('certificate_identity');
  const statement = result.statement;
  if (result.mediaType !== 'application/vnd.dev.sigstore.verificationresult+json;version=0.1'
    || !Array.isArray(result.verifiedTimestamps) || result.verifiedTimestamps.length === 0
    || statement?._type !== 'https://in-toto.io/Statement/v1' || statement.predicateType !== PREDICATE
    || !Array.isArray(statement.subject) || statement.subject.length !== 1
    || statement.subject[0]?.name !== 'reviewer-host-handoff.json'
    || !exact(statement.subject[0]?.digest, ['sha256']) || statement.subject[0].digest.sha256 !== digest(bytes)) fail('signed_subject');
  // Certificate extensions bind execution; workflow-controlled predicate invocation fields are never authority.
}

function sourceSnapshot(get, policy, handoff) {
  const endpoint = `repos/${policy.repository}/actions/runs/${policy.runId}/attempts/${policy.runAttempt}`;
  const run = get(endpoint);
  const refs = run?.referenced_workflows?.filter(value => value.path?.split('@')[0] === REVIEW_WORKFLOW);
  if (String(run?.id) !== policy.runId || String(run.run_attempt) !== policy.runAttempt
    || run.repository?.id !== policy.repositoryId || run.repository.full_name !== policy.repository || run.repository.private !== true
    || run.status !== 'completed' || run.conclusion !== 'success' || run.event !== 'workflow_dispatch'
    || run.head_branch !== 'main' || run.head_sha !== policy.sourceHeadSha || run.path !== CALLER_WORKFLOW
    || !refs || refs.length !== 1 || refs[0].sha !== policy.workflowSha) fail('source_run');
  const pages = collectPages(get, `${endpoint}/jobs`), total = pages[0]?.total_count, jobs = pages.flatMap(page => page.jobs);
  if (!Number.isSafeInteger(total) || total < 2 || pages.some(page => page.total_count !== total)
    || jobs.length !== total || new Set(jobs.map(job => job.id)).size !== total
    || jobs.some(job => !Number.isSafeInteger(job.id) || String(job.run_id) !== policy.runId)) fail('jobs_incomplete');
  const selected = [[handoff.attempt.checkRunId, QUALIFICATION_STEP], [handoff.sealCheckRunId, SEAL_STEP]].map(([id, stepName]) => {
    const found = jobs.filter(job => job.check_run_url === `https://api.github.com/repos/${policy.repository}/check-runs/${id}`);
    if (found.length !== 1) fail('job_identity');
    const job = found[0], steps = job.steps?.filter(step => step.name === stepName);
    if (job.status !== 'completed' || job.conclusion !== 'success' || !steps || steps.length !== 1
      || steps[0].status !== 'completed' || steps[0].conclusion !== 'success'
      || job.steps.some(step => step.name === sdkStepName)) fail('qualification_step');
    return { id: job.id, checkRunId: id, status: job.status, conclusion: job.conclusion, step: steps[0] };
  });
  return JSON.stringify({ id: run.id, attempt: run.run_attempt, head: run.head_sha, selected });
}

/** Dormant trusted-host API. get is authenticated acquisition; verify is a trusted execution port (stubbed only offline).
 * Bytes/directory may be hostile. Transport/extraction is host-owned; no archive parser or executable comes from artifacts. */
export async function acquireQualificationEvidence({ directory, outputPath, handoffBytes, attestationBytes,
  expected, get, verify = verifyPinnedGhAttestation }) {
  const policy = policyOf(expected);
  if (typeof get !== 'function' || typeof verify !== 'function' || typeof directory !== 'string' || !isAbsolute(directory)
    || typeof outputPath !== 'string' || !isAbsolute(outputPath)) fail('arguments');
  const bytes = fixedBytes(handoffBytes, HOST_HANDOFF_LIMIT), attestation = fixedBytes(attestationBytes, ATTESTATION_LIMIT);
  let stage;
  try {
    const verified = await verify({ handoffBytes: Buffer.from(bytes), attestationBytes: attestation, policy });
    verifyIdentity(verified, bytes, policy);
    const handoff = readQualificationHandoff(bytes);
    if (['repository', 'repositoryId', 'runId', 'runAttempt', 'workflowSha'].some(key => handoff.attempt[key] !== policy[key])) fail('attempt_identity');
    const before = sourceSnapshot(get, policy, handoff);
    if (readdirSync(directory).sort().join('|') !== 'completion.json|envelope.json|snapshot.json') fail('bundle_files');
    readProducerBundle(directory, handoff.envelopeSha256);
    stage = mkdtempSync(join(dirname(outputPath), '.host-acquisition-'));
    const stagedOutput = join(stage, 'evidence.json');
    const result = await composeAttemptEvidence({ directory, outputPath: stagedOutput, get,
      readTrustedHandoff: async () => ({ attempt: handoff.attempt, envelopeSha256: handoff.envelopeSha256 }) });
    if (result.status !== 'unavailable' || result.execution.reason !== 'missing-review-step'
      || result.roundCompletion !== 'unknown' || result.provenance !== 'unverified') fail('synthetic_sdk_claim');
    if (sourceSnapshot(get, policy, handoff) !== before) fail('source_changed');
    readProducerBundle(directory, handoff.envelopeSha256);
    linkSync(stagedOutput, outputPath);
    return result;
  } catch { fail('acquisition_failed'); }
  finally { if (stage) rmSync(stage, { recursive: true, force: true }); }
}
