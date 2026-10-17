import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureSnapshot } from './reviewer-input-snapshot.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const git = (repo, ...args) => execFileSync('/usr/bin/git', [
  '-c', 'user.name=Snapshot Test', '-c', 'user.email=snapshot@example.invalid',
  '-c', 'commit.gpgsign=false', '-C', repo, ...args,
], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

async function fixture(t, before = { 'tracked.txt': 'before\n' }, after = { 'tracked.txt': 'after\n' }) {
  const root = await mkdtemp(join(tmpdir(), 'reviewer-snapshot-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = join(root, 'repo');
  await mkdir(repo);
  git(repo, 'init', '-q');
  async function put(files) {
    for (const [path, contents] of Object.entries(files)) {
      if (contents === null) await rm(join(repo, path));
      else await writeFile(join(repo, path), contents);
    }
  }
  await put(before);
  const commit = () => {
    git(repo, 'add', '--all');
    git(repo, 'commit', '--allow-empty', '-qm', 'fixture');
    return git(repo, 'rev-parse', 'HEAD');
  };
  const base = commit();
  await put(after);
  const head = commit();
  const candidate = {
    number: 7, title: 'Review fixture', body: 'Untrusted PR description',
    base: { sha: base, repo: { id: 1, full_name: 'knitli/demo' } },
    head: { sha: head, repo: { id: 1, full_name: 'knitli/demo' } },
  };
  const outputPath = join(root, 'snapshot.json');
  const options = {
    repository: 'knitli/demo', pullRequest: 7, expectedHead: head, expectedBase: base,
    outputPath, localRepository: repo, readCandidate: async () => structuredClone(candidate),
  };
  return { repo, root, base, head, candidate, options, commit };
}

async function rejectedWithoutArtifact(f, overrides = {}) {
  await assert.rejects(captureSnapshot({ ...f.options, ...overrides }));
  await assert.rejects(access(f.options.outputPath), { code: 'ENOENT' });
}

test('captures real added, deleted and modified text with verified content digests', async t => {
  const f = await fixture(t, { 'tracked.txt': 'before\n', 'deleted.txt': 'gone\n' },
    { 'tracked.txt': 'after\n', 'deleted.txt': null, 'added.txt': 'new\n' });
  const result = await captureSnapshot(f.options);
  const bytes = await readFile(f.options.outputPath);
  const artifact = JSON.parse(bytes);
  assert.equal(result.artifactPath, f.options.outputPath);
  assert.equal(result.artifactSha256, hash(bytes));
  assert.equal(result.manifestSha256, artifact.manifestSha256);
  assert.equal(result.files, 3);
  assert.equal(artifact.manifest.schema, 'knitli-reviewer-input:v1');
  assert.deepEqual(artifact.manifest.repository, { id: 1, fullName: 'knitli/demo' });
  assert.equal(artifact.manifest.pullRequest, 7);
  assert.equal(artifact.manifest.base.sha, f.base);
  assert.equal(artifact.manifest.head.sha, f.head);
  assert.equal(artifact.manifest.mergeBase, f.base);
  assert.deepEqual(artifact.manifest.description, { title: f.candidate.title, body: f.candidate.body });
  const files = new Map(artifact.files.map(file => [file.path, file]));
  assert.deepEqual(files.get('added.txt'), { path: 'added.txt', before: null, after: 'new\n' });
  assert.deepEqual(files.get('deleted.txt'), { path: 'deleted.txt', before: 'gone\n', after: null });
  assert.deepEqual(files.get('tracked.txt'), { path: 'tracked.txt', before: 'before\n', after: 'after\n' });
  for (const file of artifact.manifest.files) {
    assert.equal(file.status, file.path === 'added.txt' ? 'added' : file.path === 'deleted.txt' ? 'deleted' : 'modified');
    for (const side of ['before', 'after']) {
      const content = files.get(file.path)[side];
      if (content === null) assert.equal(file[side], null);
      else {
        assert.equal(file[side].bytes, Buffer.byteLength(content));
        assert.equal(file[side].sha256, hash(content));
        assert.equal(file[side].mode, '100644');
        assert.match(file[side].oid, /^[0-9a-f]{40}$/);
      }
    }
  }
  assert.equal(artifact.manifest.diff.bytes, Buffer.byteLength(artifact.diff));
  assert.equal(artifact.manifest.diff.sha256, hash(artifact.diff));
  assert.match(artifact.diff, /before/);
  assert.match(artifact.diff, /after/);
});

test('preserves non-ASCII, newline, tab and leading-dash filenames', async t => {
  const paths = ['café.txt', 'line\nbreak.txt', 'tab\tname.txt', '-option.txt'];
  const f = await fixture(t, {}, Object.fromEntries(paths.map(path => [path, `text: ${path}\n`])));
  await captureSnapshot(f.options);
  const artifact = JSON.parse(await readFile(f.options.outputPath, 'utf8'));
  assert.deepEqual(artifact.files.map(file => file.path).sort(), paths.sort());
  for (const file of artifact.files) assert.equal(file.after, `text: ${file.path}\n`);
});

test('represents a rename as deletion plus addition', async t => {
  const f = await fixture(t, { 'old.txt': 'same contents\n' }, { 'old.txt': null, 'new.txt': 'same contents\n' });
  await captureSnapshot(f.options);
  const artifact = JSON.parse(await readFile(f.options.outputPath, 'utf8'));
  assert.deepEqual(artifact.manifest.files.map(({ path, status }) => ({ path, status })),
    [{ path: 'new.txt', status: 'added' }, { path: 'old.txt', status: 'deleted' }]);
});

for (const [label, contents] of [['NUL binary', Buffer.from([65, 0, 66])], ['invalid UTF-8', Buffer.from([0xc3, 0x28])]]) {
  test(`rejects ${label} without producing an artifact`, async t => {
    const f = await fixture(t, {}, { 'bad.txt': contents });
    await rejectedWithoutArtifact(f);
  });
}

test('rejects symlinks without producing an artifact', async t => {
  const f = await fixture(t);
  await symlink('tracked.txt', join(f.repo, 'link.txt'));
  f.candidate.head.sha = f.options.expectedHead = f.commit();
  await rejectedWithoutArtifact(f);
});

test('accepts a root commit as the base ancestor', async t => {
  const f = await fixture(t);
  assert.equal(git(f.repo, 'rev-list', '--count', f.base), '1');
  await captureSnapshot(f.options);
  assert.equal(JSON.parse(await readFile(f.options.outputPath, 'utf8')).manifest.mergeBase, f.base);
});

test('rejects unrelated roots', async t => {
  const f = await fixture(t);
  git(f.repo, 'checkout', '--orphan', 'unrelated');
  f.candidate.head.sha = f.options.expectedHead = f.commit();
  await rejectedWithoutArtifact(f);
});

test('rejects missing pinned objects', async t => {
  const f = await fixture(t);
  f.candidate.head.sha = f.options.expectedHead = 'f'.repeat(40);
  await rejectedWithoutArtifact(f);
});

for (const limits of [{ files: 1 }, { blobBytes: 1 }, { diffBytes: 1 }, { artifactBytes: 1 }]) {
  test(`enforces ${Object.keys(limits)[0]} limit without producing an artifact`, async t => {
    const f = await fixture(t, {}, { 'one.txt': 'one\n', 'two.txt': 'two\n' });
    await rejectedWithoutArtifact(f, { limits });
  });
}

for (const field of ['head', 'base', 'title', 'body']) {
  test(`rejects changed ${field} on the second candidate read`, async t => {
    const f = await fixture(t);
    let reads = 0;
    await rejectedWithoutArtifact(f, { readCandidate: async () => {
      const candidate = structuredClone(f.candidate);
      if (++reads > 1) {
        if (field === 'head' || field === 'base') candidate[field].sha = 'e'.repeat(40);
        else candidate[field] += ' changed';
      }
      return candidate;
    } });
    assert.ok(reads >= 2);
  });
}

test('refuses to overwrite an existing output', async t => {
  const f = await fixture(t);
  await writeFile(f.options.outputPath, 'existing artifact');
  await assert.rejects(captureSnapshot(f.options));
  assert.equal(await readFile(f.options.outputPath, 'utf8'), 'existing artifact');
});

test('rejects a shallow crisscross graph hiding a second merge base', async t => {
  const f = await fixture(t);
  const tree = git(f.repo, 'rev-parse', `${f.base}^{tree}`);
  const commit = (label, parents) => git(f.repo, 'commit-tree', tree, ...parents.flatMap(p => ['-p', p]), '-m', label);
  const a = commit('a', [f.base]), b = commit('b', [f.base]);
  const b1 = commit('b1', [b]), b2 = commit('b2', [b1]);
  const base = commit('base merge', [a, b]), head = commit('head merge', [a, b2]);
  assert.deepEqual(new Set(git(f.repo, 'merge-base', '--all', base, head).split('\n')), new Set([a, b]));
  const shallow = join(f.root, 'shallow');
  await mkdir(shallow);
  git(shallow, 'init', '--bare', '-q');
  for (const sha of [base, head]) git(shallow, 'fetch', '--depth=3', `file://${f.repo}`, sha);
  assert.equal(git(shallow, 'merge-base', '--all', base, head), a, 'truncated graph falsely presents one merge base');
  f.candidate.base.sha = f.options.expectedBase = base;
  f.candidate.head.sha = f.options.expectedHead = head;
  await assert.rejects(captureSnapshot({ ...f.options, limits: { historyDepth: 3 } }), { code: 'incomplete_history' });
  await assert.rejects(access(f.options.outputPath), { code: 'ENOENT' });
});

test('accepts shallow boundaries proven ancestors of the selected merge base', async t => {
  const f = await fixture(t);
  const base = f.commit(), head = f.commit();
  f.candidate.base.sha = f.options.expectedBase = base;
  f.candidate.head.sha = f.options.expectedHead = head;
  await captureSnapshot({ ...f.options, limits: { historyDepth: 2 } });
  assert.equal(JSON.parse(await readFile(f.options.outputPath, 'utf8')).manifest.mergeBase, base);
});

test('rejects inherited limit names', async t => {
  const f = await fixture(t);
  await assert.rejects(captureSnapshot({ ...f.options, limits: { toString: 1 } }), { code: 'input_invalid' });
});

test('rejects non-UTF8 Git filenames', async t => {
  const f = await fixture(t);
  const blob = git(f.repo, 'rev-parse', `${f.head}:tracked.txt`);
  const tree = execFileSync('/usr/bin/git', ['-C', f.repo, 'mktree', '-z'], {
    input: Buffer.concat([Buffer.from(`100644 blob ${blob}\t`), Buffer.from([0xff, 0])]), encoding: 'utf8',
  }).trim();
  f.candidate.head.sha = f.options.expectedHead = git(f.repo, 'commit-tree', tree, '-p', f.base, '-m', 'invalid filename');
  await rejectedWithoutArtifact(f);
});

test('rejects gitlinks', async t => {
  const f = await fixture(t);
  git(f.repo, 'update-index', '--add', '--cacheinfo', `160000,${f.base},module`);
  git(f.repo, 'commit', '-qm', 'gitlink');
  f.candidate.head.sha = f.options.expectedHead = git(f.repo, 'rev-parse', 'HEAD');
  await rejectedWithoutArtifact(f);
});

test('captures executable mode changes', async t => {
  const f = await fixture(t);
  git(f.repo, 'update-index', '--chmod=+x', 'tracked.txt');
  git(f.repo, 'commit', '-qm', 'mode');
  f.candidate.head.sha = f.options.expectedHead = git(f.repo, 'rev-parse', 'HEAD');
  await captureSnapshot(f.options);
  const file = JSON.parse(await readFile(f.options.outputPath, 'utf8')).manifest.files[0];
  assert.equal(file.before.mode, '100644');
  assert.equal(file.after.mode, '100755');
});

test('captures identical root base and head with empty diff', async t => {
  const f = await fixture(t);
  f.candidate.head.sha = f.options.expectedHead = f.base;
  await captureSnapshot(f.options);
  const artifact = JSON.parse(await readFile(f.options.outputPath, 'utf8'));
  assert.deepEqual(artifact.files, []);
  assert.equal(artifact.diff, '');
});

for (const limits of [{ totalBlobBytes: 1 }, { gitOutputBytes: 1 }]) {
  test(`enforces ${Object.keys(limits)[0]} limit`, async t => {
    const f = await fixture(t);
    await rejectedWithoutArtifact(f, { limits });
  });
}

test('refuses a dangling output symlink', async t => {
  const f = await fixture(t);
  await symlink(join(f.root, 'missing'), f.options.outputPath);
  await assert.rejects(captureSnapshot(f.options), { code: 'artifact_exists' });
});

test('never overwrites a destination created during capture', async t => {
  const f = await fixture(t);
  let reads = 0;
  await assert.rejects(captureSnapshot({ ...f.options, readCandidate: async () => {
    if (++reads === 2) await writeFile(f.options.outputPath, 'concurrent artifact');
    return structuredClone(f.candidate);
  } }), { code: 'artifact_exists' });
  assert.equal(await readFile(f.options.outputPath, 'utf8'), 'concurrent artifact');
});
