import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, existsSync, fchmodSync, fsyncSync, linkSync, lstatSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const LIMITS = Object.freeze({ files: 256, blobBytes: 1024 * 1024, totalBlobBytes: 8 * 1024 * 1024,
  diffBytes: 4 * 1024 * 1024, artifactBytes: 32 * 1024 * 1024, metadataBytes: 128 * 1024,
  pathBytes: 4096, gitOutputBytes: 2 * 1024 * 1024, gitTimeoutMs: 30_000, historyDepth: 256 });
const SHA = /^[a-f0-9]{40}$/;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const positive = value => Number.isSafeInteger(value) && value > 0;
export class SnapshotError extends Error {
  constructor(code) { super(`Reviewer input snapshot refused: ${code}`); this.code = code; }
}
const refuse = code => { throw new SnapshotError(code); };
const text = bytes => {
  try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { return refuse('unsupported_encoding'); }
};
const boundedText = (value, maximum) => {
  if (typeof value !== 'string' || Buffer.byteLength(value) > maximum || text(Buffer.from(value)) !== value) refuse('input_invalid');
  return value;
};
function limitsOf(overrides = {}) {
  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) refuse('input_invalid');
  for (const [key, value] of Object.entries(overrides)) {
    if (!Object.hasOwn(LIMITS, key) || !positive(value) || value > LIMITS[key]) refuse('input_invalid');
  }
  return { ...LIMITS, ...overrides };
}
function candidateOf(value, repository, pullRequest, limits) {
  if (!value || value.number !== pullRequest || !value.base?.repo || !value.head?.repo) refuse('input_invalid');
  const branch = input => {
    if (!SHA.test(input.sha) || !positive(input.repo.id) || typeof input.repo.full_name !== 'string'
      || !REPOSITORY.test(input.repo.full_name)) refuse('input_invalid');
    return { repositoryId: input.repo.id, repository: input.repo.full_name, sha: input.sha };
  };
  const base = branch(value.base), head = branch(value.head);
  if (base.repository !== repository) refuse('input_invalid');
  const description = { title: boundedText(value.title, limits.metadataBytes), body: boundedText(value.body ?? '', limits.metadataBytes) };
  if (Buffer.byteLength(JSON.stringify(description)) > limits.metadataBytes) refuse('limit_exceeded');
  return { repository: { id: base.repositoryId, fullName: repository }, pullRequest, base, head, description };
}
function gitRunner(directory, limits, token, local) {
  // Do not inherit repository, global/system config, helper, proxy, replace-object or pager controls.
  const env = { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C', TZ: 'UTC', GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_GLOBAL: '/dev/null', GIT_ATTR_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0', GIT_NO_REPLACE_OBJECTS: '1', GIT_OPTIONAL_LOCKS: '0' };
  if (token) {
    env.GIT_CONFIG_COUNT = '1'; env.GIT_CONFIG_KEY_0 = 'http.https://github.com/.extraheader';
    env.GIT_CONFIG_VALUE_0 = `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`;
  }
  const options = ['--no-pager', '-c', 'core.hooksPath=/dev/null', '-c', 'core.attributesFile=/dev/null',
    '-c', 'credential.helper=', '-c', 'http.followRedirects=false', '-c', 'protocol.allow=never',
    '-c', 'protocol.https.allow=always', '-c', `protocol.file.allow=${local ? 'always' : 'never'}`,
    '-c', 'uploadpack.packObjectsHook=', '-c', 'init.defaultBranch=snapshot', '-c', 'core.quotePath=true'];
  return (args, maximum = limits.gitOutputBytes) => {
    try {
      return execFileSync('/usr/bin/git', [...options, ...args], { cwd: directory, env, timeout: limits.gitTimeoutMs,
        maxBuffer: maximum, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      // Neither provider errors nor credentials/source contents enter the diagnostic channel.
      refuse(error.code === 'ENOBUFS' ? 'limit_exceeded' : 'git_failed');
    }
  };
}
function parseChanges(raw, limits) {
  if (raw.length && raw.at(-1) !== 0) refuse('incomplete_diff');
  const parts = []; let start = 0;
  for (let index = 0; index < raw.length; index++) if (raw[index] === 0) { parts.push(raw.subarray(start, index)); start = index + 1; }
  if (parts.length % 2) refuse('incomplete_diff');
  const files = [], seen = new Set();
  for (let index = 0; index < parts.length; index += 2) {
    const match = /^:([0-7]{6}) ([0-7]{6}) ([a-f0-9]{40}) ([a-f0-9]{40}) ([AMDT])$/.exec(text(parts[index]));
    const pathBytes = parts[index + 1];
    if (!match || !pathBytes.length || pathBytes.length > limits.pathBytes) refuse('unsupported_file');
    const path = text(pathBytes);
    if (path.startsWith('/') || path.split('/').some(part => !part || part === '.' || part === '..') || seen.has(path)) refuse('unsupported_file');
    seen.add(path);
    const [, beforeMode, afterMode, beforeOid, afterOid, status] = match;
    for (const [mode, oid] of [[beforeMode, beforeOid], [afterMode, afterOid]]) {
      if (mode === '000000' ? oid !== '0'.repeat(40) : !['100644', '100755'].includes(mode) || oid === '0'.repeat(40)) refuse('unsupported_file');
    }
    if ((status === 'A') !== (beforeMode === '000000') || (status === 'D') !== (afterMode === '000000')) refuse('incomplete_diff');
    files.push({ path, status: status === 'A' ? 'added' : status === 'D' ? 'deleted' : 'modified', beforeMode, afterMode, beforeOid, afterOid });
    if (files.length > limits.files) refuse('limit_exceeded');
  }
  return files.sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
}
function publish(outputPath, bytes) {
  if (existsSync(outputPath)) refuse('artifact_exists');
  try { lstatSync(outputPath); refuse('artifact_exists'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const parent = realpathSync(dirname(outputPath));
  const temporary = mkdtempSync(join(parent, '.reviewer-input-'));
  const staged = join(temporary, 'snapshot.json'); let fd;
  try {
    fd = openSync(staged, 'wx', 0o600); writeFileSync(fd, bytes); fsyncSync(fd); fchmodSync(fd, 0o444); closeSync(fd); fd = undefined;
    // link(2) publishes complete bytes atomically and never replaces a concurrent destination.
    try { linkSync(staged, join(parent, basename(outputPath))); }
    catch (error) { if (error.code === 'EEXIST') refuse('artifact_exists'); throw error; }
  } finally { if (fd !== undefined) closeSync(fd); rmSync(temporary, { recursive: true, force: true }); }
}

/** Capture only; no model invocation, review-completion claim, or repository execution. */
export async function captureSnapshot({ repository, pullRequest, expectedHead, expectedBase, outputPath, readCandidate,
  localRepository, token, limits: overrides } = {}) {
  const limits = limitsOf(overrides);
  if (typeof repository !== 'string' || !REPOSITORY.test(repository) || !positive(pullRequest)
    || !SHA.test(expectedHead) || !SHA.test(expectedBase) || typeof outputPath !== 'string' || !isAbsolute(outputPath)
    || typeof readCandidate !== 'function' || localRepository !== undefined && (typeof localRepository !== 'string' || !isAbsolute(localRepository))) refuse('input_invalid');
  if (existsSync(outputPath)) refuse('artifact_exists');
  const before = candidateOf(await readCandidate(), repository, pullRequest, limits);
  if (before.head.sha !== expectedHead || before.base.sha !== expectedBase) refuse('candidate_changed');
  const temporary = mkdtempSync(join(tmpdir(), 'reviewer-input-git-'));
  try {
    const git = gitRunner(temporary, limits, token, localRepository !== undefined);
    git(['init', '--bare', '--object-format=sha1', '.']);
    const sources = [[before.base.repository, before.base.sha], [before.head.repository, before.head.sha]];
    const fetched = new Set();
    for (const [name, sha] of sources) {
      const url = localRepository === undefined ? `https://github.com/${name}.git` : `file://${realpathSync(localRepository)}`;
      const key = `${url}\n${sha}`;
      if (fetched.has(key)) continue;
      git(['fetch', '--no-tags', '--no-write-fetch-head', '--no-recurse-submodules', `--depth=${limits.historyDepth}`, '--', url, sha]);
      fetched.add(key);
      if (text(git(['cat-file', '-t', sha])).trim() !== 'commit') refuse('input_invalid');
    }
    let bases;
    try { bases = text(git(['merge-base', '--all', before.base.sha, before.head.sha])).trim().split('\n'); }
    catch (error) { if (error instanceof SnapshotError && error.code === 'git_failed') refuse('merge_base_unavailable'); throw error; }
    if (bases.length !== 1 || !SHA.test(bases[0])) refuse('merge_base_unavailable');
    const mergeBase = bases[0];
    // A shallow graph can hide a second best common ancestor. Every reachable
    // truncation must already lie behind the selected base before trusting it.
    if (existsSync(join(temporary, 'shallow'))) {
      const boundaries = new Set(text(readFileSync(join(temporary, 'shallow'))).trim().split('\n'));
      const reachable = new Set(text(git(['rev-list', before.base.sha, before.head.sha])).trim().split('\n'));
      for (const boundary of boundaries) {
        if (!SHA.test(boundary)) refuse('incomplete_history');
        if (!reachable.has(boundary)) continue;
        try { git(['merge-base', '--is-ancestor', boundary, mergeBase]); }
        catch { refuse('incomplete_history'); }
      }
    }
    const changed = parseChanges(git(['diff-tree', '-r', '--no-commit-id', '--raw', '-z', '--no-abbrev', '--no-renames', mergeBase, before.head.sha, '--']), limits);
    let totalBlobBytes = 0;
    const files = [], manifestFiles = [];
    const blob = (mode, oid) => {
      if (mode === '000000') return null;
      const sizeValue = text(git(['cat-file', '-s', oid])).trim();
      if (!/^(0|[1-9][0-9]*)$/.test(sizeValue)) refuse('incomplete_blob');
      const size = Number(sizeValue);
      if (!Number.isSafeInteger(size) || size > limits.blobBytes || totalBlobBytes + size > limits.totalBlobBytes) refuse('limit_exceeded');
      const bytes = git(['cat-file', 'blob', oid], Math.max(1, limits.blobBytes));
      if (bytes.length !== size) refuse('incomplete_blob');
      if (bytes.includes(0)) refuse('unsupported_file');
      const content = text(bytes); totalBlobBytes += size;
      return { content, metadata: { oid, mode, bytes: size, sha256: digest(bytes) } };
    };
    for (const file of changed) {
      const old = blob(file.beforeMode, file.beforeOid), next = blob(file.afterMode, file.afterOid);
      files.push({ path: file.path, before: old?.content ?? null, after: next?.content ?? null });
      manifestFiles.push({ path: file.path, status: file.status, before: old?.metadata ?? null, after: next?.metadata ?? null });
    }
    const diffBytes = git(['diff', '--no-ext-diff', '--no-textconv', '--binary', '--full-index', '--no-renames', '--no-color',
      '--no-relative', '--no-indent-heuristic', '--diff-algorithm=myers', '--unified=3', '--src-prefix=a/', '--dst-prefix=b/',
      '--ignore-submodules=none', mergeBase, before.head.sha, '--'], limits.diffBytes);
    if (diffBytes.length > limits.diffBytes) refuse('limit_exceeded');
    const diff = text(diffBytes);
    const manifest = { schema: 'knitli-reviewer-input:v1', ...before, mergeBase,
      scope: { kind: 'regular-utf8-text', comparison: 'merge-base-to-head', renameDetection: false, submodules: 'refused',
        historyDepth: limits.historyDepth, sourceExecution: false }, files: manifestFiles,
      diff: { bytes: diffBytes.length, sha256: digest(diffBytes) } };
    const manifestSha256 = digest(Buffer.from(JSON.stringify(manifest)));
    const bytes = Buffer.from(`${JSON.stringify({ manifest, manifestSha256, files, diff }, null, 2)}\n`);
    if (bytes.length > limits.artifactBytes) refuse('limit_exceeded');
    const after = candidateOf(await readCandidate(), repository, pullRequest, limits);
    if (JSON.stringify(after) !== JSON.stringify(before)) refuse('candidate_changed');
    publish(outputPath, bytes);
    return { artifactPath: outputPath, artifactSha256: digest(bytes), manifestSha256, files: files.length };
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}

function cliArgs(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    if (!['--repository', '--pull-request', '--expected-head', '--expected-base', '--output'].includes(key)
      || options[key] !== undefined || !args[index + 1]) refuse('input_invalid');
    options[key] = args[index + 1];
  }
  return { repository: options['--repository'], pullRequest: Number(options['--pull-request']), expectedHead: options['--expected-head'],
    expectedBase: options['--expected-base'], outputPath: options['--output'] && resolve(options['--output']) };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const options = cliArgs(process.argv.slice(2));
    if (!REPOSITORY.test(options.repository ?? '') || !positive(options.pullRequest)) refuse('input_invalid');
    const readCandidate = async () => {
      try {
        const bytes = execFileSync('gh', ['api', '--hostname', 'github.com', '-H', 'X-GitHub-Api-Version: 2026-03-10',
          `repos/${options.repository}/pulls/${options.pullRequest}`], { encoding: 'utf8', timeout: LIMITS.gitTimeoutMs,
          maxBuffer: LIMITS.gitOutputBytes, stdio: ['ignore', 'pipe', 'pipe'] });
        return JSON.parse(bytes);
      } catch { return refuse('candidate_unavailable'); }
    };
    process.stdout.write(`${JSON.stringify(await captureSnapshot({ ...options, readCandidate, token: process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN }))}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof SnapshotError ? error.message : 'Reviewer input snapshot refused: unavailable'}\n`);
    process.exitCode = 1;
  }
}
