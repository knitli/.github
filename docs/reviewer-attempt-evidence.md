# Dormant reviewer attempt composition

The library in `scripts/reviewer-attempt-evidence.mjs` joins a validated frozen-input
producer bundle with independently acquired, attempt-specific GitHub execution
evidence. It does not enable a workflow, run a provider, post a review, authenticate
a local file by itself, or complete an attention round. All outputs retain
`provenance: unverified` and `roundCompletion: unknown`.

## Host contract

A trusted host may pass `attemptContext` to `runProducer`. It contains exactly
`repository`, `repositoryId`, `runId`, `runAttempt`, `checkRunId`, `workflowRef`,
`workflowSha`, and `producerRevision`. Run/attempt/check IDs are decimal strings;
repository ID is a positive safe integer. Workflow identity names the existing
owned reusable reviewer workflow; workflow and producer revision must match.
The producer freezes these primitives before acquisition and binds them into its
no-clobber envelope. Snapshot repository ID/name must match. Existing unbound
local producer calls remain available, but cannot be composed.

After the producer job has terminated, the host calls:

```js
await composeAttemptEvidence({
  directory: '/private/attempt-bundle',
  outputPath: '/private/attempt-evidence.json',
  readTrustedHandoff, // -> { attempt, envelopeSha256 }
  get,               // synchronous authenticated GitHub API acquisition
});
```

These functions are trusted host capabilities, not bundle-defined callbacks or
untrusted extension points. `readTrustedHandoff` must acquire the exact attempt
identity and envelope digest from an independently protected host channel. The
host must capture that digest from its own completed producer invocation and
bind it to platform job context. Reading the same bundle to manufacture this
handoff violates the contract. There is deliberately no CLI accepting arbitrary
receipt JSON, no `trusted: true` field, and no fallback to self-reported hashes.

`get` must perform authenticated GitHub API reads through host-owned credentials.
`collectSdkExecution` calls the exact run-attempt endpoint and all required job
pages. The actual run repository ID, run/attempt, owned workflow path and immutable
revision must match. GitHub's `@main` versus `@refs/heads/main` path spelling is
allowed only with the same immutable SHA. Job selection uses the exact platform
check-run URL, never job display names or head SHA. Incomplete/duplicate pages,
missing identities, or acquisition errors remain unknown. Error bodies are not
retained.

The SDK producer has a distinct fixed step name:
`Frozen SDK PR review (execution receipt v1)`. The existing
`Claude PR review (execution receipt v1)` action is never reinterpreted as an SDK
execution. No existing workflow uses the new step in this change.

## Result semantics

The composer first verifies the independently supplied envelope digest, complete
attempt identity, snapshot/manifest/blob hashes, completion digest/session/report
and fixed filenames/bounds. It repeats retained-byte validation after platform
acquisition, then atomically publishes a separate mode-0444 artifact without
replacement. Original bundle artifacts are not modified.

`status: matched` requires the run attempt and selected job to be completed and
successful, the exact SDK execution step to have succeeded, and the separately
handed-off bundle passed validation. Failed, cancelled, skipped, nonterminal or
unavailable execution produces `status: unavailable`. `applicability` is retained
from the producer: a stale historical review stays stale even if execution
matches. Neither status grants review approval, provider admission, installation
identity, trusted policy, admission ordering, or round completion. Filesystem
owners can still alter files after this point; downstream use needs independent
acquisition and validation.

## Offline validation and remaining adoption work

`node --test scripts/reviewer-producer-run.test.mjs scripts/reviewer-execution-receipt.test.mjs`
exercises real local Git snapshot capture, deterministic completion fixtures,
exact attempt binding, immutable inputs, retry/sibling/legacy-step substitution,
workflow drift, partial pagination, terminal states, altered bundle bytes,
no-clobber output, and historical candidate movement.

When the existing exact cached SDK 0.3.209 and Darwin ARM64 binary are available,
a separate test invokes the actual default producer driver in a child with a
closed environment and no model credential. It also invokes the actual pinned
driver and requires its precise missing-options rejection after SDK import.
This proves pin/import/failure cleanup, not successful model completion; it
cannot reach query construction or native spawn. Missing caches or another
platform skip this test honestly. No downloads or installation are performed.

Still required for hosted adoption: a reviewed pinned workflow invoking the SDK
producer, protected platform attempt-context and envelope-digest handoff,
authenticated artifact/API acquisition, and qualification of that complete path.
This slice intentionally does not install those capabilities. No successful
provider execution or externally authenticated hosted provenance is claimed.

Verified locally on 2026-10-17: all four reviewer suites passed (108 tests, zero
skips) with the cached SDK qualifier enabled. Eleven causal mutants independently
failed assertions: attempt identity, run-attempt identity, sibling-job selection,
legacy-action substitution, complete pagination, step/job/run terminal fences,
independent envelope digest, final-byte revalidation, and stale applicability.
Source was restored before the final green run. Node syntax checks, scoped
Oxlint default correctness checks, and `git diff --check` passed. These are local
offline results, not hosted provenance or successful provider qualification.
