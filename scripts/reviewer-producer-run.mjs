import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, closeSync, constants, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, mkdtempSync, openSync, readSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { captureSnapshot } from './reviewer-input-snapshot.mjs';
import { main as driverMain, SDK_VERSION, validateSnapshot } from './reviewer-completion-driver.mjs';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = code => { const error = new Error(`Reviewer producer refused: ${code}`); error.code = code; throw error; };
const hex = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value);
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join('|') === [...keys].sort().join('|');
const safeText = value => typeof value === 'string' && !value.includes('\0') && Buffer.from(value).toString('utf8') === value;
export const PRODUCER_LIMITS = Object.freeze({ snapshotBytes: 32 * 1024 * 1024, completionBytes: 256 * 1024, envelopeBytes: 64 * 1024 });

/** Host context binds data; it does not authenticate itself. */
export function captureAttemptContext(value) {
  const keys = ['repository', 'repositoryId', 'runId', 'runAttempt', 'checkRunId', 'workflowRef', 'workflowSha', 'producerRevision'];
  if (!exact(value, keys)) fail('attempt_context');
  const result = Object.freeze(Object.fromEntries(keys.map(key => [key, value[key]])));
  if (typeof result.repository !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(result.repository)
    || result.repository.split('/').some(part => part === '.' || part === '..')
    || !Number.isSafeInteger(result.repositoryId) || result.repositoryId < 1
    || ['runId', 'runAttempt', 'checkRunId'].some(key => typeof result[key] !== 'string' || !/^[1-9][0-9]{0,19}$/.test(result[key]))
    || typeof result.workflowRef !== 'string' || !/^knitli\/\.github\/\.github\/workflows\/claude-pr-reviewer\.yml@[^\s]{1,256}$/.test(result.workflowRef)
    || !hex(result.workflowSha) || result.workflowSha !== result.producerRevision) fail('attempt_context');
  return result;
}

function boundedFile(path, maximum) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.size > maximum) fail('artifact_invalid');
    const buffer = Buffer.alloc(before.size + 1);
    let count = 0, read;
    do { read = readSync(fd, buffer, count, buffer.length - count, count); count += read; } while (read && count < buffer.length);
    const after = fstatSync(fd), pathStat = lstatSync(path);
    if (count !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs
      || !pathStat.isFile() || pathStat.ino !== after.ino || pathStat.dev !== after.dev) fail('artifact_invalid');
    return buffer.subarray(0, count);
  } finally { closeSync(fd); }
}
function publish(path, value) {
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
  if (bytes.length > PRODUCER_LIMITS.envelopeBytes) fail('envelope_limit');
  const stage = mkdtempSync(join(dirname(path), '.envelope-'));
  try {
    const file = join(stage, 'envelope.json'), fd = openSync(file, 'wx', 0o444);
    try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
    linkSync(file, path);
  } finally { rmSync(stage, { recursive: true, force: true }); }
}
function matches(candidate, manifest) {
  return candidate?.number === manifest.pullRequest && candidate.title === manifest.description.title
    && (candidate.body ?? '') === manifest.description.body && ['head', 'base'].every(side => {
      const observed = candidate[side], fixed = manifest[side];
      return observed?.sha === fixed.sha && observed.repo?.id === fixed.repositoryId && observed.repo?.full_name === fixed.repository;
    });
}
function validateCompletion(bytes, snapshotDigest, snapshot, model) {
  let value; try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { fail('completion_invalid'); }
  if (!exact(value, ['schema', 'status', 'provider', 'sdkVersion', 'requestedModel', 'resolvedModel', 'usageModels', 'sessionId', 'terminalUuid', 'snapshotSha256', 'manifestSha256', 'coverage', 'report'])
    || value.schema !== 'knitli-reviewer-completion:v1' || value.status !== 'completed' || value.provider !== 'claude-agent-sdk'
    || value.requestedModel !== model || value.resolvedModel !== model
    || !Array.isArray(value.usageModels) || value.usageModels.length !== 1 || value.usageModels[0] !== model
    || value.sdkVersion !== SDK_VERSION || !uuid(value.sessionId) || !uuid(value.terminalUuid)
    || value.snapshotSha256 !== snapshotDigest || value.manifestSha256 !== snapshot.manifestSha256) fail('completion_invalid');
  const coverage = value.coverage;
  const units = [JSON.stringify(snapshot.manifest), snapshot.diff, ...snapshot.files.flatMap(file => [file.before, file.after].filter(value => value !== null))];
  const requiredPages = units.reduce((total, value) => total + Math.max(1, Math.ceil(Array.from(value).length / 6000)), 0);
  if (!exact(coverage, ['pages', 'requiredPages', 'files']) || !Number.isSafeInteger(coverage.pages) || coverage.pages !== requiredPages
    || coverage.pages !== coverage.requiredPages || coverage.files !== snapshot.files.length) fail('completion_invalid');
  const report = value.report;
  if (!exact(report, ['schema', 'snapshotSha256', 'findings', 'limitations']) || report.schema !== 'knitli-review-report:v1'
    || report.snapshotSha256 !== snapshotDigest || !Array.isArray(report.findings) || report.findings.length > 100
    || !Array.isArray(report.limitations) || report.limitations.length > 100
    || report.limitations.some(text => !safeText(text) || !text || text.length > 4000)) fail('completion_invalid');
  for (const finding of report.findings) {
    const file = snapshot.files.find(file => file.path === finding?.path);
    if (!exact(finding, ['path', 'side', 'line', 'severity', 'message']) || !file || !['before', 'after'].includes(finding.side)
      || file[finding.side] === null || !Number.isSafeInteger(finding.line) || finding.line < 1
      || finding.line > (file[finding.side] === '' ? 0 : file[finding.side].split('\n').length - Number(file[finding.side].endsWith('\n'))) || !['low', 'medium', 'high', 'critical'].includes(finding.severity)
      || !safeText(finding.message) || !finding.message || finding.message.length > 4000) fail('completion_invalid');
  }
  return value;
}

/** Local host orchestration, not authenticated provider admission or cloud authority. */
export async function runProducer({ repository, pullRequest, expectedHead, expectedBase, outputDirectory, readCandidate,
  capture = captureSnapshot, runDriver = driverMain, sdkDirectory, claudeBinary, model, attemptContext } = {}) {
  const attempt = attemptContext === undefined ? null : captureAttemptContext(attemptContext);
  if (attempt && attempt.repository !== repository) fail('attempt_context');
  if (typeof repository !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) || repository.split('/').some(part => part === '.' || part === '..')
    || !Number.isSafeInteger(pullRequest) || pullRequest < 1 || !hex(expectedHead) || !hex(expectedBase)
    || typeof outputDirectory !== 'string' || !isAbsolute(outputDirectory) || typeof readCandidate !== 'function'
    || typeof capture !== 'function' || typeof runDriver !== 'function' || typeof sdkDirectory !== 'string' || !isAbsolute(sdkDirectory)
    || typeof claudeBinary !== 'string' || !isAbsolute(claudeBinary) || typeof model !== 'string' || !/^[A-Za-z0-9_.-]{1,100}$/.test(model)
    || !/^claude-[a-z0-9]+(?:-[a-z0-9]+)*-[0-9]+$/.test(model)) fail('arguments');
  // Exclusive directory reservation avoids overwriting or reusing another attempt.
  mkdirSync(outputDirectory, { mode: 0o700 });
  const snapshotPath = join(outputDirectory, 'snapshot.json'), completionPath = join(outputDirectory, 'completion.json');
  const envelope = { schema: 'knitli-reviewer-producer:v1', executionId: randomUUID(), provenance: 'unverified', roundCompletion: 'unknown',
    status: 'failed', applicability: 'unknown', failure: null, ...(attempt ? { attempt } : {}),
    configured: { repository, pullRequest, expectedHead, expectedBase, model }, snapshot: null, completion: null };
  let stage = 'capture_failed';
  try {
    const captured = await capture({ repository, pullRequest, expectedHead, expectedBase, outputPath: snapshotPath, readCandidate });
    const snapshotBytes = boundedFile(snapshotPath, PRODUCER_LIMITS.snapshotBytes);
    const snapshot = validateSnapshot(snapshotBytes, captured.artifactSha256);
    if (captured.artifactPath !== snapshotPath || snapshot.manifest.repository.fullName !== repository || snapshot.manifest.pullRequest !== pullRequest
      || (attempt && snapshot.manifest.repository.id !== attempt.repositoryId)
      || snapshot.manifest.head.sha !== expectedHead || snapshot.manifest.base.sha !== expectedBase) fail('snapshot_binding');
    envelope.snapshot = { file: 'snapshot.json', sha256: digest(snapshotBytes), bytes: snapshotBytes.length, manifestSha256: snapshot.manifestSha256 };
    stage = 'candidate_unavailable';
    if (!matches(await readCandidate(), snapshot.manifest)) { envelope.applicability = 'stale'; fail('candidate_changed'); }
    // Fresh-read latency must not permit local artifact replacement between validation and handoff.
    if (digest(boundedFile(snapshotPath, PRODUCER_LIMITS.snapshotBytes)) !== envelope.snapshot.sha256) fail('snapshot_changed');
    stage = 'driver_failed';
    const result = await runDriver(['--snapshot', snapshotPath, '--snapshot-sha256', envelope.snapshot.sha256,
      '--sdk-directory', sdkDirectory, '--claude-binary', claudeBinary, '--model', model, '--receipt', completionPath]);
    stage = 'completion_invalid';
    if (!exact(result, ['receiptPath', 'snapshotSha256', 'status']) || result.receiptPath !== completionPath
      || result.snapshotSha256 !== envelope.snapshot.sha256 || result.status !== 'completed') fail('completion_invalid');
    const completionBytes = boundedFile(completionPath, PRODUCER_LIMITS.completionBytes);
    const completed = validateCompletion(completionBytes, envelope.snapshot.sha256, snapshot, model);
    // Retain only a verified full snapshot/receipt pair; neither file may drift during the driver.
    if (digest(boundedFile(snapshotPath, PRODUCER_LIMITS.snapshotBytes)) !== envelope.snapshot.sha256) fail('snapshot_changed');
    envelope.completion = { file: 'completion.json', sha256: digest(completionBytes), bytes: completionBytes.length,
      sessionId: completed.sessionId, terminalUuid: completed.terminalUuid, requestedModel: completed.requestedModel,
      resolvedModel: completed.resolvedModel, usageModels: completed.usageModels };
    envelope.status = 'completed';
    try { envelope.applicability = matches(await readCandidate(), snapshot.manifest) ? 'unchanged-observed' : 'stale'; }
    catch { envelope.applicability = 'unknown'; }
    // Final asynchronous freshness observation cannot race retained artifact validation.
    if (digest(boundedFile(snapshotPath, PRODUCER_LIMITS.snapshotBytes)) !== envelope.snapshot.sha256) fail('snapshot_changed');
    if (digest(boundedFile(completionPath, PRODUCER_LIMITS.completionBytes)) !== envelope.completion.sha256) fail('completion_invalid');
  } catch (error) {
    const known = new Set(['snapshot_binding', 'snapshot_changed', 'candidate_changed', 'completion_invalid', 'artifact_invalid']);
    envelope.status = 'failed'; envelope.completion = null;
    envelope.failure = known.has(error?.code) ? error.code : stage;
    // Incomplete or invalid outputs never remain under a completion artifact name.
    rmSync(completionPath, { force: true });
    let snapshotValid = false;
    try { snapshotValid = envelope.snapshot !== null && digest(boundedFile(snapshotPath, PRODUCER_LIMITS.snapshotBytes)) === envelope.snapshot.sha256; } catch {}
    if (!snapshotValid) {
      rmSync(snapshotPath, { force: true }); envelope.snapshot = null;
    }
  }
  for (const artifact of [envelope.snapshot, envelope.completion]) if (artifact) chmodSync(join(outputDirectory, artifact.file), 0o444);
  publish(join(outputDirectory, 'envelope.json'), envelope);
  return envelope;
}

/** The caller must authenticate this envelope digest through a separate host channel. */
export function readProducerBundle(directory, expectedEnvelopeSha256) {
  const envelopeBytes = boundedFile(join(directory, 'envelope.json'), PRODUCER_LIMITS.envelopeBytes);
  if (typeof expectedEnvelopeSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(expectedEnvelopeSha256)
    || digest(envelopeBytes) !== expectedEnvelopeSha256) fail('envelope_digest');
  let envelope;
  try { envelope = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(envelopeBytes)); } catch { fail('envelope_invalid'); }
  if (!exact(envelope, ['schema', 'executionId', 'provenance', 'roundCompletion', 'status', 'applicability', 'failure', 'configured', 'snapshot', 'completion', 'attempt'])
    || envelope.schema !== 'knitli-reviewer-producer:v1' || !uuid(envelope.executionId)
    || envelope.provenance !== 'unverified' || envelope.roundCompletion !== 'unknown'
    || envelope.status !== 'completed' || envelope.failure !== null
    || !['unchanged-observed', 'stale', 'unknown'].includes(envelope.applicability)) fail('envelope_invalid');
  const attempt = captureAttemptContext(envelope.attempt);
  const snapshotBytes = boundedFile(join(directory, 'snapshot.json'), PRODUCER_LIMITS.snapshotBytes);
  const snapshot = validateSnapshot(snapshotBytes, envelope.snapshot?.sha256);
  if (!exact(envelope.snapshot, ['file', 'sha256', 'bytes', 'manifestSha256']) || envelope.snapshot.file !== 'snapshot.json'
    || envelope.snapshot.bytes !== snapshotBytes.length || envelope.snapshot.manifestSha256 !== snapshot.manifestSha256
    || attempt.repository !== snapshot.manifest.repository.fullName || attempt.repositoryId !== snapshot.manifest.repository.id
    || !exact(envelope.configured, ['repository', 'pullRequest', 'expectedHead', 'expectedBase', 'model'])
    || envelope.configured.repository !== attempt.repository || envelope.configured.pullRequest !== snapshot.manifest.pullRequest
    || envelope.configured.expectedHead !== snapshot.manifest.head.sha || envelope.configured.expectedBase !== snapshot.manifest.base.sha
    || typeof envelope.configured.model !== 'string' || !/^[A-Za-z0-9_.-]{1,100}$/.test(envelope.configured.model)
    || !/^claude-[a-z0-9]+(?:-[a-z0-9]+)*-[0-9]+$/.test(envelope.configured.model)) fail('snapshot_binding');
  const completionBytes = boundedFile(join(directory, 'completion.json'), PRODUCER_LIMITS.completionBytes);
  const completion = validateCompletion(completionBytes, envelope.snapshot.sha256, snapshot, envelope.configured.model);
  if (!exact(envelope.completion, ['file', 'sha256', 'bytes', 'sessionId', 'terminalUuid', 'requestedModel', 'resolvedModel', 'usageModels']) || envelope.completion.file !== 'completion.json'
    || envelope.completion.sha256 !== digest(completionBytes) || envelope.completion.bytes !== completionBytes.length
    || envelope.completion.sessionId !== completion.sessionId || envelope.completion.terminalUuid !== completion.terminalUuid
    || envelope.completion.requestedModel !== completion.requestedModel || envelope.completion.resolvedModel !== completion.resolvedModel
    || !Array.isArray(envelope.completion.usageModels) || envelope.completion.usageModels.length !== 1
    || envelope.completion.usageModels[0] !== completion.resolvedModel) fail('completion_invalid');
  return { envelope, attempt };
}

export async function main(args) {
  const flags = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!['--repository', '--pull-request', '--expected-head', '--expected-base', '--output-directory', '--sdk-directory', '--claude-binary', '--model', '--gh-binary'].includes(args[i])
      || flags[args[i]] !== undefined || !args[i + 1]) fail('arguments');
    flags[args[i]] = args[i + 1];
  }
  if (Object.keys(flags).length !== 9 || !isAbsolute(flags['--gh-binary'])) fail('arguments');
  const githubToken = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN, apiKey = process.env.ANTHROPIC_API_KEY;
  if (!githubToken || !apiKey) fail('credentials_missing');
  // This CLI owns its host environment. Library callers must supply an equivalently trusted host.
  for (const key of Object.keys(process.env)) delete process.env[key];
  process.env.PATH = '/usr/bin:/bin'; process.env.ANTHROPIC_API_KEY = apiKey;
  const config = mkdtempSync(join(tmpdir(), 'reviewer-acquisition-'));
  try {
    const readCandidate = async () => JSON.parse(execFileSync(flags['--gh-binary'], ['api', '--hostname', 'github.com', '-H', 'X-GitHub-Api-Version: 2026-03-10',
      `repos/${flags['--repository']}/pulls/${flags['--pull-request']}`], { env: { PATH: '/usr/bin:/bin', HOME: config, GH_CONFIG_DIR: config, GH_TOKEN: githubToken },
      encoding: 'utf8', timeout: 30_000, killSignal: 'SIGKILL', maxBuffer: 2 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }));
    return await runProducer({ repository: flags['--repository'], pullRequest: Number(flags['--pull-request']), expectedHead: flags['--expected-head'],
      expectedBase: flags['--expected-base'], outputDirectory: resolve(flags['--output-directory']), readCandidate,
      capture: options => captureSnapshot({ ...options, token: githubToken }), sdkDirectory: resolve(flags['--sdk-directory']),
      claudeBinary: resolve(flags['--claude-binary']), model: flags['--model'] });
  } finally { rmSync(config, { recursive: true, force: true }); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = await main(process.argv.slice(2));
    process.stdout.write(`${JSON.stringify({ status: result.status, applicability: result.applicability, provenance: result.provenance, roundCompletion: result.roundCompletion })}\n`);
    if (result.status !== 'completed') process.exitCode = 1;
  } catch { process.stderr.write('Reviewer producer unavailable; no round completion authorized.\n'); process.exitCode = 1; }
}
