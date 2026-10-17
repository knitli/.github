import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { captureSnapshot } from '../../reviewer-input-snapshot.mjs';
import { SDK_VERSION } from '../../reviewer-completion-driver.mjs';

/** Provider-free fixture only. No SDK import, native client or caller/PR checkout. */
export async function prepareSyntheticProducer({ directory, attemptContext }) {
  if (typeof directory !== 'string' || !isAbsolute(directory)) throw new Error('absolute fixture directory required');
  await mkdir(directory, { mode: 0o700 });
  const repository = join(directory, 'repo'); await mkdir(repository);
  const git = (...args) => execFileSync('/usr/bin/git', ['-c', 'user.name=Host Fixture', '-c', 'user.email=fixture@example.invalid',
    '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', '-C', repository, ...args],
  { encoding: 'utf8', stdio: 'pipe', timeout: 10_000, maxBuffer: 1024 * 1024,
    env: { PATH: '/usr/bin:/bin', HOME: directory, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } }).trim();
  git('init', '-q'); await writeFile(join(repository, 'file.txt'), 'before\n'); git('add', '--all'); git('commit', '-qm', 'base');
  const base = git('rev-parse', 'HEAD');
  await writeFile(join(repository, 'file.txt'), 'after café\n'); git('add', '--all'); git('commit', '-qm', 'head');
  const candidate = { number: 7, title: 'Synthetic host fixture', body: 'No provider execution',
    base: { sha: base, repo: { id: attemptContext.repositoryId, full_name: attemptContext.repository } },
    head: { sha: git('rev-parse', 'HEAD'), repo: { id: attemptContext.repositoryId, full_name: attemptContext.repository } } };
  return { sdkDirectory: '/unused/sdk', claudeBinary: '/unused/claude', model: 'claude-sonnet-4-6',
    repository: attemptContext.repository, pullRequest: 7, expectedHead: candidate.head.sha, expectedBase: candidate.base.sha,
    outputDirectory: join(directory, 'bundle'), attemptContext, readCandidate: async () => structuredClone(candidate),
    capture: options => captureSnapshot({ ...options, localRepository: repository }),
    runDriver: async args => {
      const flags = Object.fromEntries(Array.from({ length: args.length / 2 }, (_, i) => [args[i * 2], args[i * 2 + 1]]));
      const snapshot = JSON.parse(await readFile(flags['--snapshot']));
      const receipt = { schema: 'knitli-reviewer-completion:v1', status: 'completed', provider: 'claude-agent-sdk', sdkVersion: SDK_VERSION,
        requestedModel: flags['--model'], resolvedModel: flags['--model'], usageModels: [flags['--model']], sessionId: randomUUID(), terminalUuid: randomUUID(),
        snapshotSha256: flags['--snapshot-sha256'], manifestSha256: snapshot.manifestSha256,
        coverage: { pages: 4, requiredPages: 4, files: snapshot.files.length },
        report: { schema: 'knitli-review-report:v1', snapshotSha256: flags['--snapshot-sha256'], findings: [], limitations: ['Synthetic fixture only'] } };
      await writeFile(flags['--receipt'], JSON.stringify(receipt));
      return { receiptPath: flags['--receipt'], snapshotSha256: flags['--snapshot-sha256'], status: 'completed' };
    } };
}
