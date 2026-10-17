import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const stepName = 'Claude PR review (execution receipt v1)';
const sha = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value) ? value : null;

export function project(run, pages, event, current, expected) {
  const receipt = {
    schema: 'knitli-reviewer-execution:v1',
    repository: expected.repository, runId: expected.runId, runAttempt: expected.runAttempt,
    repositoryId: run.repository?.id ?? null,
    pullRequest: event.pull_request?.number ?? (event.issue?.pull_request ? event.issue.number : null),
    reviewCompletion: 'unknown', execution: 'unknown', reason: 'incomplete-acquisition',
    // These are observations, never the actual inputs examined by the model.
    candidate: { eventHead: sha(event.pull_request?.head?.sha), eventBase: sha(event.pull_request?.base?.sha),
      observedHead: sha(current?.head?.sha), observedBase: sha(current?.base?.sha) },
    job: null, step: null,
  };
  if (String(run.id) !== expected.runId || String(run.run_attempt) !== expected.runAttempt ||
      run.repository?.full_name !== expected.repository || !Array.isArray(pages) || !pages.length) return receipt;
  const total = pages[0].total_count;
  if (!Number.isSafeInteger(total) || total < 0 || pages.some(p => p.total_count !== total || !Array.isArray(p.jobs))) return receipt;
  const jobs = pages.flatMap(p => p.jobs);
  if (jobs.length !== total || new Set(jobs.map(j => j.id)).size !== total ||
      jobs.some(j => !Number.isSafeInteger(j.id) || String(j.run_id) !== expected.runId)) return receipt;
  const matches = jobs.filter(j => Array.isArray(j.steps) && j.steps.some(s => s?.name === stepName));
  receipt.reason = matches.length > 1 ? 'ambiguous-review-job' : 'missing-review-step';
  if (matches.length !== 1) return receipt;
  const job = matches[0];
  const steps = job.steps.filter(s => s?.name === stepName);
  if (steps.length !== 1) { receipt.reason = 'ambiguous-review-step'; return receipt; }
  const step = steps[0];
  receipt.job = { id: job.id, status: job.status, conclusion: job.conclusion, headSha: sha(job.head_sha) };
  receipt.step = { number: step.number, status: step.status, conclusion: step.conclusion };
  if (job.status !== 'completed' || step.status !== 'completed') { receipt.reason = 'execution-not-terminal'; return receipt; }
  const outcomes = { success: 'succeeded', failure: 'failed', cancelled: 'cancelled', skipped: 'skipped', timed_out: 'timed-out' };
  receipt.execution = outcomes[step.conclusion] ?? 'unknown';
  receipt.reason = receipt.execution === 'unknown' ? 'unrecognized-step-conclusion' : 'actual-review-step';
  return receipt;
}

export function collectPages(get, endpoint) {
  const pages = [];
  for (let page = 1; page <= 100; page++) {
    const result = get(`${endpoint}?per_page=100&page=${page}`);
    if (!Number.isSafeInteger(result.total_count) || !Array.isArray(result.jobs)) throw new Error('invalid jobs response');
    pages.push(result);
    if (pages.flatMap(p => p.jobs).length >= result.total_count || result.jobs.length < 100) return pages;
  }
  throw new Error('jobs pagination limit');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const expected = { repository: process.env.GITHUB_REPOSITORY, runId: process.env.GITHUB_RUN_ID, runAttempt: process.env.GITHUB_RUN_ATTEMPT };
  if (!/^[\w.-]+\/[\w.-]+$/.test(expected.repository) || !/^\d+$/.test(expected.runId) || !/^[1-9]\d*$/.test(expected.runAttempt)) throw new Error('invalid execution identity');
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
  const get = endpoint => JSON.parse(execFileSync('gh', ['api', '-H', 'X-GitHub-Api-Version: 2026-03-10', endpoint], { encoding: 'utf8', timeout: 30000, maxBuffer: 8 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }));
  let receipt = project({}, [], event, null, expected);
  try {
    const endpoint = `repos/${expected.repository}/actions/runs/${expected.runId}/attempts/${expected.runAttempt}`;
    const run = get(endpoint);
    const pages = collectPages(get, `${endpoint}/jobs`);
    const pr = event.pull_request?.number ?? (event.issue?.pull_request ? event.issue.number : null);
    let current = null;
    if (Number.isSafeInteger(pr) && pr > 0) current = get(`repos/${expected.repository}/pulls/${pr}`);
    receipt = project(run, pages, event, current, expected);
    receipt.producerRevision = process.env.RECEIPT_PRODUCER_SHA;
    receipt.observedAt = new Date().toISOString();
  } catch {
    // Keep unavailable/partial acquisition unknown; never retain API error bodies.
  }
  writeFileSync(process.env.RECEIPT_PATH, `${JSON.stringify(receipt, null, 2)}\n`);
}
