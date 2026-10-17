import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureSnapshot } from './reviewer-input-snapshot.mjs';
import { validateSnapshot } from './reviewer-completion-driver.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
let root, bytes, snapshot, trustedDigest;
before(async () => {
  root = await mkdtemp(join(tmpdir(), 'reviewer-completion-validation-'));
  const repo = join(root, 'repo');
  await mkdir(repo);
  const git = (...args) => execFileSync('/usr/bin/git', [
    '-c', 'user.name=Snapshot Test', '-c', 'user.email=snapshot@example.invalid',
    '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', '-C', repo, ...args,
  ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-q');
  await writeFile(join(repo, 'tracked.txt'), 'before café\n');
  await writeFile(join(repo, 'deleted.txt'), 'gone\n');
  git('add', '--all');
  git('commit', '-qm', 'base');
  const base = git('rev-parse', 'HEAD');
  await writeFile(join(repo, 'tracked.txt'), 'after café\n');
  await writeFile(join(repo, 'added.txt'), 'new\n');
  await writeFile(join(repo, 'empty.txt'), '');
  await rm(join(repo, 'deleted.txt'));
  git('add', '--all');
  git('commit', '-qm', 'head');
  const head = git('rev-parse', 'HEAD');
  const outputPath = join(root, 'snapshot.json');
  const result = await captureSnapshot({
    repository: 'knitli/demo', pullRequest: 7, expectedHead: head, expectedBase: base,
    outputPath, localRepository: repo,
    readCandidate: async () => ({ number: 7, title: 'Fixture', body: 'Untrusted description',
      base: { sha: base, repo: { id: 1, full_name: 'knitli/demo' } },
      head: { sha: head, repo: { id: 1, full_name: 'knitli/demo' } } }),
  });
  bytes = await readFile(outputPath);
  snapshot = JSON.parse(bytes);
  trustedDigest = result.artifactSha256;
});
after(async () => { if (root) await rm(root, { recursive: true, force: true }); });

function altered(change, refreshManifest = false) {
  const value = structuredClone(snapshot);
  change(value);
  if (refreshManifest) value.manifestSha256 = hash(JSON.stringify(value.manifest));
  const encoded = Buffer.from(JSON.stringify(value));
  return [encoded, hash(encoded)];
}

test('accepts a real capture with added, deleted, modified and non-ASCII text', () => {
  assert.deepEqual(validateSnapshot(bytes, trustedDigest), snapshot);
});

test('binds the exact full artifact bytes to the trusted digest', () => {
  assert.throws(() => validateSnapshot(Buffer.concat([bytes, Buffer.from(' ')]), trustedDigest));
  assert.throws(() => validateSnapshot(bytes, '0'.repeat(64)));
  for (const invalid of [undefined, null, '', 'xyz', trustedDigest.toUpperCase()]) {
    assert.throws(() => validateSnapshot(bytes, invalid));
  }
});

test('rejects a manifest whose digest was not refreshed', () => {
  assert.throws(() => validateSnapshot(...altered(value => { value.manifest.description.title = 'Changed'; })));
  assert.throws(() => validateSnapshot(...altered(value => { value.manifestSha256 = '0'.repeat(64); })));
});

test('verifies each captured file against the manifest', () => {
  for (const mutate of [
    value => { value.files.find(file => file.path === 'tracked.txt').before += 'tampered'; },
    value => { value.files.find(file => file.path === 'tracked.txt').after += 'tampered'; },
    value => { value.files[0].path = 'different.txt'; },
    value => { value.files.pop(); },
    value => { value.files.push(structuredClone(value.files[0])); },
    value => { value.files.find(file => file.path === 'added.txt').before = ''; },
    value => { value.files.find(file => file.path === 'deleted.txt').after = ''; },
  ]) assert.throws(() => validateSnapshot(...altered(mutate)));
});

test('verifies file byte counts, content digests and Git object identities', () => {
  for (const field of ['bytes', 'sha256', 'oid']) {
    assert.throws(() => validateSnapshot(...altered(value => {
      const metadata = value.manifest.files.find(file => file.path === 'tracked.txt').after;
      metadata[field] = field === 'bytes' ? metadata.bytes + 1 : '0'.repeat(field === 'oid' ? 40 : 64);
    }, true)), field);
  }
});

test('verifies diff content, digest and byte count', () => {
  assert.throws(() => validateSnapshot(...altered(value => { value.diff += '\nextra'; })));
  assert.throws(() => validateSnapshot(...altered(value => { value.manifest.diff.sha256 = '0'.repeat(64); }, true)));
  assert.throws(() => validateSnapshot(...altered(value => { value.manifest.diff.bytes += 1; }, true)));
});

test('rejects unknown schema fields even when all envelope digests match', () => {
  const targets = [
    value => value,
    value => value.manifest,
    value => value.manifest.repository,
    value => value.manifest.base,
    value => value.manifest.head,
    value => value.manifest.description,
    value => value.manifest.scope,
    value => value.manifest.files[0],
    value => value.manifest.files.find(file => file.path === 'tracked.txt').before,
    value => value.manifest.files.find(file => file.path === 'tracked.txt').after,
    value => value.manifest.diff,
    value => value.files[0],
  ];
  for (const [index, target] of targets.entries()) {
    assert.throws(() => validateSnapshot(...altered(value => { target(value).unexpected = true; }, true)), `target ${index}`);
  }
  assert.throws(() => validateSnapshot(...altered(value => { value.manifest.schema = 'knitli-reviewer-input:v2'; }, true)));
});

async function fakeRun(mode = 'success', overrides = {}, finding) {
  const { runReview } = await import('./reviewer-completion-driver.mjs');
  let handler, options, closed = false;
  const sdk = {
    tool(name, description, schema, callback) { assert.equal(name, 'read_next'); assert.deepEqual(schema, {}); handler = callback; return { name }; },
    createSdkMcpServer(config) { return config; },
    query(input) {
      options = input.options;
      const stream = (async function* () {
        const id = options.sessionId;
        const init = { type: 'system', subtype: 'init', session_id: id, model: 'claude-sonnet-4-6',
          tools: mode === 'rogue_tool' ? ['Bash'] : ['mcp__frozen__read_next'] };
        if (mode === 'missing_model') delete init.model;
        if (mode === 'malformed_model') init.model = { name: options.model };
        if (mode === 'empty_model') init.model = '';
        if (mode === 'mismatched_model') init.model = 'claude-opus-4-6';
        if (mode !== 'no_init') yield init;
        if (mode === 'model_fallback') yield { type: 'system', subtype: 'model_refusal_fallback', session_id: id,
          original_model: init.model, fallback_model: 'claude-opus-4-6' };
        if (mode === 'timeout') { await new Promise(() => {}); return; }
        if (mode !== 'omitted_coverage') {
          let remaining;
          do { const result = await handler({}); remaining = JSON.parse(result.content[0].text).remaining; } while (remaining);
        }
        if (mode === 'denied_tool') await options.canUseTool('Bash', {});
        if (mode === 'throw') throw new Error('provider transport error with secret');
        if (mode === 'no_terminal') return;
        const report = { schema: 'knitli-review-report:v1', snapshotSha256: trustedDigest, findings: [], limitations: ['Unchanged context not captured'] };
        if (finding) report.findings.push(finding);
        if (mode === 'bad_report') report.approved = true;
        if (mode === 'bad_finding') report.findings.push({ path: '/outside', side: 'after', line: 1, severity: 'high', message: 'bad' });
        const terminal = { type: 'result', subtype: mode === 'max_turns' ? 'error_max_turns' : 'success', is_error: mode === 'error',
          modelUsage: { 'claude-sonnet-4-6': {} }, terminal_reason: 'completed', permission_denials: [], session_id: mode === 'wrong_session' ? 'different' : id, uuid: 'terminal-uuid', result: JSON.stringify(report) };
        if (mode === 'missing_usage_model') delete terminal.modelUsage;
        if (mode === 'malformed_usage_model') terminal.modelUsage = ['claude-sonnet-4-6'];
        if (mode === 'empty_usage_model') terminal.modelUsage = {};
        if (mode === 'mismatched_usage_model') terminal.modelUsage = { 'claude-opus-4-6': {} };
        if (mode === 'additional_usage_model') terminal.modelUsage['claude-opus-4-6'] = {};
        if (mode === 'missing_session') delete terminal.session_id;
        if (mode === 'deferred') terminal.deferred_tool_use = {};
        yield terminal;
        if (mode === 'duplicate_terminal') yield terminal;
      })();
      stream.close = () => { closed = true; };
      return stream;
    },
  };
  const result = await runReview({ bytes, expectedSha256: trustedDigest, sdk, runtimeDirectory: root, binaryPath: join(root, 'claude'),
    apiKey: 'fake-api-key', model: 'claude-sonnet-4-6', timeoutMs: mode === 'timeout' ? 20 : 1000, ...overrides });
  return { result, options, closed };
}

test('binds actual SDK success shape to complete frozen reads and a closed advisory report', async () => {
  const { result, options, closed } = await fakeRun();
  assert.equal(result.status, 'completed');
  assert.equal(result.requestedModel, options.model);
  assert.equal(result.resolvedModel, 'claude-sonnet-4-6');
  assert.deepEqual(result.usageModels, ['claude-sonnet-4-6']);
  assert.equal(result.snapshotSha256, trustedDigest);
  assert.equal(result.coverage.pages, result.coverage.requiredPages);
  assert.equal(result.report.findings.length, 0);
  assert.equal(closed, true);
  assert.deepEqual(options.tools, []);
  assert.deepEqual(options.settingSources, []);
  assert.deepEqual(options.plugins, []);
  assert.deepEqual(options.skills, []);
  assert.equal(options.settings.disableAllHooks, true);
  assert.deepEqual(options.extraArgs, { bare: null, 'disable-slash-commands': null, 'no-chrome': null });
  assert.equal(options.strictMcpConfig, true);
  assert.equal(options.persistSession, false);
  assert.equal(options.env.GH_TOKEN, undefined);
  assert.equal(options.env.GITHUB_TOKEN, undefined);
  assert.equal(options.env.NODE_OPTIONS, undefined);
  assert.deepEqual(Object.keys(options.mcpServers), ['frozen']);
});

test('findings identify real source lines, excluding phantom trailing EOF elements', async () => {
  const finding = { path: 'added.txt', side: 'after', line: 1, severity: 'low', message: 'Fixture finding' };
  assert.equal((await fakeRun('success', {}, finding)).result.report.findings.length, 1);
  await assert.rejects(fakeRun('success', {}, { ...finding, line: 2 }), /refused: finding/);
  await assert.rejects(fakeRun('success', {}, { ...finding, path: 'empty.txt' }), /refused: finding/);
});

for (const mode of ['no_init', 'rogue_tool', 'omitted_coverage', 'denied_tool', 'throw', 'no_terminal', 'bad_report',
  'bad_finding', 'max_turns', 'error', 'wrong_session', 'missing_session', 'deferred', 'duplicate_terminal', 'timeout']) {
  test(`refuses completion for ${mode}`, async () => { await assert.rejects(fakeRun(mode)); });
}

test('owned real child is killed and observed exited before cleanup can proceed', async () => {
  const { createProcessOwner } = await import('./reviewer-completion-driver.mjs');
  const owner = createProcessOwner({ binaryPath: process.execPath, runtimeDirectory: root, graceMs: 20, killMs: 1000 });
  const child = owner.spawn({ command: process.execPath, cwd: root, env: { PATH: '/usr/bin:/bin' },
    args: ['-e', 'process.on("SIGTERM",()=>{});console.log("ready");setInterval(()=>{},1000)'] });
  await new Promise((resolve, reject) => { child.stdout.once('data', resolve); child.once('error', reject); });
  const stopped = await owner.stop();
  assert.deepEqual(stopped, { observed: true, clean: false });
  assert.equal(child.signalCode, 'SIGKILL');
  assert.throws(() => process.kill(child.pid, 0), { code: 'ESRCH' });
});

test('unconfirmed child exit stays unsafe after both kill signals', async () => {
  const { EventEmitter } = await import('node:events');
  const { createProcessOwner } = await import('./reviewer-completion-driver.mjs');
  const child = new EventEmitter(), signals = [];
  child.pid = 123; child.kill = signal => { signals.push(signal); return true; };
  const owner = createProcessOwner({ binaryPath: '/fake/claude', runtimeDirectory: root, spawn: () => child, graceMs: 1, killMs: 1 });
  owner.spawn({ command: '/fake/claude', cwd: root, env: {}, args: [] });
  assert.deepEqual(await owner.stop(), { observed: false, clean: false });
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
});

test('owned child clean exit and executable boundary are explicit', async () => {
  const { createProcessOwner } = await import('./reviewer-completion-driver.mjs');
  const owner = createProcessOwner({ binaryPath: process.execPath, runtimeDirectory: root });
  assert.throws(() => owner.spawn({ command: '/untrusted/command', cwd: root, env: {}, args: [] }));
  owner.spawn({ command: process.execPath, cwd: root, env: {}, args: ['-e', 'process.exit(0)'] });
  assert.deepEqual(await owner.stop(), { observed: true, clean: true });
});

test('pinned actual SDK normalizes extra read keys without creating semantic inputs', {
  skip: !process.env.REVIEWER_SDK_QUALIFICATION_DIR,
}, async () => {
  const { SDK_SHA256 } = await import('./reviewer-completion-driver.mjs');
  const { pathToFileURL } = await import('node:url');
  const sdkPath = join(process.env.REVIEWER_SDK_QUALIFICATION_DIR, 'sdk.mjs');
  assert.equal(hash(await readFile(sdkPath)), SDK_SHA256);
  const sdk = await import(pathToFileURL(sdkPath).href);
  const server = sdk.createSdkMcpServer({ name: 'frozen', tools: [sdk.tool('read_next', 'read', {}, async () => ({ content: [] }))] }).instance;
  assert.deepEqual(await server.validateToolInput(server._registeredTools.read_next, { path: '/etc/passwd' }, 'read_next'), {});
  await assert.rejects(server.validateToolInput(server._registeredTools.read_next, null, 'read_next'));
});

for (const mode of ['missing_model', 'malformed_model', 'empty_model', 'mismatched_model',
  'model_fallback', 'missing_usage_model', 'malformed_usage_model', 'empty_usage_model',
  'mismatched_usage_model', 'additional_usage_model']) {
  test(`refuses unverified model identity: ${mode}`, async () => {
    await assert.rejects(fakeRun(mode), /refused: model_identity/);
  });
}

test('resolved identity comes from initialization and aliases cannot claim canonical completion', async () => {
  for (const model of ['sonnet', 'claude-sonnet-4-6-latest', 'claude-opus-4-6']) {
    await assert.rejects(fakeRun('success', { model }), /refused: model_identity/);
  }
  const fixed = { sessionId: '11111111-1111-1111-1111-111111111111' };
  const before = (await fakeRun('success', fixed)).result;
  await assert.rejects(fakeRun('mismatched_model', fixed), /refused: model_identity/);
  assert.deepEqual((await fakeRun('success', fixed)).result, before);
});
