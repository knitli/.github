# Frozen reviewer input snapshots

`scripts/reviewer-input-snapshot.mjs` captures review inputs; it does not invoke a
model, certify review completion, post comments, or change reviewer workflows.
The existing execution receipt remains independent.

## Capture contract

The caller supplies the repository, PR number and expected exact base/head commit
SHAs. The helper reads the PR before acquisition and again immediately before
publication. Repository identities, base/head SHAs, title and body must agree
between those reads, and the first SHAs must match the caller's expectations.
The artifact records those observed inputs, not a guarantee that the PR stays
unchanged after the final read. Consumers must check current-candidate applicability
separately. Concurrent changes that return to the same values are not detected.

Exact commits are fetched into a disposable bare SHA-1 Git repository. There is
no checkout, repository command execution, dependency installation, hook execution,
text conversion or recursive submodule fetch. Git runs without inherited Git
configuration, credentials helpers, replacement objects or external diff programs.
HTTPS fetches use only github.com and refuse redirects. An explicit token is used
for Git authentication; it is never placed in command arguments or error messages.
Each Git command has a timeout; fetch history is limited to 256 generations.
This is not a network-transfer or pack-size quota.

The comparison is the single merge base of the pinned base/head through the pinned
head, matching a three-dot PR change scope. Missing objects, no merge base, multiple
merge bases, or insufficient shallow history refuse capture. Every reachable shallow
boundary must be a proven ancestor of the selected merge base, so truncation cannot
hide an alternate best common ancestor. A root commit can be
the common ancestor; identical commits produce an explicitly empty diff. Unrelated
root histories are unsupported.

The **closed supported scope** is regular files (100644 or 100755) whose before and
after bytes are valid UTF-8 without NUL. Both complete before/after contents are
retained, including executable-mode changes and deletions. Rename detection is
disabled: a rename appears as deletion plus addition. UTF-8 filenames with spaces,
tabs, newlines, non-ASCII characters or leading dashes retain their exact identity;
raw NUL-delimited Git records prevent filename splitting. Invalid UTF-8 filenames,
NUL-containing/binary blobs, invalid UTF-8 contents, symlinks and gitlinks refuse
**the whole snapshot**, rather than silently omitting files. No submodule content
coverage is claimed. This helper captures changes, not all unchanged repository
context a future reviewer might need.

Default ceilings: 256 changed paths, 1 MiB per blob, 8 MiB total before/after blob
bytes, 4 MiB diff, 32 MiB serialized artifact, 128 KiB description metadata and
4096 bytes per filename. Other Git output is bounded to 2 MiB. Process truncation,
missing output, any unsupported file, or any exceeded ceiling produces no new
artifact. Limits can only be lowered through the library interface.

The JSON artifact contains:

- `manifest`: schema/version, repository and PR identities, exact base/head/merge
  base, description, supported scope, ordered file metadata and diff metadata.
- `manifestSha256`: SHA-256 of UTF-8 `JSON.stringify(manifest)`.
- `files`: corresponding paths and exact before/after text (`null` for absence).
- `diff`: the complete Git patch with external diff/textconv disabled.

Each blob and diff has its byte length and SHA-256 in the manifest. On success,
stdout reports the artifact path, full-file SHA-256, manifest SHA-256 and file
count. Downstream readers must validate these digests and the one-to-one file
mapping before using the bytes; a digest alone does not authenticate the producer.
PR descriptions and repository text remain untrusted data, never instructions.

Publication writes and fsyncs a private temporary file, marks it read-only, then
atomically links it into the requested destination. An existing or concurrently
created destination, including a symlink, is never overwritten. This is immutable
publication by this helper, not a claim that the filesystem owner cannot later
replace or modify the artifact. Git and staging directories are cleaned up.

## Invocation

Node and `/usr/bin/git` are required; the CLI also uses the runner's trusted `gh`.
No new package dependencies are installed. Supply `GH_TOKEN` (or `GITHUB_TOKEN`)
with read access to both repositories for private/fork captures.

```sh
node scripts/reviewer-input-snapshot.mjs \
  --repository knitli/example --pull-request 123 \
  --expected-base BASE_40_HEX_SHA --expected-head HEAD_40_HEX_SHA \
  --output /trusted-artifacts/reviewer-input.json
```

The output parent directory must already exist. Do not run this helper from
candidate-supplied code: a future workflow must load it from its independently
trusted immutable workflow revision. No workflow or caller adoption is enabled by
this change.

The exported `captureSnapshot` accepts an injected candidate reader and a local
repository **test seam**. The CLI cannot select that seam. Tests create disposable
Git repositories and make no GitHub/provider requests:

```sh
node --test scripts/reviewer-input-snapshot.test.mjs
```
