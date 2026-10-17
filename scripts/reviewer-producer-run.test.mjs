import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, rm, stat, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureSnapshot } from './reviewer-input-snapshot.mjs';
import { SDK_VERSION, runReview } from './reviewer-completion-driver.mjs';
import { runProducer } from './reviewer-producer-run.mjs';

let root, repo, candidate;
before(async () => {
  root = await mkdtemp(join(tmpdir(), 'reviewer-producer-test-'));
  repo = join(root, 'repo');
  await mkdir(repo);
  const git = (...args) => execFileSync('/usr/bin/git', ['-c', 'user.name=Producer Test',
    '-c', 'user.email=producer@example.invalid', '-c', 'commit.gpgsign=false',
    '-c', 'core.hooksPath=/dev/null', '-C', repo, ...args],
  { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-q');
  await writeFile(join(repo, 'tracked.txt'), 'before café\n');
  git('add', '--all'); git('commit', '-qm', 'base');
  const base = git('rev-parse', 'HEAD');
  await writeFile(join(repo, 'tracked.txt'), 'after café\n');
  git('add', '--all'); git('commit', '-qm', 'head');
  candidate = { number: 7, title: 'Fixture', body: 'Untrusted PR description',
    base: { sha: base, repo: { id: 1, full_name: 'knitli/demo' } },
    head: { sha: git('rev-parse', 'HEAD'), repo: { id: 1, full_name: 'knitli/demo' } } };
});
after(async () => { if (root) await rm(root, { recursive: true, force: true }); });

const flagsOf = args => Object.fromEntries(Array.from({ length: args.length / 2 }, (_, i) => [args[i * 2], args[i * 2 + 1]]));
async function writeReceipt(args, mutate = () => {}) {
  const flags = flagsOf(args);
  const snapshot = JSON.parse(await readFile(flags['--snapshot'], 'utf8'));
  const receipt = { schema: 'knitli-reviewer-completion:v1', status: 'completed',
    provider: 'claude-agent-sdk', sdkVersion: SDK_VERSION,
    requestedModel: flags['--model'], resolvedModel: flags['--model'], usageModels: [flags['--model']], sessionId: randomUUID(), terminalUuid: randomUUID(),
    snapshotSha256: flags['--snapshot-sha256'], manifestSha256: snapshot.manifestSha256,
    coverage: { pages: 4, requiredPages: 4, files: snapshot.files.length },
    report: { schema: 'knitli-review-report:v1', snapshotSha256: flags['--snapshot-sha256'], findings: [], limitations: [] } };
  mutate(receipt);
  await writeFile(flags['--receipt'], JSON.stringify(receipt));
  return { receiptPath: flags['--receipt'], snapshotSha256: flags['--snapshot-sha256'], status: 'completed' };
}
function options(overrides = {}) {
  return { sdkDirectory: '/trusted/sdk', claudeBinary: '/trusted/claude', model: 'claude-sonnet-4-6', repository: 'knitli/demo', pullRequest: 7, expectedHead: candidate.head.sha,
    expectedBase: candidate.base.sha, outputDirectory: join(root, randomUUID()),
    readCandidate: async () => structuredClone(candidate),
    capture: input => captureSnapshot({ ...input, localRepository: repo }),
    runDriver: args => writeReceipt(args), ...overrides };
}
async function committed(input, result) {
  const retained = JSON.parse(await readFile(join(input.outputDirectory, 'envelope.json'), 'utf8'));
  assert.deepEqual(retained, result);
  assert.equal(result.schema, 'knitli-reviewer-producer:v1');
  assert.equal(result.provenance, 'unverified');
  assert.equal(result.roundCompletion, 'unknown');
}

test('captures, rechecks, runs, rechecks and commits a private unverified bundle', async () => {
  const events = [];
  const input = options({
    readCandidate: async () => { events.push('read'); return structuredClone(candidate); },
    capture: async value => {
      events.push('capture');
      const result = await captureSnapshot({ ...value, localRepository: repo });
      events.push('captured');
      return result;
    },
    runDriver: async args => { events.push('driver'); return writeReceipt(args); },
  });
  const result = await runProducer(input);
  assert.deepEqual(events, ['capture', 'read', 'read', 'captured', 'read', 'driver', 'read']);
  assert.equal(result.status, 'completed');
  assert.equal(result.applicability, 'unchanged-observed');
  assert.equal(result.failure, null);
  assert.equal((await stat(input.outputDirectory)).mode & 0o777, 0o700);
  await access(join(input.outputDirectory, 'snapshot.json'));
  await access(join(input.outputDirectory, 'completion.json'));
  await committed(input, result);
});

test('candidate movement before driver blocks invocation and commits stale failure', async () => {
  let reads = 0, calls = 0;
  const input = options({ readCandidate: async () => {
    const value = structuredClone(candidate);
    if (++reads >= 3) value.head.sha = 'f'.repeat(40);
    return value;
  }, runDriver: async args => { calls++; return writeReceipt(args); } });
  const result = await runProducer(input);
  assert.equal(calls, 0);
  assert.equal(result.status, 'failed');
  assert.equal(result.applicability, 'stale');
  await assert.rejects(access(join(input.outputDirectory, 'completion.json')));
  await committed(input, result);
});

test('candidate movement after completion retains historical receipt but marks it stale', async () => {
  let reads = 0;
  const input = options({ readCandidate: async () => {
    const value = structuredClone(candidate);
    if (++reads >= 4) value.base.sha = 'f'.repeat(40);
    return value;
  } });
  const result = await runProducer(input);
  assert.equal(result.status, 'completed');
  assert.equal(result.applicability, 'stale');
  assert.equal(JSON.parse(await readFile(join(input.outputDirectory, 'completion.json'), 'utf8')).status, 'completed');
  await committed(input, result);
});

test('driver exception with partial output produces safe retained failure', async () => {
  const secret = 'private-provider-error-token';
  const input = options({ runDriver: async args => {
    await writeFile(flagsOf(args)['--receipt'], '{partial');
    throw new Error(secret);
  } });
  const result = await runProducer(input);
  assert.equal(result.status, 'failed');
  assert.equal(typeof result.failure, 'string');
  assert.ok(!JSON.stringify(result).includes(secret));
  await committed(input, result);
});

test('driver success without a receipt cannot become completed', async () => {
  const input = options({ runDriver: async args => {
    const flags = flagsOf(args);
    return { receiptPath: flags['--receipt'], snapshotSha256: flags['--snapshot-sha256'], status: 'completed' };
  } });
  const result = await runProducer(input);
  assert.equal(result.status, 'failed');
  await committed(input, result);
});

test('rejects receipt digest, session and terminal binding failures', async t => {
  const mutations = {
    snapshot: value => { value.snapshotSha256 = '0'.repeat(64); },
    manifest: value => { value.manifestSha256 = '0'.repeat(64); },
    report: value => { value.report.snapshotSha256 = '0'.repeat(64); },
    missingSession: value => { delete value.sessionId; },
    invalidSession: value => { value.sessionId = 'not-a-session'; },
    missingTerminal: value => { delete value.terminalUuid; },
    incompleteCoverage: value => { value.coverage.requiredPages++; },
  };
  for (const [name, mutate] of Object.entries(mutations)) await t.test(name, async () => {
    const input = options({ runDriver: args => writeReceipt(args, mutate) });
    const result = await runProducer(input);
    assert.equal(result.status, 'failed');
    await committed(input, result);
  });
});

test('failed final candidate read preserves completion while applicability stays unknown', async () => {
  let reads = 0;
  const input = options({ readCandidate: async () => {
    if (++reads === 4) throw new Error('private-read-error');
    return structuredClone(candidate);
  } });
  const result = await runProducer(input);
  assert.equal(result.applicability, 'unknown');
  assert.ok(!JSON.stringify(result).includes('private-read-error'));
  await access(join(input.outputDirectory, 'completion.json'));
  await committed(input, result);
});

test('existing bundle is refused without overwriting any file or running capture', async () => {
  let called = false;
  const input = options({ capture: async () => { called = true; throw new Error('unexpected'); } });
  await mkdir(input.outputDirectory);
  const marker = join(input.outputDirectory, 'envelope.json');
  await writeFile(marker, 'existing marker');
  await assert.rejects(runProducer(input));
  assert.equal(called, false);
  assert.equal(await readFile(marker, 'utf8'), 'existing marker');
});

test('invalid bounded inputs fail before capture', async () => {
  for (const invalid of [{ repository: '../escape' }, { pullRequest: 0 },
    { pullRequest: Number.MAX_SAFE_INTEGER + 1 }, { expectedHead: 'short' },
    { expectedBase: 'x'.repeat(40) }, { outputDirectory: 'relative' }]) {
    let called = false;
    await assert.rejects(runProducer(options({ ...invalid, capture: async () => { called = true; } })));
    assert.equal(called, false);
  }
});

test('oversized capture metadata leaves failure envelope and never runs the driver', async () => {
  let called = false;
  const input = options({ readCandidate: async () => ({ ...structuredClone(candidate), body: 'x'.repeat(128 * 1024 + 1) }),
    runDriver: async () => { called = true; } });
  const result = await runProducer(input);
  assert.equal(result.status, 'failed');
  assert.equal(called, false);
  await committed(input, result);
});

test('snapshot drift during the final pre-driver read blocks invocation', async () => {
  let reads = 0, called = false;
  const input = options();
  input.readCandidate = async () => {
    if (++reads === 3) {
      const { chmod } = await import('node:fs/promises');
      await chmod(join(input.outputDirectory, 'snapshot.json'), 0o600);
      await writeFile(join(input.outputDirectory, 'snapshot.json'), '{}');
    }
    return structuredClone(candidate);
  };
  input.runDriver = async () => { called = true; };
  const result = await runProducer(input);
  assert.equal(called, false);
  assert.equal(result.status, 'failed');
  assert.equal(result.failure, 'snapshot_changed');
  assert.equal(result.snapshot, null);
  await assert.rejects(access(join(input.outputDirectory, 'snapshot.json')));
  await committed(input, result);
});

test('oversized completion is discarded and never committed as completed', async () => {
  const input = options({ runDriver: async args => {
    const flags = flagsOf(args);
    await writeFile(flags['--receipt'], 'x'.repeat(256 * 1024 + 1));
    return { receiptPath: flags['--receipt'], snapshotSha256: flags['--snapshot-sha256'], status: 'completed' };
  } });
  const result = await runProducer(input);
  assert.equal(result.status, 'failed');
  assert.equal(result.completion, null);
  await assert.rejects(access(join(input.outputDirectory, 'completion.json')));
  await committed(input, result);
});

test('retained receipt mutation during final read is cleaned up as failed', async () => {
  let reads = 0;
  const input = options();
  input.readCandidate = async () => {
    if (++reads === 4) await writeFile(join(input.outputDirectory, 'completion.json'), '{}');
    return structuredClone(candidate);
  };
  const result = await runProducer(input);
  assert.equal(result.status, 'failed');
  assert.equal(result.completion, null);
  await assert.rejects(access(join(input.outputDirectory, 'completion.json')));
  await committed(input, result);
});

test('actual CLI acquisition child receives only its token and closed host configuration', async () => {
  const { chmod } = await import('node:fs/promises');
  const { fileURLToPath } = await import('node:url');
  const executable = join(root, 'fake-gh'), observed = join(root, 'gh-environment.json');
  const stale = structuredClone(candidate); stale.head.sha = 'e'.repeat(40);
  await writeFile(executable, `#!${process.execPath}\nimport {writeFileSync} from 'node:fs';\nwriteFileSync(${JSON.stringify(observed)}, JSON.stringify(process.env));\nprocess.stdout.write(${JSON.stringify(JSON.stringify(stale))});\n`);
  await chmod(executable, 0o700);
  const outputDirectory = join(root, randomUUID());
  assert.throws(() => execFileSync(process.execPath, [fileURLToPath(new URL('./reviewer-producer-run.mjs', import.meta.url)),
    '--repository', 'knitli/demo', '--pull-request', '7', '--expected-head', candidate.head.sha, '--expected-base', candidate.base.sha,
    '--output-directory', outputDirectory, '--sdk-directory', '/unused/sdk', '--claude-binary', '/unused/claude', '--gh-binary', executable, '--model', 'claude-sonnet-4-6'],
  { env: { PATH: '/usr/bin:/bin', GH_TOKEN: 'synthetic-github-token', ANTHROPIC_API_KEY: 'synthetic-model-key', UNRELATED_SECRET: 'synthetic-other' }, stdio: ['ignore', 'pipe', 'pipe'] }), { status: 1 });
  const env = JSON.parse(await readFile(observed, 'utf8'));
  assert.equal(env.GH_TOKEN, 'synthetic-github-token');
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  assert.equal(env.UNRELATED_SECRET, undefined);
  // macOS may add this runtime locale variable after execve.
  if (process.platform === 'darwin') delete env.__CF_USER_TEXT_ENCODING;
  assert.deepEqual(Object.keys(env).sort(), ['GH_CONFIG_DIR', 'GH_TOKEN', 'HOME', 'PATH']);
  const envelope = JSON.parse(await readFile(join(outputDirectory, 'envelope.json'), 'utf8'));
  assert.equal(envelope.status, 'failed');
  assert.equal(envelope.completion, null);
  assert.equal(envelope.roundCompletion, 'unknown');
});

test('symlink completion is refused without touching its target', async () => {
  const { rename, symlink } = await import('node:fs/promises');
  const target = join(root, 'outside-completion.json');
  let original;
  const input = options({ runDriver: async args => {
    const result = await writeReceipt(args);
    original = await readFile(result.receiptPath);
    await rename(result.receiptPath, target);
    await symlink(target, result.receiptPath);
    return result;
  } });
  const result = await runProducer(input);
  assert.equal(result.status, 'failed');
  assert.equal(result.completion, null);
  await assert.rejects(access(join(input.outputDirectory, 'completion.json')));
  assert.deepEqual(await readFile(target), original);
  await committed(input, result);
});

test('findings cannot point to phantom trailing-newline lines', async () => {
  const input = options({ runDriver: args => writeReceipt(args, receipt => {
    receipt.report.findings.push({ path: 'tracked.txt', side: 'after', line: 2, severity: 'low', message: 'not a real source line' });
  }) });
  assert.equal((await runProducer(input)).status, 'failed');
});

test('actual offline runReview receipt composes with producer and retains model identity', async () => {
  const input = options({ runDriver: async args => {
    const flags = flagsOf(args);
    let read;
    const sdk = {
      tool(_name, _description, _schema, handler) { read = handler; return {}; },
      createSdkMcpServer(value) { return value; },
      query({ options: config }) {
        const stream = (async function* () {
          yield { type: 'system', subtype: 'init', session_id: config.sessionId,
            model: config.model, tools: ['mcp__frozen__read_next'] };
          let remaining;
          do { remaining = JSON.parse((await read({})).content[0].text).remaining; } while (remaining);
          yield { type: 'result', subtype: 'success', is_error: false, terminal_reason: 'completed',
            modelUsage: { [config.model]: {} }, permission_denials: [], session_id: config.sessionId,
            uuid: randomUUID(), result: JSON.stringify({ schema: 'knitli-review-report:v1',
              snapshotSha256: flags['--snapshot-sha256'], findings: [], limitations: ['Offline synthetic SDK stream only'] }) };
        })();
        stream.close = () => {};
        return stream;
      },
    };
    const receipt = await runReview({ bytes: await readFile(flags['--snapshot']),
      expectedSha256: flags['--snapshot-sha256'], sdk, runtimeDirectory: root,
      binaryPath: '/never-invoked/claude', apiKey: 'synthetic-unused-key', model: flags['--model'] });
    await writeFile(flags['--receipt'], JSON.stringify(receipt));
    return { receiptPath: flags['--receipt'], snapshotSha256: flags['--snapshot-sha256'], status: 'completed' };
  } });
  const result = await runProducer(input);
  assert.equal(result.status, 'completed');
  for (const key of ['requestedModel', 'resolvedModel']) assert.equal(result.completion[key], input.model);
  assert.deepEqual(result.completion.usageModels, [input.model]);
  await committed(input, result);
});

test('rejects missing, mismatched, or extra receipt model identities', async t => {
  const cases = {
    missingRequested: receipt => { delete receipt.requestedModel; },
    missingResolved: receipt => { delete receipt.resolvedModel; },
    missingUsage: receipt => { delete receipt.usageModels; },
    wrongRequested: receipt => { receipt.requestedModel = 'claude-opus-4-6'; },
    wrongResolved: receipt => { receipt.resolvedModel = 'claude-opus-4-6'; },
    wrongUsage: receipt => { receipt.usageModels = ['claude-opus-4-6']; },
    extraUsage: receipt => { receipt.usageModels.push('claude-opus-4-6'); },
    duplicateUsage: receipt => { receipt.usageModels.push(receipt.resolvedModel); },
    emptyUsage: receipt => { receipt.usageModels = []; },
    malformedUsage: receipt => { receipt.usageModels = { 0: receipt.resolvedModel }; },
  };
  for (const [name, mutate] of Object.entries(cases)) await t.test(name, async () => {
    const input = options({ runDriver: args => writeReceipt(args, mutate) });
    const result = await runProducer(input);
    assert.equal(result.status, 'failed');
    assert.equal(result.failure, 'completion_invalid');
    assert.equal(result.completion, null);
    await assert.rejects(access(join(input.outputDirectory, 'completion.json')));
    await committed(input, result);
  });
});

test('rejects model aliases before capture', async () => {
  for (const model of ['claude-test', 'sonnet', 'claude-sonnet-latest']) {
    let called = false;
    await assert.rejects(runProducer(options({ model, capture: async () => { called = true; } })));
    assert.equal(called, false);
  }
});

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { composeAttemptEvidence } from './reviewer-attempt-evidence.mjs';
import { sdkStepName, stepName } from './reviewer-execution-receipt.mjs';
const attemptFixture = () => ({ repository: 'knitli/demo', repositoryId: 1, runId: '123', runAttempt: '2', checkRunId: '77',
  workflowRef: 'knitli/.github/.github/workflows/claude-pr-reviewer.yml@refs/heads/main', workflowSha: 'e'.repeat(40), producerRevision: 'e'.repeat(40) });
const hashBytes = bytes => createHash('sha256').update(bytes).digest('hex');
async function evidenceFixture({ mutateContext, stale = false } = {}) {
  const attempt = attemptFixture();
  let reads = 0, handoff;
  const input = options({ attemptContext: attempt, onPublished: value => { handoff = value; }, readCandidate: async () => {
    const value = structuredClone(candidate);
    if (stale && ++reads >= 4) value.head.sha = 'f'.repeat(40);
    mutateContext?.(attempt);
    return value;
  } });
  const envelope = await runProducer(input);
  assert.ok(handoff, 'actual producer delivered the host handoff');
  const run = { id: 123, run_attempt: 2, status: 'completed', conclusion: 'success', repository: { id: 1, full_name: 'knitli/demo' },
    referenced_workflows: [{ path: handoff.attempt.workflowRef, sha: handoff.attempt.workflowSha }] };
  const job = { id: 7, run_id: 123, check_run_url: 'https://api.github.com/repos/knitli/demo/check-runs/77',
    status: 'completed', conclusion: 'success', head_sha: candidate.head.sha,
    steps: [{ name: sdkStepName, number: 4, status: 'completed', conclusion: 'success' }] };
  const page = { total_count: 1, jobs: [job] };
  const calls = [];
  const composeOptions = { directory: input.outputDirectory, outputPath: join(root, `${randomUUID()}.evidence.json`),
    readTrustedHandoff: async () => handoff,
    get: endpoint => {
      calls.push(endpoint);
      if (endpoint === 'repos/knitli/demo/actions/runs/123/attempts/2') return run;
      if (endpoint === 'repos/knitli/demo/actions/runs/123/attempts/2/jobs?per_page=100&page=1') return page;
      throw new Error('unexpected authenticated endpoint');
    } };
  return { input, envelope, handoff, run, job, page, calls, composeOptions };
}

test('attempt composition binds independently acquired host digest to exact SDK job, never round completion', async () => {
  const h = await evidenceFixture({ mutateContext: context => { context.runAttempt = '9'; } });
  assert.deepEqual(h.envelope.attempt, attemptFixture());
  assert.equal(Object.isFrozen(h.envelope.attempt), true);
  assert.equal(Object.isFrozen(h.handoff), true);
  assert.equal(Object.isFrozen(h.handoff.attempt), true);
  assert.equal(h.handoff.envelopeSha256, hashBytes(await readFile(join(h.input.outputDirectory, 'envelope.json'))));
  assert.throws(() => { h.handoff.envelopeSha256 = 'f'.repeat(64); }, TypeError);
  assert.throws(() => { h.handoff.attempt.runAttempt = '9'; }, TypeError);
  const evidence = await composeAttemptEvidence(h.composeOptions);
  assert.equal(evidence.status, 'matched');
  assert.equal(evidence.execution.execution, 'succeeded');
  assert.equal(evidence.provenance, 'unverified');
  assert.equal(evidence.roundCompletion, 'unknown');
  assert.equal(evidence.execution.reviewCompletion, 'unknown');
  assert.deepEqual(JSON.parse(await readFile(h.composeOptions.outputPath)), evidence);
  assert.equal(h.calls.length, 2);
  await assert.rejects(composeAttemptEvidence(h.composeOptions), /EEXIST/);
});

test('publication handoff requires host callback and attempt identity before creating artifacts', async () => {
  let calls = 0;
  for (const extra of [{ onPublished: null, attemptContext: attemptFixture() },
    { onPublished: 'untrusted', attemptContext: attemptFixture() }, { onPublished: () => { calls++; } }]) {
    const input = options({ ...extra, capture: () => { calls++; } });
    await assert.rejects(runProducer(input), /handoff_arguments/);
    assert.equal(existsSync(input.outputDirectory), false);
  }
  assert.equal(calls, 0);
});

test('failed producer and incomplete envelope publication never deliver a handoff', async () => {
  for (const collision of [false, true]) {
    let callbacks = 0, drivers = 0;
    const input = options({ attemptContext: attemptFixture(), onPublished: () => { callbacks++; },
      runDriver: async args => {
        drivers++;
        if (!collision) {
          await writeFile(flagsOf(args)['--receipt'], '{partial');
          throw new Error('private driver failure');
        }
        const result = await writeReceipt(args);
        await writeFile(join(input.outputDirectory, 'envelope.json'), '{partial');
        return result;
      } });
    if (collision) {
      await assert.rejects(runProducer(input), /EEXIST/);
      assert.equal(await readFile(join(input.outputDirectory, 'envelope.json'), 'utf8'), '{partial');
    } else {
      const result = await runProducer(input);
      assert.equal(result.status, 'failed');
      await committed(input, result);
      await assert.rejects(access(join(input.outputDirectory, 'completion.json')));
    }
    assert.equal(callbacks, 0);
    assert.equal(drivers, 1);
  }
});

test('publication precedes awaited host handoff and the producer returns its existing envelope', async () => {
  let signalStarted, release, finished = false, captured;
  const started = new Promise(resolve => { signalStarted = resolve; });
  const blocked = new Promise(resolve => { release = resolve; });
  const input = options({ attemptContext: attemptFixture(), onPublished: async handoff => {
    captured = handoff;
    signalStarted();
    await blocked;
  } });
  const pending = runProducer(input).then(result => { finished = true; return result; });
  await Promise.race([started, pending.then(() => assert.fail('producer settled before host handoff'))]);
  try {
    const bytes = await readFile(join(input.outputDirectory, 'envelope.json'));
    assert.equal(JSON.parse(bytes).status, 'completed');
    assert.equal(captured.envelopeSha256, hashBytes(bytes));
    assert.equal((await stat(join(input.outputDirectory, 'envelope.json'))).mode & 0o777, 0o444);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(finished, false);
  } finally { release(); }
  await committed(input, await pending);
});

test('host handoff failure is sanitized and never rolls back or replays published work', async () => {
  let callbacks = 0, drivers = 0, captured;
  const input = options({ attemptContext: attemptFixture(), runDriver: args => { drivers++; return writeReceipt(args); },
    onPublished: async handoff => { callbacks++; captured = handoff; throw new Error('private host token'); } });
  await assert.rejects(runProducer(input), error => {
    assert.equal(error.code, 'handoff_failed');
    assert.equal(error.message, 'Reviewer producer refused: handoff_failed');
    assert.equal(error.cause, undefined);
    return true;
  });
  const bytes = await readFile(join(input.outputDirectory, 'envelope.json'));
  assert.equal(hashBytes(bytes), captured.envelopeSha256);
  assert.equal(JSON.parse(bytes).status, 'completed');
  await access(join(input.outputDirectory, 'completion.json'));
  await assert.rejects(runProducer(input), /EEXIST/);
  assert.equal(callbacks, 1);
  assert.equal(drivers, 1);
});

test('attempt context is complete and repository-bound before capture; no self-asserted handoff fallback', async () => {
  let calls = 0;
  for (const context of [{}, { ...attemptFixture(), runAttempt: 2 }, { ...attemptFixture(), repository: 'other/repo' },
    { ...attemptFixture(), workflowSha: 'f'.repeat(40) }]) {
    await assert.rejects(runProducer(options({ attemptContext: context, capture: () => { calls++; } })), /attempt_context/);
  }
  assert.equal(calls, 0);
  const h = await evidenceFixture();
  await assert.rejects(composeAttemptEvidence({ ...h.composeOptions, readTrustedHandoff: undefined }), /arguments/);
  await assert.rejects(composeAttemptEvidence({ ...h.composeOptions, readTrustedHandoff: async () => h.envelope }), /handoff/);
  assert.equal(h.calls.length, 0);
});

test('same-head retry and sibling check-run handoffs cannot bind a different producer attempt', async () => {
  for (const changes of [{ runAttempt: '1' }, { checkRunId: '99' }, { repositoryId: 2 },
    { workflowSha: 'f'.repeat(40), producerRevision: 'f'.repeat(40) }]) {
    const h = await evidenceFixture();
    h.composeOptions.readTrustedHandoff = async () => ({ ...h.handoff, attempt: { ...h.handoff.attempt, ...changes } });
    await assert.rejects(composeAttemptEvidence(h.composeOptions), /attempt_mismatch/);
    assert.equal(h.calls.length, 0);
  }
});

test('authenticated platform retry, sibling, old action, incomplete pagination and workflow drift never match', async () => {
  for (const mutate of [h => { h.run.run_attempt = 1; }, h => { h.job.check_run_url = 'https://api.github.com/repos/knitli/demo/check-runs/99'; },
    h => { h.job.steps[0].name = stepName; }, h => { h.page.total_count = 2; },
    h => { h.page.jobs.push({ ...h.job }); h.page.total_count = 2; },
    h => { h.run.referenced_workflows[0].sha = 'f'.repeat(40); }, h => { h.run.repository.id = 2; }]) {
    const h = await evidenceFixture(); mutate(h);
    const evidence = await composeAttemptEvidence(h.composeOptions);
    assert.equal(evidence.status, 'unavailable');
    assert.equal(evidence.execution.execution, 'unknown');
    assert.equal(evidence.roundCompletion, 'unknown');
  }
});

test('failed skipped cancelled nonterminal or unavailable execution never matches local successful completion', async () => {
  for (const conclusion of ['failure', 'skipped', 'cancelled', 'timed_out', 'neutral']) {
    const h = await evidenceFixture(); h.job.steps[0].conclusion = conclusion;
    assert.equal((await composeAttemptEvidence(h.composeOptions)).status, 'unavailable');
  }
  const h = await evidenceFixture(); h.job.status = 'in_progress';
  assert.equal((await composeAttemptEvidence(h.composeOptions)).status, 'unavailable');
  const other = await evidenceFixture(); other.composeOptions.get = () => { throw new Error('private token error'); };
  const evidence = await composeAttemptEvidence(other.composeOptions);
  assert.equal(evidence.status, 'unavailable');
  assert.doesNotMatch(JSON.stringify(evidence), /private token/);
});

test('altered bundle or context cannot substitute for independent retained host digest', async () => {
  for (const name of ['envelope.json', 'snapshot.json', 'completion.json']) {
    const h = await evidenceFixture();
    const file = join(h.input.outputDirectory, name);
    const { chmod } = await import('node:fs/promises'); await chmod(file, 0o600);
    await writeFile(file, `${await readFile(file)} `);
    await assert.rejects(composeAttemptEvidence(h.composeOptions));
    assert.equal(h.calls.length, 0);
  }
  const h = await evidenceFixture();
  h.composeOptions.readTrustedHandoff = async () => ({ ...h.handoff, envelopeSha256: 'f'.repeat(64) });
  await assert.rejects(composeAttemptEvidence(h.composeOptions), /envelope_digest/);
});

test('final acquisition cannot replace retained producer bytes', async () => {
  const h = await evidenceFixture();
  const original = h.composeOptions.get;
  const { chmodSync, appendFileSync } = await import('node:fs');
  h.composeOptions.get = endpoint => {
    const file = join(h.input.outputDirectory, 'envelope.json');
    chmodSync(file, 0o600); appendFileSync(file, ' ');
    return original(endpoint);
  };
  await assert.rejects(composeAttemptEvidence(h.composeOptions), /envelope_digest/);
  await assert.rejects(access(h.composeOptions.outputPath));
});

test('stale candidate stays historical even with exact successful execution evidence', async () => {
  const h = await evidenceFixture({ stale: true });
  const evidence = await composeAttemptEvidence(h.composeOptions);
  assert.equal(evidence.status, 'matched');
  assert.equal(evidence.applicability, 'stale');
  assert.equal(evidence.roundCompletion, 'unknown');
});

const cachedSdk = '/private/tmp/reviewer-sdk-0.3.209-source/package';
const cachedBinary = '/private/tmp/reviewer-sdk-native-0.3.209-source/package/claude';
test('actual cached pinned SDK and default producer driver fail before query without a model credential', {
  skip: !existsSync(join(cachedSdk, 'sdk.mjs')) || !existsSync(cachedBinary) || process.platform !== 'darwin' || process.arch !== 'arm64',
}, async () => {
  const input = options({ sdkDirectory: cachedSdk, claudeBinary: cachedBinary });
  // A clean subprocess cannot inherit a model credential. The real default driver pins and imports
  // the SDK, then rejects missing apiKey before constructing a query or spawning the native binary.
  const script = `import { runProducer } from ${JSON.stringify(new URL('./reviewer-producer-run.mjs', import.meta.url).href)};
import { captureSnapshot } from ${JSON.stringify(new URL('./reviewer-input-snapshot.mjs', import.meta.url).href)};
import { main as driverMain } from ${JSON.stringify(new URL('./reviewer-completion-driver.mjs', import.meta.url).href)};
const [input, candidate, repo] = JSON.parse(process.argv[1]);
const result = await runProducer({...input, readCandidate: async () => candidate, capture: options => captureSnapshot({...options, localRepository: repo})});
let driverFailure;
try { await driverMain(['--snapshot', input.outputDirectory+'/snapshot.json', '--snapshot-sha256', result.snapshot.sha256,
 '--sdk-directory', input.sdkDirectory, '--claude-binary', input.claudeBinary, '--model', input.model,
 '--receipt', input.outputDirectory+'/probe-completion.json']); } catch (error) { driverFailure = error.message; }
if (driverFailure !== 'Reviewer completion refused: options') throw new Error('Actual pinned SDK import/options boundary was not reached');
console.log(JSON.stringify(result));`;
  const serializable = { repository: input.repository, pullRequest: input.pullRequest, expectedHead: input.expectedHead,
    expectedBase: input.expectedBase, outputDirectory: input.outputDirectory, sdkDirectory: cachedSdk, claudeBinary: cachedBinary, model: input.model };
  const output = execFileSync(process.execPath, ['--input-type=module', '-e', script, JSON.stringify([serializable, candidate, repo])],
    { env: { PATH: '/usr/bin:/bin' }, encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024 });
  const result = JSON.parse(output);
  assert.equal(result.status, 'failed');
  assert.equal(result.failure, 'driver_failed');
  assert.ok(result.snapshot);
  assert.equal(result.completion, null);
  await assert.rejects(access(join(input.outputDirectory, 'completion.json')));
});


test('platform workflow ref aliases still require the exact immutable revision', async () => {
  const h = await evidenceFixture();
  h.run.referenced_workflows[0].path = h.run.referenced_workflows[0].path.replace('@refs/heads/main', '@main');
  assert.equal((await composeAttemptEvidence(h.composeOptions)).status, 'matched');
});


test('successful SDK step cannot override failed job or unfinished/failed run attempt', async () => {
  for (const mutate of [h => { h.job.conclusion = 'failure'; }, h => { h.job.conclusion = 'cancelled'; },
    h => { h.job.conclusion = 'skipped'; }, h => { h.run.status = 'in_progress'; },
    h => { h.run.conclusion = 'failure'; }, h => { h.run.conclusion = 'cancelled'; }]) {
    const h = await evidenceFixture(); mutate(h);
    const evidence = await composeAttemptEvidence(h.composeOptions);
    assert.equal(evidence.status, 'unavailable');
    assert.equal(evidence.execution.execution, 'unknown');
    assert.equal(evidence.roundCompletion, 'unknown');
  }
});


test('composition revalidates model summary and receipt against configured model', async t => {
  const changes = {
    summaryRequested: h => { h.envelope.completion.requestedModel = 'claude-opus-4-6'; },
    summaryResolved: h => { h.envelope.completion.resolvedModel = 'claude-opus-4-6'; },
    summaryUsage: h => { h.envelope.completion.usageModels = ['claude-opus-4-6']; },
    summaryAdditionalUsage: h => { h.envelope.completion.usageModels.push('claude-opus-4-6'); },
    configuredModel: h => { h.envelope.configured.model = 'claude-opus-4-6'; },
    configuredAlias: h => { h.envelope.configured.model = 'sonnet'; },
    receiptModel: async h => {
      const file = join(h.input.outputDirectory, 'completion.json');
      const receipt = JSON.parse(await readFile(file));
      receipt.requestedModel = receipt.resolvedModel = 'claude-opus-4-6';
      receipt.usageModels = ['claude-opus-4-6'];
      const bytes = Buffer.from(JSON.stringify(receipt));
      const { chmod } = await import('node:fs/promises'); await chmod(file, 0o600);
      await writeFile(file, bytes);
      Object.assign(h.envelope.completion, { sha256: hashBytes(bytes), bytes: bytes.length,
        requestedModel: receipt.requestedModel, resolvedModel: receipt.resolvedModel, usageModels: receipt.usageModels });
    },
  };
  for (const [name, change] of Object.entries(changes)) await t.test(name, async () => {
    const h = await evidenceFixture();
    await change(h);
    const file = join(h.input.outputDirectory, 'envelope.json');
    const { chmod } = await import('node:fs/promises'); await chmod(file, 0o600);
    const bytes = Buffer.from(JSON.stringify(h.envelope));
    await writeFile(file, bytes);
    h.composeOptions.readTrustedHandoff = async () => ({ ...h.handoff, envelopeSha256: hashBytes(bytes) });
    await assert.rejects(composeAttemptEvidence(h.composeOptions), /completion_invalid|snapshot_binding/);
    assert.equal(h.calls.length, 0);
    await assert.rejects(access(h.composeOptions.outputPath));
  });
});
