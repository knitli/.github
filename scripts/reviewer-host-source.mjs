import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, basename } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { captureAttemptContext, readProducerBundle } from './reviewer-producer-run.mjs';
import { captureQualificationPublication, sealQualificationHandoff, readQualificationHandoff,
  HOST_HANDOFF_LIMIT, REVIEW_WORKFLOW } from './reviewer-host-handoff.mjs';
import { prepareSyntheticProducer } from './fixtures/reviewer-host-qualification/producer.mjs';

export const HOST_NODE_VERSION = '24.21.0';
export const SOURCE_LIMITS = Object.freeze({ producerFile: 64 * 1024, producerTotal: 128 * 1024,
  attestation: 2 * 1024 * 1024, outputs: 8192 });
const SOURCE = fileURLToPath(new URL('../', import.meta.url));
const CALLER = 'knitli/knitli-site/.github/workflows/reviewer-host-qualification.yml@refs/heads/main';
const sha = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = code => { const error = new Error(`Reviewer host qualification refused: ${code}`); error.code = code; throw error; };
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join('|') === [...keys].sort().join('|');

/** Only trusted platform env reaches this API. Raw defining-workflow ref is never synthesized. */
export function captureHostedContext(env, sourceRevision) {
  const expected = { QUAL_ENABLED: 'true', QUAL_REPOSITORY: 'knitli/knitli-site', QUAL_REPOSITORY_ID: '1058277548',
    QUAL_VISIBILITY: 'private', QUAL_EVENT: 'workflow_dispatch', QUAL_REF: 'refs/heads/main', QUAL_PROTECTED: 'true',
    QUAL_CALLER_WORKFLOW: CALLER, QUAL_RUNNER: 'github-hosted', QUAL_OS: 'Linux', QUAL_ARCH: 'X64', GITHUB_ACTIONS: 'true' };
  if (Object.entries(expected).some(([key, value]) => env[key] !== value)
    || !sha(env.QUAL_SOURCE_SHA) || !sha(sourceRevision) || env.QUAL_WORKFLOW_SHA !== sourceRevision
    || env.QUAL_WORKFLOW_REF !== `${REVIEW_WORKFLOW}@${sourceRevision}`) fail('platform_context');
  return captureAttemptContext({ repository: env.QUAL_REPOSITORY, repositoryId: Number(env.QUAL_REPOSITORY_ID),
    runId: env.QUAL_RUN_ID, runAttempt: env.QUAL_RUN_ATTEMPT, checkRunId: env.QUAL_CHECK_RUN_ID,
    workflowRef: env.QUAL_WORKFLOW_REF, workflowSha: env.QUAL_WORKFLOW_SHA, producerRevision: sourceRevision });
}

function canonical(path) {
  if (typeof path !== 'string' || !isAbsolute(path) || resolve(path) !== path || realpathSync(path) !== path) fail('host_path');
  return path;
}
function inside(path, root) {
  const rel = relative(root, path);
  if (!rel || rel === '..' || rel.startsWith('../') || isAbsolute(rel)) fail('host_path');
}
function verifiedSource(env) {
  const root = canonical(env.GITHUB_WORKSPACE), source = canonical(join(root, 'reviewer-host'));
  if (realpathSync(SOURCE) !== source) fail('source_location');
  const git = (...args) => execFileSync('/usr/bin/git', ['-c', 'core.fsmonitor=false', '-C', source, ...args], {
    encoding: 'utf8', timeout: 10_000, maxBuffer: 64 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
    env: { PATH: '/usr/bin:/bin', HOME: root, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
  }).trim();
  const revision = git('rev-parse', 'HEAD');
  if (!sha(revision) || revision !== env.QUAL_WORKFLOW_SHA || git('rev-parse', '--show-toplevel') !== source
    || git('status', '--porcelain', '--untracked-files=all') !== '') fail('source_revision');
  return revision;
}
function boundedFile(path, limit, root) {
  canonical(path); inside(path, root);
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.size === 0 || before.size > limit) fail('artifact_limit');
    const bytes = Buffer.alloc(before.size + 1);
    let count = 0, read;
    do { read = readSync(fd, bytes, count, bytes.length - count, count); count += read; } while (read && count < bytes.length);
    const after = fstatSync(fd), pathStat = lstatSync(path);
    if (count !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs
      || !pathStat.isFile() || pathStat.ino !== after.ino || pathStat.dev !== after.dev) fail('artifact_changed');
    return bytes.subarray(0, count);
  } finally { closeSync(fd); }
}

/** Output file is opened before fixture execution; only returned host values can be serialized. */
export function serializeHostOutputs(values) {
  if (exact(values, ['attemptJson', 'envelopeSha256'])) {
    if (typeof values.attemptJson !== 'string' || Buffer.byteLength(values.attemptJson) > HOST_HANDOFF_LIMIT
      || typeof values.envelopeSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(values.envelopeSha256)) fail('output_schema');
    let attempt; try { attempt = captureAttemptContext(JSON.parse(values.attemptJson)); } catch { fail('output_schema'); }
    if (values.attemptJson !== JSON.stringify(attempt) || attempt.workflowRef !== `${REVIEW_WORKFLOW}@${attempt.workflowSha}`) fail('output_schema');
  } else if (!exact(values, ['sha256']) || typeof values.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(values.sha256)) fail('output_schema');
  const text = Object.entries(values).map(([key, value]) => `${key}=${value}\n`).join('');
  if (Object.values(values).some(value => /[\r\n\0]/.test(value)) || Buffer.byteLength(text) > SOURCE_LIMITS.outputs) fail('output_limit');
  return Buffer.from(text);
}
function openOutput(path, root) {
  canonical(path); inside(path, root);
  const fd = openSync(path, constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  const stat = fstatSync(fd);
  if (!stat.isFile() || stat.size !== 0) { closeSync(fd); fail('output_file'); }
  return fd;
}
function sealBytes(path, env, attempt, temp) {
  const bytes = boundedFile(path, HOST_HANDOFF_LIMIT, temp), handoff = readQualificationHandoff(bytes);
  if (handoff.sealCheckRunId !== attempt.checkRunId || handoff.attempt.checkRunId === attempt.checkRunId
    || Object.keys(attempt).some(key => key !== 'checkRunId' && handoff.attempt[key] !== attempt[key])
    || digest(bytes) !== env.QUAL_HANDOFF_SHA256) fail('sealed_handoff');
  return bytes;
}

/** Fixed workflow entrypoint. It offers no caller-selected executable, source repository or output paths. */
export async function runHostedSource(mode, env = process.env) {
  if (!['produce', 'seal', 'retain'].includes(mode) || process.versions.node !== HOST_NODE_VERSION) fail('runtime');
  const revision = verifiedSource(env), attempt = captureHostedContext(env, revision), temp = canonical(env.RUNNER_TEMP);
  const source = realpathSync(SOURCE);
  if (temp === source || temp.startsWith(`${source}/`)) fail('host_path');
  const producer = join(temp, 'reviewer-host-producer'), sealed = join(temp, 'reviewer-host-sealed');
  let output;
  try {
    if (mode !== 'retain') output = openOutput(env.GITHUB_OUTPUT, temp);
    if (mode === 'produce') {
      const options = await prepareSyntheticProducer({ directory: producer, attemptContext: attempt });
      const host = await captureQualificationPublication(options);
      const directory = join(producer, 'bundle');
      if (readdirSync(directory).sort().join('|') !== 'completion.json|envelope.json|snapshot.json') fail('producer_files');
      let size = 0;
      for (const file of ['completion.json', 'envelope.json', 'snapshot.json']) size += boundedFile(join(directory, file), SOURCE_LIMITS.producerFile, temp).length;
      if (size > SOURCE_LIMITS.producerTotal) fail('artifact_limit');
      readProducerBundle(directory, host.outputs.envelopeSha256);
      if (verifiedSource(env) !== revision) fail('source_revision');
      writeFileSync(output, serializeHostOutputs(host.outputs));
    } else if (mode === 'seal') {
      const bytes = sealQualificationHandoff({ producerOutputs: { attemptJson: env.QUAL_ATTEMPT_JSON,
        envelopeSha256: env.QUAL_ENVELOPE_SHA256 }, platformContext: attempt });
      mkdirSync(sealed, { mode: 0o700 });
      writeFileSync(join(sealed, 'reviewer-host-handoff.json'), bytes, { flag: 'wx', mode: 0o400 });
      if (verifiedSource(env) !== revision) fail('source_revision');
      writeFileSync(output, serializeHostOutputs({ sha256: digest(bytes) }));
    } else {
      canonical(sealed);
      if (readdirSync(sealed).join('|') !== 'reviewer-host-handoff.json' || basename(env.QUAL_ATTESTATION_BUNDLE ?? '') !== 'attestation.json') fail('seal_files');
      sealBytes(join(sealed, 'reviewer-host-handoff.json'), env, attempt, temp);
      const bytes = boundedFile(env.QUAL_ATTESTATION_BUNDLE, SOURCE_LIMITS.attestation, temp);
      // Transport only: a successful signer step and this bounded copy are not acquisition verification.
      writeFileSync(join(sealed, 'attestation.sigstore.json'), bytes, { flag: 'wx', mode: 0o400 });
    }
  } finally { if (output !== undefined) closeSync(output); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length !== 3) { process.stderr.write('Reviewer host qualification refused: arguments\n'); process.exitCode = 1; }
  else runHostedSource(process.argv[2]).catch(error => {
    const code = typeof error.code === 'string' && /^[a-z_]+$/.test(error.code) ? error.code : 'host_failure';
    process.stderr.write(`Reviewer host qualification refused: ${code}\n`); process.exitCode = 1;
  });
}
