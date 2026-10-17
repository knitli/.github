import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { access, chmod, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { prepareSyntheticProducer } from './fixtures/reviewer-host-qualification/producer.mjs';
import { sdkStepName, stepName } from './reviewer-execution-receipt.mjs';
import { captureQualificationPublication, sealQualificationHandoff, readQualificationHandoff,
  QUALIFICATION_STEP, SEAL_STEP, REVIEW_WORKFLOW } from './reviewer-host-handoff.mjs';
import { acquireQualificationEvidence, verifyPinnedGhAttestation, GH_VERIFY_PIN } from './reviewer-host-acquisition.mjs';

let root, baseInput, candidate;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const expected = () => ({ repository: 'knitli/demo', repositoryId: 1, runId: '123', runAttempt: '2',
  workflowSha: 'e'.repeat(40), sourceHeadSha: 'd'.repeat(40) });
const attempt = () => ({ repository: 'knitli/demo', repositoryId: 1, runId: '123', runAttempt: '2', checkRunId: '77',
  workflowRef: `${REVIEW_WORKFLOW}@${'e'.repeat(40)}`, workflowSha: 'e'.repeat(40), producerRevision: 'e'.repeat(40) });
const sealer = () => ({ ...attempt(), checkRunId: '88' });

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'reviewer-host-test-'));
  baseInput = await prepareSyntheticProducer({ directory: join(root, 'fixture'), attemptContext: attempt() });
  candidate = await baseInput.readCandidate();
});
after(async () => { if (root) await rm(root, { recursive: true, force: true }); });
function input(overrides = {}) {
  return { ...baseInput, outputDirectory: join(root, randomUUID()), ...overrides };
}

// Shape verified against pinned GH2.101.0/sigstore1.3.0 and a real upstream signature.
// This is an explicitly trusted verifier STUB, never cryptographic or hosted proof.
function verifierStub(bytes, policy) {
  const signer = `https://github.com/${REVIEW_WORKFLOW}@${policy.workflowSha}`;
  return [{ verificationResult: { mediaType: 'application/vnd.dev.sigstore.verificationresult+json;version=0.1',
    signature: { certificate: { issuer: 'https://token.actions.githubusercontent.com', subjectAlternativeName: signer,
      buildSignerURI: signer, buildSignerDigest: policy.workflowSha, runnerEnvironment: 'github-hosted',
      sourceRepositoryURI: `https://github.com/${policy.repository}`, sourceRepositoryIdentifier: String(policy.repositoryId),
      sourceRepositoryDigest: policy.sourceHeadSha, sourceRepositoryRef: 'refs/heads/main', sourceRepositoryVisibilityAtSigning: 'private',
      buildTrigger: 'workflow_dispatch', buildConfigURI: `https://github.com/${policy.repository}/.github/workflows/reviewer-host-qualification.yml@refs/heads/main`,
      buildConfigDigest: policy.sourceHeadSha,
      runInvocationURI: `https://github.com/${policy.repository}/actions/runs/${policy.runId}/attempts/${policy.runAttempt}` } },
    verifiedTimestamps: [{ type: 'Tlog', uri: 'https://fixture.invalid', timestamp: '2026-10-17T00:00:00Z' }],
    statement: { _type: 'https://in-toto.io/Statement/v1', predicateType: 'https://slsa.dev/provenance/v1',
      subject: [{ name: 'reviewer-host-handoff.json', digest: { sha256: hash(bytes) } }], predicate: {} } } }];
}
async function fixture({ stale = false } = {}) {
  let reads = 0;
  const options = input({ readCandidate: async () => {
    const value = structuredClone(candidate); if (stale && ++reads >= 4) value.head.sha = 'f'.repeat(40); return value;
  } });
  const host = await captureQualificationPublication(options);
  const bytes = sealQualificationHandoff({ producerOutputs: host.outputs, platformContext: sealer() });
  const policy = expected(), verification = verifierStub(bytes, policy);
  const run = { id: 123, run_attempt: 2, repository: { id: 1, full_name: 'knitli/demo', private: true },
    status: 'completed', conclusion: 'success', event: 'workflow_dispatch', head_branch: 'main', head_sha: policy.sourceHeadSha,
    path: '.github/workflows/reviewer-host-qualification.yml', referenced_workflows: [{ path: attempt().workflowRef, sha: policy.workflowSha }] };
  const jobs = ['77', '88'].map((id, index) => ({ id: index + 10, run_id: 123, status: 'completed', conclusion: 'success',
    check_run_url: `https://api.github.com/repos/knitli/demo/check-runs/${id}`, head_sha: policy.sourceHeadSha,
    steps: [{ name: index ? SEAL_STEP : QUALIFICATION_STEP, number: 1, status: 'completed', conclusion: 'success' }] }));
  const page = { total_count: 2, jobs }, calls = [];
  const acquire = { directory: options.outputDirectory, outputPath: join(root, `${randomUUID()}.json`), handoffBytes: bytes,
    attestationBytes: Buffer.from('{"TEST_ONLY_TRUSTED_VERIFIER_STUB":true}'), expected: policy,
    verify: async () => verification,
    get: endpoint => {
      calls.push(endpoint);
      if (endpoint === 'repos/knitli/demo/actions/runs/123/attempts/2') return structuredClone(run);
      if (endpoint === 'repos/knitli/demo/actions/runs/123/attempts/2/jobs?per_page=100&page=1') return structuredClone(page);
      throw new Error('unexpected API endpoint');
    } };
  return { options, host, bytes, policy, verification, run, jobs, page, calls, acquire };
}
async function rejected(h) {
  await assert.rejects(acquireQualificationEvidence(h.acquire), /acquisition_failed/);
  await assert.rejects(access(h.acquire.outputPath));
}

test('real producer callback crosses stubbed signed-channel boundary; synthetic execution remains unavailable', async () => {
  const h = await fixture();
  assert.equal(Object.isFrozen(h.host.outputs), true);
  assert.equal(h.host.outputs.envelopeSha256, hash(await readFile(join(h.options.outputDirectory, 'envelope.json'))));
  const result = await acquireQualificationEvidence(h.acquire);
  assert.equal(result.status, 'unavailable'); assert.equal(result.execution.reason, 'missing-review-step');
  assert.equal(result.provenance, 'unverified'); assert.equal(result.roundCompletion, 'unknown');
  assert.deepEqual(JSON.parse(await readFile(h.acquire.outputPath)), result);
  assert.equal(h.calls.length, 6);
  const original = await readFile(h.acquire.outputPath);
  await assert.rejects(acquireQualificationEvidence(h.acquire), /acquisition_failed/);
  assert.deepEqual(await readFile(h.acquire.outputPath), original);
});

test('host capture refuses callback override, failed producer and incomplete publication', async () => {
  const overrides = input({ onPublished: () => {} });
  await assert.rejects(captureQualificationPublication(overrides), /callback_override/);
  assert.equal(existsSync(overrides.outputDirectory), false);
  const failed = input({ runDriver: () => { throw new Error('provider-private-token'); } });
  await assert.rejects(captureQualificationPublication(failed), /producer_incomplete/);
  const collision = input({ runDriver: async args => {
    const result = await baseInput.runDriver(args); await writeFile(join(collision.outputDirectory, 'envelope.json'), '{partial'); return result;
  } });
  await assert.rejects(captureQualificationPublication(collision), /EEXIST/);
  assert.equal(await readFile(join(collision.outputDirectory, 'envelope.json'), 'utf8'), '{partial');
});

test('fresh sealer requires exact source context and distinct platform check-run identity', async () => {
  const h = await fixture();
  for (const changed of [{ checkRunId: '77' }, { runAttempt: '1' }, { runId: '124' }, { repositoryId: 2 },
    { workflowSha: 'f'.repeat(40), producerRevision: 'f'.repeat(40), workflowRef: `${REVIEW_WORKFLOW}@${'f'.repeat(40)}` }]) {
    assert.throws(() => sealQualificationHandoff({ producerOutputs: h.host.outputs, platformContext: { ...sealer(), ...changed } }), /sealer_identity/);
  }
  for (const outputs of [{ ...h.host.outputs, extra: 'provider' }, { ...h.host.outputs, attemptJson: '{' },
    { ...h.host.outputs, envelopeSha256: 'x' }, { ...h.host.outputs, attemptJson: ' '.repeat(4097) }]) {
    assert.throws(() => sealQualificationHandoff({ producerOutputs: outputs, platformContext: sealer() }));
  }
  await assert.rejects(captureQualificationPublication(input({ attemptContext: { ...attempt(), workflowRef: `${REVIEW_WORKFLOW}@main` } })), /workflow_pin/);
});

test('signed handoff parser retains immutable purpose and exact schema', async () => {
  const h = await fixture(), handoff = readQualificationHandoff(h.bytes);
  assert.equal(Object.isFrozen(handoff), true); assert.equal(Object.isFrozen(handoff.attempt), true);
  for (const change of [x => { x.schema = 'unknown'; }, x => { x.purpose = 'production'; }, x => { x.extra = true; },
    x => { x.sealCheckRunId = x.attempt.checkRunId; }, x => { x.envelopeSha256 = 'x'; }]) {
    const value = JSON.parse(h.bytes); change(value); const bytes = Buffer.from(JSON.stringify(value));
    assert.throws(() => readQualificationHandoff(bytes));
    const other = await fixture(); other.acquire.handoffBytes = bytes; other.acquire.verify = async () => verifierStub(bytes, other.policy);
    await rejected(other);
  }
  assert.throws(() => readQualificationHandoff(Buffer.from([0xff])));
});

test('certificate policy rejects forged run attempt, signer, repository and execution identity', async t => {
  const replacements = { issuer: 'https://evil.invalid', subjectAlternativeName: `https://github.com/${REVIEW_WORKFLOW}-other@${'e'.repeat(40)}`,
    buildSignerURI: `https://github.com/${REVIEW_WORKFLOW}@main`, buildSignerDigest: 'f'.repeat(40), runnerEnvironment: 'self-hosted',
    sourceRepositoryURI: 'https://github.com/knitli/other', sourceRepositoryIdentifier: '2', sourceRepositoryDigest: 'c'.repeat(40),
    sourceRepositoryRef: 'refs/heads/evil', sourceRepositoryVisibilityAtSigning: 'public', buildTrigger: 'pull_request',
    buildConfigURI: 'https://github.com/knitli/demo/.github/workflows/evil.yml@refs/heads/main', buildConfigDigest: 'c'.repeat(40),
    runInvocationURI: 'https://github.com/knitli/demo/actions/runs/123/attempts/1' };
  for (const [key, value] of Object.entries(replacements)) await t.test(key, async () => {
    const h = await fixture(); h.verification[0].verificationResult.signature.certificate[key] = value; await rejected(h);
    assert.equal(h.calls.length, 0);
  });
});

test('workflow-controlled predicate cannot supply missing certificate attempt identity', async () => {
  const h = await fixture(), result = h.verification[0].verificationResult;
  const uri = result.signature.certificate.runInvocationURI; delete result.signature.certificate.runInvocationURI;
  result.statement.predicate = { runDetails: { metadata: { invocationId: uri } } };
  await rejected(h); assert.equal(h.calls.length, 0);
});

test('verifier failure, ambiguous results and altered signed subject have no fallback', async t => {
  const cases = {
    failure: h => { h.acquire.verify = () => { throw new Error('private verifier token'); }; },
    empty: h => { h.verification.length = 0; }, duplicate: h => { h.verification.push(h.verification[0]); },
    mediaType: h => { h.verification[0].verificationResult.mediaType = 'unknown'; },
    timestamps: h => { h.verification[0].verificationResult.verifiedTimestamps = []; },
    statementType: h => { h.verification[0].verificationResult.statement._type = 'unknown'; },
    predicateType: h => { h.verification[0].verificationResult.statement.predicateType = 'unknown'; },
    subjectName: h => { h.verification[0].verificationResult.statement.subject[0].name = 'provider.json'; },
    digest: h => { h.verification[0].verificationResult.statement.subject[0].digest.sha256 = 'f'.repeat(64); },
    extraDigest: h => { h.verification[0].verificationResult.statement.subject[0].digest.sha512 = 'f'; },
    duplicateSubject: h => { h.verification[0].verificationResult.statement.subject.push(h.verification[0].verificationResult.statement.subject[0]); },
  };
  for (const [name, change] of Object.entries(cases)) await t.test(name, async () => {
    const h = await fixture(); change(h); await rejected(h); assert.equal(h.calls.length, 0);
  });
});

test('source API requires completed exact private pinned-main manual run and complete jobs', async t => {
  const cases = { attempt: h => { h.run.run_attempt = 3; }, pending: h => { h.run.status = 'in_progress'; },
    failed: h => { h.run.conclusion = 'failure'; }, repository: h => { h.run.repository.id = 2; },
    name: h => { h.run.repository.full_name = 'knitli/renamed'; }, public: h => { h.run.repository.private = false; },
    branch: h => { h.run.head_branch = 'evil'; }, event: h => { h.run.event = 'pull_request'; },
    head: h => { h.run.head_sha = 'f'.repeat(40); }, path: h => { h.run.path = '.github/workflows/evil.yml'; },
    pin: h => { h.run.referenced_workflows[0].sha = 'f'.repeat(40); },
    pages: h => { h.page.total_count = 3; }, duplicate: h => { h.jobs[1].id = h.jobs[0].id; },
    sibling: h => { h.jobs[0].check_run_url = 'https://api.github.com/repos/knitli/demo/check-runs/99'; },
    sealJob: h => { h.jobs[1].conclusion = 'failure'; },
    sdkMasquerade: h => { h.jobs[0].steps.push({ name: sdkStepName, status: 'completed', conclusion: 'success' }); },
    legacy: h => { h.jobs[0].steps[0].name = stepName; },
    missingSeal: h => { h.jobs[1].steps = []; },
    getFailure: h => { h.acquire.get = () => { throw new Error('private API token'); }; },
  };
  for (const [name, change] of Object.entries(cases)) await t.test(name, async () => {
    const h = await fixture(); change(h); await rejected(h);
    assert.ok(h.calls.length <= 2, 'source admission must refuse before entering the evidence composer');
  });
});

test('signed sibling attempt and forged bundle cannot replace captured host identity or digest', async () => {
  for (const change of [x => { x.attempt.runAttempt = '1'; }, x => { x.attempt.checkRunId = '99'; },
    x => { x.envelopeSha256 = 'f'.repeat(64); }]) {
    const h = await fixture(), value = JSON.parse(h.bytes); change(value);
    h.acquire.handoffBytes = Buffer.from(JSON.stringify(value));
    h.acquire.verify = async ({ handoffBytes }) => verifierStub(handoffBytes, h.policy);
    await rejected(h);
  }
  for (const name of ['envelope.json', 'completion.json']) {
    const h = await fixture(), path = join(h.options.outputDirectory, name);
    await chmod(path, 0o600); await writeFile(path, `${await readFile(path)} `); await rejected(h);
  }
  const h = await fixture(); await writeFile(join(h.options.outputDirectory, 'handoff.json'), h.bytes); await rejected(h);
  const link = await fixture(), path = join(link.options.outputDirectory, 'completion.json'), saved = join(root, randomUUID());
  await writeFile(saved, await readFile(path)); await rm(path); await symlink(saved, path); await rejected(link);
});

test('changed source after composition cannot publish output; stale candidate never becomes current', async () => {
  const h = await fixture(), get = h.acquire.get;
  h.acquire.get = endpoint => {
    if (h.calls.length === 4) h.jobs[1].steps[0].number = 2;
    return get(endpoint);
  };
  await rejected(h);
  const transient = await fixture(), original = transient.acquire.get;
  transient.acquire.get = endpoint => {
    if (transient.calls.length === 2) { transient.calls.push(endpoint); throw new Error('transient API error'); }
    return original(endpoint);
  };
  await rejected(transient);
  const stale = await fixture({ stale: true });
  const result = await acquireQualificationEvidence(stale.acquire);
  assert.equal(result.applicability, 'stale'); assert.equal(result.status, 'unavailable'); assert.equal(result.roundCompletion, 'unknown');
});

test('policy and bytes are copied before the verifier yields; caller mutation cannot change admission', async () => {
  const h = await fixture();
  h.acquire.verify = async ({ handoffBytes, policy }) => {
    const result = verifierStub(handoffBytes, policy);
    h.acquire.expected.runAttempt = '9'; h.acquire.handoffBytes.fill(0);
    assert.equal(Object.isFrozen(policy), true);
    return result;
  };
  assert.equal((await acquireQualificationEvidence(h.acquire)).attempt.runAttempt, '2');
});

test('invalid policy and unbounded input fail before verifier or API access', async () => {
  const h = await fixture();
  for (const changed of [{ expected: { ...h.policy, extra: true } }, { expected: { ...h.policy, repository: 'evil/demo' } },
    { expected: { ...h.policy, runAttempt: 2 } }, { handoffBytes: Buffer.alloc(4097) }, { attestationBytes: Buffer.alloc(2 * 1024 * 1024 + 1) },
    { directory: 'relative' }]) {
    await assert.rejects(acquireQualificationEvidence({ ...h.acquire, ...changed,
      verify: () => assert.fail('verifier must not run'), get: () => assert.fail('API must not run') }), /policy|input_limit|arguments/);
  }
});

test('pinned real CLI refuses unsigned bytes offline with no inherited credentials', {
  skip: process.platform !== 'darwin' || process.arch !== 'arm64' || !existsSync(GH_VERIFY_PIN.executable),
}, async () => {
  assert.equal(hash(await readFile(GH_VERIFY_PIN.executable)), GH_VERIFY_PIN.sha256);
  assert.equal(hash(await readFile(GH_VERIFY_PIN.trustedRoot)), GH_VERIFY_PIN.trustedRootSha256);
  assert.throws(() => verifyPinnedGhAttestation({ handoffBytes: Buffer.from('{}'), attestationBytes: Buffer.from('{}'), policy: expected() }),
    error => error.message === 'Reviewer host acquisition refused: verification_failed' && error.cause === undefined);
});

test('qualification contracts stay inactive outside workflow discovery and retain synthetic step labels', async () => {
  const source = await readFile(new URL('./fixtures/reviewer-host-qualification/source.yml.template', import.meta.url), 'utf8');
  const acquisition = await readFile(new URL('./fixtures/reviewer-host-qualification/acquire.yml.template', import.meta.url), 'utf8');
  assert.equal((source.match(/if: \$\{\{ false \}\}/g) ?? []).length, 2);
  assert.equal((acquisition.match(/if: \$\{\{ false \}\}/g) ?? []).length, 1);
  assert.ok(source.includes(`name: ${QUALIFICATION_STEP}`));
  assert.ok(source.includes(`name: ${SEAL_STEP}`));
  assert.ok(source.includes('actions/attest-build-provenance@4d101475d8b20a2381f78447822ac1eab6504dd8'));
  for (const template of [source, acquisition]) {
    assert.ok(template.includes('run: exit 78'));
    assert.ok(!template.includes(`name: ${sdkStepName}`));
    assert.ok(!template.includes(`name: ${stepName}`));
  }
  assert.ok(!acquisition.includes('id-token: write'));
});
