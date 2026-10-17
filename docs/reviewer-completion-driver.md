# Opt-in frozen-input reviewer completion

`scripts/reviewer-completion-driver.mjs` consumes a snapshot from
`reviewer-input-snapshot.mjs` and runs an advisory Claude review. It does not post
reviews, approve a PR, or change any workflow. A completed receipt means the
bounded SDK execution finished and the host served every required input page;
it does not prove the model understood every page or found every defect.

The caller supplies the snapshot SHA256 through a trusted channel, independently
of the snapshot file. The driver checks the full artifact bytes, the closed
manifest schema and digest, every complete file side (including Git blob OID),
and the complete diff. Unsupported shapes fail before a provider call.

## Pinned runtime

This implementation targets `@anthropic-ai/claude-agent-sdk@0.3.209`, with the
native Claude `2.1.209` binary. The pin comes from the upstream action's
[immutable lockfile](https://github.com/anthropics/claude-code-action/blob/f1bd27ca5b54584506e40e17884d90bdaaa1a9b3/bun.lock).
The exact SDK tarball has SHA512 base64:

```
HdxLmpnIOd4CSYxdlD/4ShKFvHAuWefP1MTf/B+Mj0Oq8Tb9qzmhLuHCZMd5Pf21Knrt7jke/t4coYAtokFcuw==
```

Its self-contained `sdk.mjs` has SHA256:

```
7b3577a1078660a3ec43471e6738c730ca1b172070ddcf3f9a9384bcb68bd3ca
```

The driver verifies that file and the native binary against SHA256 pins from
that authenticated package's `manifest.json`. It copies verified bytes to a
private temporary runtime and imports that copy. Only Node builtins are imported
by this SDK module; no project dependencies or installed plugin modules are
loaded. Supported native builds are macOS arm64/x64 and glibc Linux arm64/x64;
musl and Windows are not supported by this driver.

Provision the exact SDK and matching native package outside the candidate
checkout. The SDK tarball URL is
`https://registry.npmjs.org/@anthropic-ai/claude-agent-sdk/-/claude-agent-sdk-0.3.209.tgz`.
Matching native packages are named
`@anthropic-ai/claude-agent-sdk-<platform>-<arch>@0.3.209`.
Download and extract these archives in a trusted runtime directory; an npm install
is not needed. The driver validates the extracted bytes before importing or
executing them. Do not substitute another binary/version. It never downloads or
installs runtime dependencies itself.

## Invocation

Run trusted driver code, with Node 24 and an Anthropic API key supplied by the host:

```sh
node scripts/reviewer-completion-driver.mjs \
  --snapshot /trusted/input/snapshot.json \
  --snapshot-sha256 "$TRUSTED_SNAPSHOT_SHA256" \
  --sdk-directory /trusted/runtime/sdk/package \
  --claude-binary /trusted/runtime/native/package/claude \
  --model claude-sonnet-4-6 \
  --receipt /trusted/output/completion.json
```

The only forwarded credential is `ANTHROPIC_API_KEY`. SDK `options.env` replaces
the child environment in this pinned implementation; it does not merge inherited
variables. GitHub tokens, proxy settings, `NODE_OPTIONS`, and workspace variables
are excluded. The verified native CLI supports `--bare`, `--disable-slash-commands`, and
`--no-chrome`; the driver passes all three. Bare mode also suppresses keychain
auth, auto-memory, and background startup integrations. The child runs in an empty private directory with private HOME,
TMPDIR, CLAUDE_CODE_TMPDIR, and Claude config directory. Filesystem settings, project instructions,
skills, plugins, hooks, and session persistence are disabled. Builtin tools are
empty and strict MCP configuration exposes only the host's `read_next` tool.
The model cannot open files, run commands, make GitHub calls, or write a receipt.
Managed host policy remains part of the trusted execution environment.

The empty-schema `read_next` SDK tool returns sequential frozen pages of the
manifest (including PR description), full diff, and every non-null full file
side. Each page is at most 6,000 Unicode code points. The tool has no semantic inputs. The actual SDK strips extra object keys
before the callback; those keys cannot select paths or alter which page is read.
SDK argument-validation failures are not claimed as host poison evidence. The host counts successful returns; early completion, attempted permission requests, or reads beyond the input poison
the completion attempt. Source text is always untrusted data.

Limits are five minutes, 128 turns, USD 5 SDK budget, 4,096 stream messages, 8 MiB
stream data, and a 128 KiB report with at most 100 findings and 100 limitations.
Large snapshots may exceed these review limits even though capture succeeded;
that produces unknown/incomplete, never a completed receipt.

## Receipt and failure semantics

The host binds SDK initialization and every stream message to a fresh session
UUID. It accepts exactly one terminal success with `is_error: false`,
`terminal_reason: completed`, no permission denials/deferred tool use, all pages
served, a closed JSON report, and clean stream termination. Findings must name a
captured file side and an existing line. Free text, extra report fields, provider
errors, missing/mismatched sessions, missing coverage, duplicate terminal events,
timeout, or transport failures refuse completion. No prior receipt is reused.

The host owns the child through the SDK spawnClaudeCodeProcess API and waits
for observed exit before deleting its private runtime. It bounds graceful wait,
SIGTERM, and SIGKILL waits; if exit cannot be proved it preserves the runtime and
refuses completion. A receipt additionally requires a clean zero-status child
exit. The host atomically publishes a read-only receipt using a no-clobber hard link
from a private staging directory. An existing output is never overwritten. The
receipt binds the full snapshot digest, manifest digest, session, terminal UUID,
coverage counts, SDK version, and advisory report. Callers must treat any nonzero
exit as unknown, even if an older file exists at their chosen output path. Use a
fresh output path per attempt. Read-only mode is not tamper-proof against the
filesystem owner.

No live provider review has been qualified. Local evidence covers real Git
snapshot capture/verification, fake streams shaped by the actual pinned SDK
API, exact SDK tarball integrity, and importing/constructing the actual SDK tool
and MCP server without invoking `query()`, plus verified native binary SHA256
and offline `--help` flag qualification. Production use needs an authorized
live provider qualification before any automated review gate adopts this receipt.

```sh
node --test scripts/reviewer-input-snapshot.test.mjs scripts/reviewer-completion-driver.test.mjs
```

For the offline SDK argument-boundary qualification, set
`REVIEWER_SDK_QUALIFICATION_DIR` to the extracted pinned SDK `package` directory
when running the tests. This optional test verifies the SDK module hash before
importing it and checks the real MCP validator; it never calls `query()`.
Without that directory the qualification test is explicitly skipped. The regular
suite still checks child lifetime with a harmless local Node process, including
SIGTERM resistance, SIGKILL, and observed exit.
