import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, rm, stat, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureSnapshot } from './reviewer-input-snapshot.mjs';
import { SDK_VERSION } from './reviewer-completion-driver.mjs';
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
    provider: 'claude-agent-sdk', sdkVersion: SDK_VERSION, sessionId: randomUUID(), terminalUuid: randomUUID(),
    snapshotSha256: flags['--snapshot-sha256'], manifestSha256: snapshot.manifestSha256,
    coverage: { pages: 4, requiredPages: 4, files: snapshot.files.length },
    report: { schema: 'knitli-review-report:v1', snapshotSha256: flags['--snapshot-sha256'], findings: [], limitations: [] } };
  mutate(receipt);
  await writeFile(flags['--receipt'], JSON.stringify(receipt));
  return { receiptPath: flags['--receipt'], snapshotSha256: flags['--snapshot-sha256'], status: 'completed' };
}
function options(overrides = {}) {
  return { sdkDirectory: '/trusted/sdk', claudeBinary: '/trusted/claude', model: 'claude-test', repository: 'knitli/demo', pullRequest: 7, expectedHead: candidate.head.sha,
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
    '--output-directory', outputDirectory, '--sdk-directory', '/unused/sdk', '--claude-binary', '/unused/claude', '--gh-binary', executable, '--model', 'claude-test'],
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
