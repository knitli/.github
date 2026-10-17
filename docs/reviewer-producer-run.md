# Opt-in local reviewer producer

`scripts/reviewer-producer-run.mjs` joins the existing frozen-input capture and
pinned SDK completion driver into one runnable host operation. It creates one
private artifact bundle, passes the capture's verified full SHA256 directly to
the driver, and retains its validated output. It does not activate a workflow,
post findings, claim authenticated admission, or change cloud attention state.

Every envelope says `provenance: unverified` and `roundCompletion: unknown`,
including when `status: completed`. Here completed means the local host accepted
the existing driver's completion artifact. The producer requires the explicit
versioned requested model to match both the resolved model and the sole usage
model in that receipt, and retains all three fields in its completion summary.
Missing, mismatched, or additional model identities fail closed.
Configured repository/candidate/model
values, a local execution UUID, and self-consistent hashes do not establish
GitHub workflow identity, installation identity, trusted policy, admission order,
provider acceptance, or externally authenticated provenance. No query-init event
is labeled provider acceptance. A completed empty report does not approve a PR
or resolve prior findings.

## Run explicitly on a trusted host

Use trusted code from the reviewed producer revision, the pinned runtime described
in [reviewer-completion-driver.md](reviewer-completion-driver.md), a trusted Node
24 executable and a trusted absolute GitHub CLI path. The caller must approve
sending the captured source to the selected model. Supply credentials only at
runtime, with no Node preloads or other inherited startup customizations:

```sh
env -i PATH=/usr/bin:/bin \
  GH_TOKEN="$GH_TOKEN" ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" \
  /trusted/node scripts/reviewer-producer-run.mjs \
  --repository knitli/example --pull-request 7 \
  --expected-head "$HEAD_SHA" --expected-base "$BASE_SHA" \
  --output-directory /private/review-attempt-unique \
  --sdk-directory /trusted/runtime/sdk/package \
  --claude-binary /trusted/runtime/native/package/claude \
  --gh-binary /trusted/bin/gh --model claude-sonnet-4-6
```

The output directory must not exist. The host reserves it exclusively with mode
0700; an existing attempt is never reused or overwritten. The command requires
both `GH_TOKEN` (or `GITHUB_TOKEN`) and `ANTHROPIC_API_KEY`. Its CLI clears the host
environment before invoking the helpers. GitHub metadata acquisition uses an
explicit github.com hostname, private empty GitHub configuration, a closed
environment containing only the GitHub token and basic path/config values, a
30-second timeout with SIGKILL, and bounded output. Git fetch retains the snapshot
helper's own closed environment. The Anthropic key is not forwarded to either.
The pinned completion driver receives its existing closed native-child environment
with only its model credential, and owns child exit before runtime deletion.
The GitHub token is retained only in the trusted acquisition closure and never
forwarded to that native child. Library callers own their host environment and
must provide equivalent isolation; injectable functions are test seams, not
untrusted extension points.

## Sequence and retained evidence

1. Capture exact expected head/base, with the existing pre/post candidate reads.
2. Verify the snapshot artifact hash, closed manifest, full blobs and diff.
3. Re-read candidate identity and description immediately before handoff; movement
   blocks driver invocation. Verify the local snapshot bytes again after this
   asynchronous read.
4. Run the existing pinned driver using that host-selected full snapshot digest.
   The driver retains its SDK/session/coverage/child-exit checks.
5. Validate the bounded completion artifact, including exact snapshot and manifest
   digests, session/terminal UUIDs, required page count and closed report shape.
6. Re-read the candidate after completion, then recheck retained artifact bytes.
   Movement gives `applicability: stale`; acquisition failure gives `unknown`.
   `unchanged-observed` means equality at those observations, not continuous
   stability, policy verification or permission to complete the round.
7. Publish `envelope.json` atomically without replacement as the bundle commit
   marker. Retained snapshot and completion files are mode0444. Readers must
   verify the envelope's file digests and bounds; raw files without the marker
   are an incomplete attempt. Filesystem owners can still alter these files.

The bundle contains at most `snapshot.json` (32 MiB), `completion.json` (256 KiB),
and `envelope.json` (64 KiB). It retains original source and review output, so its
parent directory, access policy and deletion schedule belong to the trusted
operator. There is no automatic archival service or cross-attempt retention
manager. Delete a bundle when the operator's retention policy requires it; this
command never silently deletes other attempts.

Ordinary capture, stale-handoff, driver and output-validation failures retain a
bounded failed envelope and any valid captured snapshot, but remove partial or
invalid completion output. Error bodies and credentials are not retained. Final-byte conflicts are retained as failed envelopes after invalid artifacts
are discarded. A crash or disk failure can leave no commit marker; that is
unknown/incomplete, never a successful attempt. The command exits nonzero for a
failed attempt. A completed historical attempt can exit zero while applicability
is stale or unknown; all envelopes still withhold round completion.

No acceptance receipt, durable cloud admission sequence, GitHub attestation,
automatic review trigger or completion reducer is introduced. Those require
separate contract adoption and authenticated acquisition. Live provider and
hosted execution qualification remain outstanding.

## Offline validation

```sh
node --test scripts/reviewer-producer-run.test.mjs
```

Tests use actual Git snapshot capture with a local repository and a fake driver
that writes the real completion DTO. They check invocation ordering, pre/post
candidate movement, partial failures, digest/session validation, private
no-clobber retention, bounds and final-byte conflicts. An actual CLI subprocess test uses a local fake GitHub executable and a stale
response to prove the acquisition environment excludes the model key and unrelated
secrets, without reaching Git fetch or the model. Tests invoke neither a model
nor GitHub and make no network calls.
