import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectPages, project, stepName } from './reviewer-execution-receipt.mjs';
const expected = { repository: 'knitli/toolshed', runId: '123', runAttempt: '2' };
const run = { id: 123, run_attempt: 2, repository: { full_name: expected.repository } };
const job = { id: 7, run_id: 123, status: 'completed', conclusion: 'success', head_sha: 'a'.repeat(40), steps: [{ name: stepName, status: 'completed', conclusion: 'failure', number: 4 }] };
const page = jobs => [{ total_count: jobs.length, jobs }];
const inspect = (jobs = [job], r = run) => project(r, page(jobs), {}, null, expected);

test('masked job success retains actual failed step and never proves review completion', () => {
  const result = inspect();
  assert.equal(result.execution, 'failed');
  assert.equal(result.job.conclusion, 'success');
  assert.equal(result.reviewCompletion, 'unknown');
});
for (const [conclusion, execution] of Object.entries({ success: 'succeeded', skipped: 'skipped', cancelled: 'cancelled', timed_out: 'timed-out', neutral: 'unknown' })) {
  test(`actual step ${conclusion}`, () => {
    const result = inspect([{ ...job, steps: [{ ...job.steps[0], conclusion }] }]);
    assert.equal(result.execution, execution);
    assert.equal(result.reviewCompletion, 'unknown');
  });
}
test('missing, duplicate, incomplete and nonterminal observations stay unknown', () => {
  for (const jobs of [[], [{ ...job, steps: [] }], [job, { ...job, id: 8 }], [{ ...job, steps: [...job.steps, ...job.steps] }], [{ ...job, status: 'in_progress' }]]) assert.equal(inspect(jobs).execution, 'unknown');
  assert.equal(project(run, [{ total_count: 2, jobs: [job] }], {}, null, expected).execution, 'unknown');
  assert.equal(inspect([job, job]).execution, 'unknown');
});
test('same-head retries must match requested attempt and run', () => {
  assert.equal(inspect([job], { ...run, run_attempt: 1 }).execution, 'unknown');
  assert.equal(inspect([{ ...job, run_id: 456 }]).execution, 'unknown');
  assert.equal(inspect([job], { ...run, repository: { full_name: 'other/repo' } }).execution, 'unknown');
});
test('head/base movement remains observation, never reviewed-input certification', () => {
  const result = project(run, page([job]), { pull_request: { head: { sha: 'a'.repeat(40) }, base: { sha: 'b'.repeat(40) } } }, { head: { sha: 'c'.repeat(40) }, base: { sha: 'd'.repeat(40) } }, expected);
  assert.equal(result.candidate.eventHead, 'a'.repeat(40));
  assert.equal(result.candidate.observedBase, 'd'.repeat(40));
  assert.equal(result.reviewCompletion, 'unknown');
});
test('pagination reads every page and rejects failed acquisition', () => {
  const calls = [];
  const pages = collectPages(path => { calls.push(path); return { total_count: 101, jobs: calls.length === 1 ? Array.from({ length: 100 }, (_, id) => ({ ...job, id })) : [{ ...job, id: 100 }] }; }, 'attempts/2/jobs');
  assert.equal(pages.length, 2);
  assert.equal(calls[1], 'attempts/2/jobs?per_page=100&page=2');
  assert.throws(() => collectPages(() => { throw new Error('offline'); }, 'jobs'));
  assert.equal(project(run, [pages[0]], {}, null, expected).execution, 'unknown');
});

import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
test('workflow bootstrap loads only the exact API-reported owned revision', () => {
  const workflow = readFileSync(new URL('../.github/workflows/claude-pr-reviewer.yml', import.meta.url), 'utf8');
  const source = workflow.split("node --input-type=module <<'JS'\n")[1].split('\n          JS')[0].split('\n').map(line => line.slice(10)).join('\n');
  const temp = mkdtempSync(join(tmpdir(), 'reviewer-bootstrap-'));
  try {
    const revision = 'e'.repeat(40);
    const validRun = { ...run, referenced_workflows: [{ path: 'knitli/.github/.github/workflows/claude-pr-reviewer.yml@main', sha: revision }] };
    writeFileSync(join(temp, 'gh'), `#!${process.execPath}\nconst path = process.argv[3];\nif (path === 'repos/knitli/toolshed/actions/runs/123/attempts/2') console.log(process.env.TEST_RUN);\nelse if (path === 'repos/knitli/.github/contents/scripts/reviewer-execution-receipt.mjs?ref=${revision}') console.log(JSON.stringify({ type: 'file', encoding: 'base64', content: Buffer.from('trusted helper').toString('base64') }));\nelse process.exit(4);\n`, { mode: 0o700 });
    const invoke = value => spawnSync(process.execPath, ['--input-type=module', '-e', source], { encoding: 'utf8', env: { ...process.env, PATH: temp, RUNNER_TEMP: temp, GITHUB_ENV: join(temp, 'env'), GITHUB_REPOSITORY: expected.repository, GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '2', TEST_RUN: JSON.stringify(value) } });
    assert.equal(invoke(validRun).status, 0);
    assert.equal(readFileSync(join(temp, 'reviewer-execution-receipt.mjs'), 'utf8'), 'trusted helper');
    assert.match(readFileSync(join(temp, 'env'), 'utf8'), new RegExp(`RECEIPT_PRODUCER_SHA=${revision}`));
    for (const invalid of [{ ...validRun, run_attempt: 1 }, { ...validRun, referenced_workflows: [] }, { ...validRun, referenced_workflows: [...validRun.referenced_workflows, ...validRun.referenced_workflows] }, { ...validRun, referenced_workflows: [{ path: 'attacker/repo/.github/workflows/claude-pr-reviewer.yml@main', sha: revision }] }]) assert.notEqual(invoke(invalid).status, 0);
  } finally { rmSync(temp, { recursive: true, force: true }); }
});

test('collector retains unknown without leaking API errors when acquisition fails', () => {
  const temp = mkdtempSync(join(tmpdir(), 'reviewer-offline-'));
  try {
    writeFileSync(join(temp, 'event.json'), '{}');
    writeFileSync(join(temp, 'gh'), `#!${process.execPath}\nconsole.error('private provider error'); process.exit(1);\n`, { mode: 0o700 });
    const result = spawnSync(process.execPath, [new URL('./reviewer-execution-receipt.mjs', import.meta.url).pathname], { encoding: 'utf8', env: { ...process.env, PATH: temp, GITHUB_REPOSITORY: expected.repository, GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '2', GITHUB_EVENT_PATH: join(temp, 'event.json'), RECEIPT_PATH: join(temp, 'receipt.json') } });
    assert.equal(result.status, 0);
    assert.equal(result.stderr, '');
    const receipt = JSON.parse(readFileSync(join(temp, 'receipt.json'), 'utf8'));
    assert.equal(receipt.execution, 'unknown');
    assert.equal(receipt.reviewCompletion, 'unknown');
    assert.equal(receipt.reason, 'incomplete-acquisition');
  } finally { rmSync(temp, { recursive: true, force: true }); }
});
