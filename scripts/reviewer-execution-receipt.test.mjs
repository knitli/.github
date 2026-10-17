import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectPages, project, stepName } from './reviewer-execution-receipt.mjs';
const workflowRef = 'knitli/.github/.github/workflows/claude-pr-reviewer.yml@refs/heads/main';
const revision = 'e'.repeat(40);
const expected = { repository: 'knitli/toolshed', runId: '123', runAttempt: '2', checkRunId: '77',
  reviewWorkflowRef: workflowRef, collectorWorkflowRef: workflowRef,
  reviewWorkflowSha: revision, collectorWorkflowSha: revision, producerRevision: revision };
const identityEnv = { REVIEW_CHECK_RUN_ID: expected.checkRunId, REVIEW_WORKFLOW_REF: workflowRef,
  REVIEW_WORKFLOW_SHA: revision, COLLECTOR_WORKFLOW_REF: workflowRef,
  COLLECTOR_WORKFLOW_SHA: revision, RECEIPT_PRODUCER_SHA: revision };
const run = { id: 123, run_attempt: 2, repository: { full_name: expected.repository } };
const job = { id: 7, run_id: 123, check_run_url: 'https://api.github.com/repos/knitli/toolshed/check-runs/77', status: 'completed', conclusion: 'success', head_sha: 'a'.repeat(40), steps: [{ name: stepName, status: 'completed', conclusion: 'failure', number: 4 }] };
const page = jobs => [{ total_count: jobs.length, jobs }];
const inspect = (jobs = [job], r = run) => project(r, page(jobs), {}, null, expected);

test('platform-bound reviewer job success retains reported failed step', () => {
  const result = inspect();
  assert.equal(result.execution, 'failed');
  assert.equal(result.step.conclusion, 'failure');
  assert.equal(result.reason, 'platform-bound-review-step');
  assert.equal(result.job.conclusion, 'success');
  assert.equal(result.reviewCompletion, 'unknown');
});
for (const [conclusion, execution] of Object.entries({ success: 'succeeded', skipped: 'skipped', cancelled: 'cancelled', timed_out: 'timed-out', neutral: 'unknown' })) {
  test(`platform-bound step reports ${conclusion} without proving provider completion`, () => {
    const result = inspect([{ ...job, steps: [{ ...job.steps[0], conclusion }] }]);
    assert.equal(result.execution, execution);
    assert.equal(result.step.conclusion, conclusion);
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


test('caller-controlled matching step cannot impersonate skipped reusable review job', () => {
  const skippedReview = { ...job, id: 8, name: 'review / review', conclusion: 'skipped', steps: [] };
  const impersonator = { ...job, name: 'review / review', check_run_url: 'https://api.github.com/repos/knitli/toolshed/check-runs/99', steps: [{ ...job.steps[0], conclusion: 'success' }] };
  const result = inspect([skippedReview, impersonator]);
  assert.equal(result.execution, 'unknown');
  assert.equal(result.reviewCompletion, 'unknown');
  assert.equal(result.reason, 'missing-review-step');
  assert.equal(result.step, null);
  const missingIdentity = project(run, page([impersonator]), {}, null, { ...expected, checkRunId: '' });
  assert.equal(missingIdentity.reason, 'unverified-review-job-identity');
  assert.equal(missingIdentity.execution, 'unknown');
});

test('only exact platform check run is selected despite successful sibling and changed display names', () => {
  const sibling = { ...job, id: 9, check_run_url: 'https://api.github.com/repos/knitli/toolshed/check-runs/99', steps: [{ ...job.steps[0], conclusion: 'success' }] };
  const result = inspect([sibling, { ...job, name: 'arbitrary display name' }]);
  assert.equal(result.job.id, job.id);
  assert.equal(result.execution, 'failed');
  assert.deepEqual(result.executionIdentity, { checkRunId: '77', workflowRef, workflowSha: revision });
});

test('missing or changed trusted workflow identity cannot promote execution', () => {
  for (const changes of [{ checkRunId: undefined }, { checkRunId: '99' },
    { reviewWorkflowRef: 'attacker/repo/.github/workflows/review.yml@main' },
    { collectorWorkflowRef: workflowRef + '-other' }, { collectorWorkflowSha: 'f'.repeat(40) },
    { reviewWorkflowSha: '' }, { producerRevision: 'f'.repeat(40) }]) {
    const result = project(run, page([job]), {}, null, { ...expected, ...changes });
    assert.equal(result.execution, 'unknown');
    assert.equal(result.executionIdentity, null);
  }
  for (const url of [undefined, 'https://evil.example/repos/knitli/toolshed/check-runs/77',
    'https://api.github.com/repos/other/repo/check-runs/77']) assert.equal(inspect([{ ...job, check_run_url: url }]).execution, 'unknown');
});

test('workflow binds review identity directly to job context and passes only needs outputs', () => {
  const source = readFileSync(new URL('../.github/workflows/claude-pr-reviewer.yml', import.meta.url), 'utf8');
  const review = source.split('\n  review:\n')[1].split('    timeout-minutes:')[0];
  assert.match(review, /check_run_id: \$\{\{ job\.check_run_id \}\}/);
  assert.match(review, /workflow_ref: \$\{\{ job\.workflow_ref \}\}/);
  assert.match(review, /workflow_sha: \$\{\{ job\.workflow_sha \}\}/);
  assert.doesNotMatch(review, /steps\.|inputs\./);
  assert.match(source, /REVIEW_CHECK_RUN_ID: \$\{\{ needs\.review\.outputs\.check_run_id \}\}/);
  assert.match(source, /REVIEW_WORKFLOW_REF: \$\{\{ needs\.review\.outputs\.workflow_ref \}\}/);
  assert.match(source, /REVIEW_WORKFLOW_SHA: \$\{\{ needs\.review\.outputs\.workflow_sha \}\}/);
});

test('optional PR lookup failure preserves acquired attempt evidence', () => {
  const temp = mkdtempSync(join(tmpdir(), 'reviewer-pr-offline-'));
  try {
    writeFileSync(join(temp, 'event.json'), JSON.stringify({ pull_request: { number: 3, head: { sha: 'a'.repeat(40) }, base: { sha: 'b'.repeat(40) } } }));
    writeFileSync(join(temp, 'gh'), `#!${process.execPath}\nconst endpoint = process.argv.at(-1);\nif (endpoint.endsWith('/attempts/2')) console.log(process.env.TEST_RUN);\nelse if (endpoint.endsWith('/jobs?per_page=100&page=1')) console.log(process.env.TEST_JOBS);\nelse { console.error('private PR lookup failure'); process.exit(1); }\n`, { mode: 0o700 });
    const result = spawnSync(process.execPath, [new URL('./reviewer-execution-receipt.mjs', import.meta.url).pathname], { encoding: 'utf8', env: { ...process.env, PATH: temp, GITHUB_REPOSITORY: expected.repository, GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '2', GITHUB_EVENT_PATH: join(temp, 'event.json'), RECEIPT_PATH: join(temp, 'receipt.json'), TEST_RUN: JSON.stringify(run), TEST_JOBS: JSON.stringify(page([job])[0]), ...identityEnv } });
    assert.equal(result.status, 0);
    assert.equal(result.stderr, '');
    const receipt = JSON.parse(readFileSync(join(temp, 'receipt.json'), 'utf8'));
    assert.equal(receipt.job.id, job.id);
    assert.equal(receipt.step.conclusion, 'failure');
    assert.equal(receipt.candidate.eventHead, 'a'.repeat(40));
    assert.equal(receipt.candidate.observedHead, null);
    assert.equal(receipt.reason, 'platform-bound-review-step');
    assert.equal(receipt.execution, 'failed');
  } finally { rmSync(temp, { recursive: true, force: true }); }
});

test('failed action stays nonblocking without masking the receipt step conclusion', () => {
  const source = readFileSync(new URL('../.github/workflows/claude-pr-reviewer.yml', import.meta.url), 'utf8');
  const review = source.split('\n  review:\n')[1].split('\n  execution-receipt:')[0];
  const action = review.split(`      - name: ${stepName}\n`)[1].split('\n      - name:')[0];
  assert.ok(action, 'the receipt-producing action must exist');
  assert.match(review.split('    steps:')[0], /^    continue-on-error: true$/m);
  assert.match(source.split('\n  execution-receipt:')[1], /^    if: \$\{\{ always\(\) && !inputs\.host_qualification \}\}$/m);
  const failedAction = spawnSync(process.execPath, ['-e', 'process.exit(23)']);
  assert.equal(failedAction.status, 23);
  const outcome = failedAction.status === 0 ? 'success' : 'failure';
  // GitHub applies step continue-on-error before publishing step conclusion.
  // Exercise that documented transformation using the actual workflow setting.
  const conclusion = /^        continue-on-error: true$/m.test(action) ? 'success' : outcome;
  const result = inspect([{ ...job, name: 'unrelated display label',
    steps: [{ ...job.steps[0], conclusion }] }]);
  assert.equal(result.execution, 'failed');
  assert.equal(result.step.conclusion, 'failure');
  assert.equal(result.reviewCompletion, 'unknown');
  assert.doesNotMatch(action, /^        continue-on-error:/m);
});

// Bounded extractor for these checked-in block-style examples, not a general YAML
// parser. Reject unsupported permission syntax instead of assuming inherited access.
function block(source, name, indent) {
  const lines = source.split('\n');
  const matches = lines.flatMap((line, index) => line === `${' '.repeat(indent)}${name}:` ? [index] : []);
  assert.ok(matches.length <= 1, `duplicate ${name} block`);
  if (!matches.length) return null;
  const start = matches[0] + 1;
  let end = start;
  while (end < lines.length) {
    const line = lines[end];
    if (line.trim() && !line.trimStart().startsWith('#') && line.search(/\S/) <= indent) break;
    end++;
  }
  return lines.slice(start, end).join('\n');
}
function permissionMap(source, indent) {
  const declarations = source.split('\n').filter(line => line.startsWith(`${' '.repeat(indent)}permissions:`));
  assert.ok(declarations.length <= 1, 'duplicate permissions declaration');
  if (!declarations.length) return null;
  assert.equal(declarations[0], `${' '.repeat(indent)}permissions:`, 'expected block permissions mapping');
  const permissions = {};
  for (const line of block(source, 'permissions', indent).split('\n')) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const match = line.match(new RegExp(`^ {${indent + 2}}([a-z-]+): (read|write|none)(?: +#.*)?$`));
    assert.ok(match, 'unsupported permission entry');
    assert.ok(!Object.hasOwn(permissions, match[1]), 'duplicate permission key');
    permissions[match[1]] = match[2];
  }
  return permissions;
}
function requireActionsRead(source, jobName) {
  const jobs = block(source, 'jobs', 0);
  assert.notEqual(jobs, null, 'missing jobs');
  const selected = block(jobs, jobName, 2);
  assert.notEqual(selected, null, `missing job ${jobName}`);
  // GitHub job mappings replace workflow permissions; omitted scopes become none.
  const effective = permissionMap(selected, 4) ?? permissionMap(source, 0) ?? {};
  assert.equal(effective.actions, 'read', `${jobName} must explicitly retain actions: read`);
}
const receiptWorkflow = readFileSync(new URL('../.github/workflows/claude-pr-reviewer.yml', import.meta.url), 'utf8');
const workflowReadme = readFileSync(new URL('../.github/workflows/README.md', import.meta.url), 'utf8');
const callerReadme = workflowReadme.match(/```yaml\n(# \.github\/workflows\/claude-pr-reviewer\.yml\n[\s\S]*?)\n```/);
assert.ok(callerReadme, 'missing documented Claude caller');
const usageHeader = receiptWorkflow.match(/# Usage in your repository[^\n]*\n((?:#(?:[^\n]*)\n)+)/);
assert.ok(usageHeader, 'missing reusable usage header');
const commentedCaller = usageHeader[1].split('\n').filter(line => line.startsWith('#   '))
  .map(line => line.slice(4)).join('\n');
for (const [name, source] of [
  ['example caller', readFileSync(new URL('../examples/claude-pr-reviewer.yml', import.meta.url), 'utf8')],
  ['README caller', callerReadme[1]], ['commented usage caller', commentedCaller],
]) {
  test(`${name} grants the Actions API caller permission ceiling`, () => {
    assert.match(source, /uses: knitli\/\.github\/\.github\/workflows\/claude-pr-reviewer\.yml@/);
    requireActionsRead(source, 'review');
  });
}
for (const jobName of ['review', 'execution-receipt']) {
  test(`reusable ${jobName} retains Actions API read permission`, () => requireActionsRead(receiptWorkflow, jobName));
}
test('caller permission mutations cannot hide omitted or downgraded job scopes behind workflow inheritance', () => {
  const inherited = 'permissions:\n  actions: read\njobs:\n  review:\n    uses: reusable\n';
  requireActionsRead(inherited, 'review');
  assert.throws(() => requireActionsRead(inherited.replace('  actions: read\n', ''), 'review'));
  for (const override of ['      contents: read', '      actions: none', '      actions: write']) {
    const mutated = inherited.replace('    uses:', `    permissions:\n${override}\n    uses:`);
    assert.throws(() => requireActionsRead(mutated, 'review'));
  }
  requireActionsRead(inherited.replace('    uses:', '    permissions:\n      actions: read\n    uses:'), 'review');
});
