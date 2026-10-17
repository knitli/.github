import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { captureHostedContext, serializeHostOutputs, HOST_NODE_VERSION, SOURCE_LIMITS } from './reviewer-host-source.mjs';
import { REVIEW_WORKFLOW, QUALIFICATION_STEP, SEAL_STEP, readQualificationHandoff } from './reviewer-host-handoff.mjs';

const repository = fileURLToPath(new URL('../', import.meta.url));
const workflow = readFileSync(join(repository, '.github/workflows/claude-pr-reviewer.yml'), 'utf8');
const job = name => workflow.split(`\n  ${name}:\n`)[1]?.split(/\n  [a-z][a-z-]*:\n/)[0];
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const platform = revision => ({ QUAL_ENABLED: 'true', QUAL_REPOSITORY: 'knitli/knitli-site', QUAL_REPOSITORY_ID: '1058277548',
  QUAL_VISIBILITY: 'private', QUAL_EVENT: 'workflow_dispatch', QUAL_REF: 'refs/heads/main', QUAL_PROTECTED: 'true',
  QUAL_CALLER_WORKFLOW: 'knitli/knitli-site/.github/workflows/reviewer-host-qualification.yml@refs/heads/main',
  QUAL_SOURCE_SHA: 'd'.repeat(40), QUAL_RUN_ID: '123', QUAL_RUN_ATTEMPT: '2', QUAL_CHECK_RUN_ID: '77',
  QUAL_WORKFLOW_REF: `${REVIEW_WORKFLOW}@${revision}`, QUAL_WORKFLOW_SHA: revision,
  QUAL_RUNNER: 'github-hosted', QUAL_OS: 'Linux', QUAL_ARCH: 'X64', GITHUB_ACTIONS: 'true' });
let root, workspace, source, revision;
before(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'reviewer-source-test-')));
  workspace = join(root, 'workspace'); source = join(workspace, 'reviewer-host');
  mkdirSync(workspace); mkdirSync(source);
  cpSync(join(repository, 'scripts'), join(source, 'scripts'), { recursive: true });
  const git = (...args) => execFileSync('/usr/bin/git', ['-c', 'user.name=Host Test', '-c', 'user.email=host@example.invalid',
    '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', '-C', source, ...args],
  { encoding: 'utf8', timeout: 10_000, stdio: 'pipe', env: { PATH: '/usr/bin:/bin', HOME: root, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } }).trim();
  git('init', '-q'); git('add', '--all'); git('commit', '-qm', 'trusted fixture source'); revision = git('rev-parse', 'HEAD');
});
after(() => { if (root) rmSync(root, { recursive: true, force: true }); });
function host(changes = {}) {
  const temp = join(root, randomUUID()); mkdirSync(temp);
  const output = join(temp, 'set_output'); writeFileSync(output, '');
  return { temp, output, env: { PATH: '/usr/bin:/bin', HOME: root, GITHUB_WORKSPACE: workspace, RUNNER_TEMP: temp,
    GITHUB_OUTPUT: output, ...platform(revision), ...changes } };
}
function execute(mode, h) {
  return spawnSync(process.execPath, [join(source, 'scripts/reviewer-host-source.mjs'), mode], {
    env: h.env, cwd: workspace, encoding: 'utf8', timeout: 30_000, maxBuffer: 8192,
  });
}
function success(mode, h) { const result = execute(mode, h); assert.equal(result.status, 0, result.stderr); assert.equal(result.stdout, ''); }
function refused(mode, h) { const result = execute(mode, h); assert.equal(result.status, 1, result.stderr); assert.match(result.stderr, /^Reviewer host qualification refused: [a-z_]+\n$/); }
function outputs(h) { return Object.fromEntries(readFileSync(h.output, 'utf8').trim().split('\n').map(line => { const n = line.indexOf('='); return [line.slice(0, n), line.slice(n + 1)]; })); }
function sealed() {
  const attempt = captureHostedContext(platform(revision), revision);
  const h = host({ QUAL_CHECK_RUN_ID: '88', QUAL_ATTEMPT_JSON: JSON.stringify(attempt), QUAL_ENVELOPE_SHA256: 'a'.repeat(64) });
  success('seal', h); h.env.QUAL_HANDOFF_SHA256 = outputs(h).sha256;
  const directory = join(h.temp, 'action-bundle'); mkdirSync(directory);
  h.env.QUAL_ATTESTATION_BUNDLE = join(directory, 'attestation.json');
  writeFileSync(h.env.QUAL_ATTESTATION_BUNDLE, '{"unsignedTransportFixture":true}\n');
  return h;
}

test('qualification input excludes all legacy jobs while default callers retain original predicates', () => {
  assert.match(workflow, /host_qualification:\n(?:.*\n){0,4}        default: false/);
  const condition = name => {
    const text = job(name), inline = text.match(/^    if: \$\{\{ (.*) \}\}$/m);
    return inline ? inline[1] : text.match(/^    if: >-\n([\s\S]*?)\n    runs-on:/m)[1].trim();
  };
  const evaluate = (name, enabled, event, alwaysValue = true) => Function('inputs', 'github', 'always', 'contains', `return (${condition(name)});`)(
    { host_qualification: enabled, review_alias: '@knitli-review' }, event, () => alwaysValue, (text, part) => text.includes(part));
  const cases = [
    [{ event_name: 'pull_request' }, true],
    [{ event_name: 'issue_comment', event: { issue: { pull_request: {} }, comment: { body: '@knitli-review' } } }, true],
    [{ event_name: 'issue_comment', event: { issue: { pull_request: null }, comment: { body: '@knitli-review' } } }, false],
    [{ event_name: 'pull_request_review_comment', event: { comment: { body: '@knitli-review' } } }, true],
    [{ event_name: 'pull_request_review_comment', event: { comment: { body: 'unrelated' } } }, false],
    [{ event_name: 'workflow_dispatch' }, false],
  ];
  for (const [event, reviewExpected] of cases) {
    for (const enabled of [true, false]) {
      assert.equal(evaluate('sanitize', enabled, event), !enabled);
      assert.equal(evaluate('review', enabled, event), !enabled && reviewExpected);
      assert.equal(evaluate('execution-receipt', enabled, event), !enabled);
      assert.equal(evaluate('qualification-producer', enabled, event), enabled);
      assert.equal(evaluate('qualification-sealer', enabled, event), enabled);
    }
  }
  assert.match(job('execution-receipt'), /if: \$\{\{ always\(\) && !inputs.host_qualification \}\}/);
  for (const name of ['KNITLI_AGENT_CLIENT_ID', 'KNITLI_AGENT_PRIVATE_KEY', 'CLAUDE_CODE_OAUTH_TOKEN']) {
    assert.match(workflow.split('\njobs:')[0], new RegExp(`${name}:\\n        description:.*\\n        required: true`));
  }
});

test('source and sealer use pinned defining source and least privilege, without provider paths or downloaded code', () => {
  const producer = job('qualification-producer'), sealer = job('qualification-sealer');
  assert.equal(producer.match(/    permissions:\n([\s\S]*?)    outputs:/)[1], '      contents: read\n');
  assert.equal(sealer.match(/    permissions:\n([\s\S]*?)    env:/)[1], '      contents: read\n      id-token: write\n      attestations: write\n');
  assert.match(sealer, /needs: qualification-producer/);
  for (const text of [producer, sealer]) {
    assert.doesNotMatch(text, /secrets\.|secrets:|download-artifact|continue-on-error|always\(\)|claude-code-action|create-github-app-token/);
    assert.match(text, /runs-on: ubuntu-24.04/); assert.match(text, /timeout-minutes: 10/);
    assert.match(text, /actions\/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0/);
    assert.match(text, /repository: knitli\/\.github\n          ref: \$\{\{ job.workflow_sha \}\}/);
    assert.match(text, /persist-credentials: false/); assert.match(text, /submodules: false/);
    assert.match(text, /actions\/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1/);
    assert.ok(text.includes(`node-version: '${HOST_NODE_VERSION}'`));
    assert.match(text, /package-manager-cache: false/);
    assert.match(text, /QUAL_CHECK_RUN_ID: \$\{\{ job.check_run_id \}\}/);
    assert.match(text, /QUAL_WORKFLOW_REF: \$\{\{ job.workflow_ref \}\}/);
    assert.match(text, /QUAL_WORKFLOW_SHA: \$\{\{ job.workflow_sha \}\}/);
    assert.match(text, /QUAL_RUNNER: \$\{\{ runner.environment \}\}/);
    assert.match(text, /QUAL_PROTECTED: \$\{\{ github.ref_protected \}\}/);
    assert.match(text, /actions\/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02/);
    assert.match(text, /if-no-files-found: error\n          retention-days: 1\n          compression-level: 0\n          overwrite: false\n          include-hidden-files: false/);
    assert.ok(text.indexOf('Reject unsupported') < text.indexOf('uses: actions/checkout'));
  }
  assert.match(producer, /attempt-json: \$\{\{ steps.capture.outputs.attemptJson \}\}/);
  assert.match(producer, /envelope-sha256: \$\{\{ steps.capture.outputs.envelopeSha256 \}\}/);
  assert.ok(producer.includes(`name: ${QUALIFICATION_STEP}`)); assert.ok(sealer.includes(`name: ${SEAL_STEP}`));
  assert.match(sealer, /QUAL_ATTEMPT_JSON: \$\{\{ needs.qualification-producer.outputs.attempt-json \}\}/);
  assert.match(sealer, /QUAL_ENVELOPE_SHA256: \$\{\{ needs.qualification-producer.outputs.envelope-sha256 \}\}/);
  assert.match(sealer, /actions\/attest-build-provenance@4d101475d8b20a2381f78447822ac1eab6504dd8/);
  assert.match(sealer, /subject-name: reviewer-host-handoff.json\n          subject-digest: sha256:\$\{\{ steps.handoff.outputs.sha256 \}\}/);
  assert.ok(sealer.indexOf('id: attest') < sealer.indexOf('QUAL_ATTESTATION_BUNDLE:'));
  assert.match(sealer, /QUAL_ATTESTATION_BUNDLE: \$\{\{ steps.attest.outputs.bundle-path \}\}/);
  const paths = text => text.match(/          path: \|\n([\s\S]*?)          if-no-files-found:/)[1].trim().split('\n').map(x => x.trim());
  assert.deepEqual(paths(producer), ['completion', 'envelope', 'snapshot'].map(name => `\${{ runner.temp }}/reviewer-host-producer/bundle/${name}.json`));
  assert.deepEqual(paths(sealer), ['reviewer-host-handoff.json', 'attestation.sigstore.json'].map(name => `\${{ runner.temp }}/reviewer-host-sealed/${name}`));
});

test('both preflight shell guards reject unsupported platform contexts before any source checkout', () => {
  const valid = platform(revision);
  const changes = { QUAL_ENABLED: 'false', QUAL_REPOSITORY: 'other/repo', QUAL_REPOSITORY_ID: '1', QUAL_VISIBILITY: 'public',
    QUAL_EVENT: 'pull_request', QUAL_REF: 'refs/heads/other', QUAL_PROTECTED: 'false', QUAL_CALLER_WORKFLOW: 'other',
    QUAL_RUNNER: 'self-hosted', QUAL_OS: 'macOS', QUAL_ARCH: 'ARM64', QUAL_SOURCE_SHA: '', QUAL_WORKFLOW_SHA: '',
    QUAL_WORKFLOW_REF: `${REVIEW_WORKFLOW}@refs/heads/main`, QUAL_RUN_ID: '0', QUAL_RUN_ATTEMPT: 'x', QUAL_CHECK_RUN_ID: '', GITHUB_ACTIONS: 'false' };
  for (const name of ['qualification-producer', 'qualification-sealer']) {
    const shell = job(name).match(/        run: \|\n([\s\S]*?)      - name: Load only/)[1].split('\n').map(line => line.slice(10)).join('\n');
    const run = env => spawnSync('/bin/bash', ['--noprofile', '--norc', '-c', shell], { env: { HOME: root, BASH_ENV: '/dev/null', ENV: '/dev/null', PATH: '/usr/bin:/bin', ...env }, encoding: 'utf8', timeout: 5000 });
    assert.equal(run(valid).status, 0);
    for (const [key, value] of Object.entries(changes)) assert.notEqual(run({ ...valid, [key]: value }).status, 0, `${name}:${key}`);
  }
});

test('host context refuses missing, forged or unsupported identity without normalizing raw workflow refs', () => {
  const env = platform(revision), attempt = captureHostedContext(env, revision);
  assert.equal(Object.isFrozen(attempt), true); assert.equal(attempt.producerRevision, revision);
  for (const key of Object.keys(env)) assert.throws(() => captureHostedContext({ ...env, [key]: '' }, revision), undefined, key);
  for (const changes of [{ QUAL_REPOSITORY_ID: '1058277549' }, { QUAL_PROTECTED: 'false' }, { QUAL_RUNNER: 'self-hosted' },
    { QUAL_CHECK_RUN_ID: '0' }, { QUAL_RUN_ID: '1'.repeat(21) }, { QUAL_RUN_ATTEMPT: '01' },
    { QUAL_WORKFLOW_REF: `${REVIEW_WORKFLOW}@refs/heads/main` }, { QUAL_WORKFLOW_REF: `${REVIEW_WORKFLOW}-other@${revision}` }]) {
    assert.throws(() => captureHostedContext({ ...env, ...changes }, revision));
  }
  assert.throws(() => captureHostedContext(env, 'f'.repeat(40)), /platform_context/);
});

test('actual host CLI captures only publication outputs, then fresh sealer writes fixed signed subject bytes', () => {
  // Simulated platform env + real local Git/producer only; this is not a hosted/OIDC proof.
  const producer = host(); success('produce', producer);
  const values = outputs(producer); assert.deepEqual(Object.keys(values), ['attemptJson', 'envelopeSha256']);
  assert.equal(values.envelopeSha256, hash(readFileSync(join(producer.temp, 'reviewer-host-producer/bundle/envelope.json'))));
  const sealer = host({ QUAL_CHECK_RUN_ID: '88', QUAL_ATTEMPT_JSON: values.attemptJson, QUAL_ENVELOPE_SHA256: values.envelopeSha256 });
  success('seal', sealer);
  const bytes = readFileSync(join(sealer.temp, 'reviewer-host-sealed/reviewer-host-handoff.json'));
  assert.equal(outputs(sealer).sha256, hash(bytes));
  assert.equal(readQualificationHandoff(bytes).attempt.checkRunId, '77'); assert.equal(readQualificationHandoff(bytes).sealCheckRunId, '88');
  assert.equal(existsSync(join(sealer.temp, 'reviewer-host-producer')), false);
  refused('produce', producer); // fixed directory/output cannot be reused or overwritten.
});

test('host refuses invalid context, dirty defining source and unsafe output files before publication', () => {
  for (const changes of [{ QUAL_PROTECTED: 'false' }, { QUAL_WORKFLOW_REF: `${REVIEW_WORKFLOW}@main` },
    { QUAL_WORKFLOW_SHA: 'f'.repeat(40) }, { QUAL_CHECK_RUN_ID: '' }, { GITHUB_WORKSPACE: root }]) {
    const h = host(changes); refused('produce', h); assert.equal(readFileSync(h.output, 'utf8'), '');
    assert.equal(existsSync(join(h.temp, 'reviewer-host-producer')), false);
  }
  const untracked = join(source, 'unexpected.txt'); writeFileSync(untracked, 'untrusted');
  try { const h = host(); refused('produce', h); assert.equal(readFileSync(h.output, 'utf8'), ''); } finally { rmSync(untracked); }
  const modified = join(source, 'scripts/reviewer-host-handoff.mjs'), original = readFileSync(modified);
  writeFileSync(modified, Buffer.concat([original, Buffer.from('\n// unexpected mutation\n')]));
  try { refused('produce', host()); } finally { writeFileSync(modified, original); }
  const filled = host(); writeFileSync(filled.output, 'forged=true\n'); refused('produce', filled);
  assert.equal(existsSync(join(filled.temp, 'reviewer-host-producer')), false);
  const linked = host(); rmSync(linked.output); symlinkSync(filled.output, linked.output); refused('produce', linked);
  const outside = host({ GITHUB_OUTPUT: filled.output }); refused('produce', outside);
  const invalidMode = host(); refused('arbitrary-script', invalidMode);
});

test('host output schema prevents extra keys, multiline injection and forged immutable identities', () => {
  const attempt = captureHostedContext(platform(revision), revision);
  const value = { attemptJson: JSON.stringify(attempt), envelopeSha256: 'a'.repeat(64) };
  assert.ok(serializeHostOutputs(value).length <= SOURCE_LIMITS.outputs);
  for (const changed of [{ ...value, forged: 'true' }, { ...value, attemptJson: `${value.attemptJson}\ninjected=true` },
    { ...value, attemptJson: ' '.repeat(4097) }, { ...value, envelopeSha256: `${'a'.repeat(64)}\ninjected=true` },
    { ...value, attemptJson: JSON.stringify({ ...attempt, workflowRef: `${REVIEW_WORKFLOW}@main` }) },
    { sha256: 'a'.repeat(64), artifactPath: '/untrusted' }, { sha256: 'a\r\nb' }]) assert.throws(() => serializeHostOutputs(changed));
});

test('fresh seal refuses same or sibling job context and unbounded platform outputs', () => {
  const attempt = captureHostedContext(platform(revision), revision);
  for (const changes of [{ QUAL_CHECK_RUN_ID: '77' }, { QUAL_RUN_ATTEMPT: '3' }, { QUAL_ATTEMPT_JSON: '{' },
    { QUAL_ATTEMPT_JSON: ' '.repeat(4097) }, { QUAL_ENVELOPE_SHA256: 'bad' }]) {
    const h = host({ QUAL_CHECK_RUN_ID: '88', QUAL_ATTEMPT_JSON: JSON.stringify(attempt), QUAL_ENVELOPE_SHA256: 'a'.repeat(64), ...changes });
    refused('seal', h); assert.equal(readFileSync(h.output, 'utf8'), ''); assert.equal(existsSync(join(h.temp, 'reviewer-host-sealed')), false);
  }
});

test('retention copies only bounded action bytes after matching sealed identity; it makes no verification claim', () => {
  const h = sealed(); success('retain', h);
  assert.deepEqual(readdirSync(join(h.temp, 'reviewer-host-sealed')).sort(), ['attestation.sigstore.json', 'reviewer-host-handoff.json']);
  assert.deepEqual(readFileSync(join(h.temp, 'reviewer-host-sealed/attestation.sigstore.json')), readFileSync(h.env.QUAL_ATTESTATION_BUNDLE));
  refused('retain', h);
  for (const change of [
    x => { writeFileSync(x.env.QUAL_ATTESTATION_BUNDLE, Buffer.alloc(SOURCE_LIMITS.attestation + 1)); },
    x => { rmSync(x.env.QUAL_ATTESTATION_BUNDLE); },
    x => { const original = x.env.QUAL_ATTESTATION_BUNDLE; x.env.QUAL_ATTESTATION_BUNDLE = join(x.temp, 'attestation.json'); symlinkSync(original, x.env.QUAL_ATTESTATION_BUNDLE); },
    x => { x.env.QUAL_ATTESTATION_BUNDLE = h.env.QUAL_ATTESTATION_BUNDLE; },
    x => { x.env.QUAL_HANDOFF_SHA256 = 'b'.repeat(64); },
    x => { x.env.QUAL_CHECK_RUN_ID = '99'; },
    x => { writeFileSync(join(x.temp, 'reviewer-host-sealed/extra.json'), '{}'); },
    x => { const path = join(x.temp, 'reviewer-host-sealed/reviewer-host-handoff.json'); chmodSync(path, 0o600); writeFileSync(path, '{}'); },
  ]) {
    const bad = sealed(); change(bad); refused('retain', bad);
    assert.equal(existsSync(join(bad.temp, 'reviewer-host-sealed/attestation.sigstore.json')), false);
  }
});
