# Reusable Workflows

This directory contains reusable GitHub Actions workflows that can be used across all Knitli repositories.

## Available Workflows

### cla-check.yml

Checks if PR contributors have signed the CLA and stores signatures centrally.

**Usage in your repository**:

```yaml
# .github/workflows/cla.yml
name: CLA Assistant

on:
  issue_comment:
    types: [created]
  pull_request_target:
    types: [opened, closed, synchronize]

jobs:
  cla-check:
    uses: knitli/.github/.github/workflows/cla-check.yml@main
    with:
      repo_name: "your-repo-name"  # e.g., "codeweaver", "thread"
      cla_document_url: "https://github.com/knitli/your-repo/blob/main/CONTRIBUTORS_LICENSE_AGREEMENT.md"
    secrets: inherit
```

**Inputs**:
- `repo_name` (required): Repository name for signature file (e.g., "codeweaver")
- `cla_document_url` (optional): URL to CLA document (defaults to repo's `CONTRIBUTORS_LICENSE_AGREEMENT.md`)
- `branch` (optional): Branch for storing signatures (default: "main")

**Secrets**:
- `CLA_ACCESS_TOKEN`: Organization-level secret with write access to `knitli/.github` repo

**Features**:
- Checks org membership automatically - org members are exempt from CLA
- Automatically exempts bots and automation accounts (e.g., `claude`, `copilot`, `dependabot`)
- Posts clear success message when all contributors are exempt
- Stores signatures in `knitli/.github/cla-signatures/{repo_name}.json`
- Friendly PR comments with clear instructions for non-exempt contributors

**Examples**:

- [knitli/codeweaver](https://github.com/knitli/codeweaver/blob/main/.github/workflows/cla.yml)

---

### claude-pr-reviewer.yml

A reactive, persona-driven Claude agent ("Knitli Agent · PR Reviewer") that
reviews pull requests under the `knitli-agent[bot]` identity — distinct from
human users and from `github-actions[bot]`. It posts inline diff comments plus a
single branded summary comment.

**Usage in your repository**:

```yaml
# .github/workflows/claude-pr-reviewer.yml
name: Claude PR Reviewer

on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]
  issue_comment:
    types: [created]
  pull_request_review_comment:
    types: [created]

jobs:
  review:
    permissions:
      contents: read
      pull-requests: read
      id-token: write
    uses: knitli/.github/.github/workflows/claude-pr-reviewer.yml@main
    secrets: inherit
```

A ready-to-copy caller lives at [`examples/claude-pr-reviewer.yml`](../../examples/claude-pr-reviewer.yml).

**Inputs**:
- `review_alias` (optional): comment mention that triggers an on-demand review (default: `@knitli-review`)
- `model` (optional): override the Claude model (e.g. `claude-opus-4-8`); empty uses the action default

**Secrets** (org-level, granted to the target repo) — shared by all `knitli-agent` personas:
- `KNITLI_AGENT_CLIENT_ID`: Client ID for the `knitli-agent` GitHub App
- `KNITLI_AGENT_PRIVATE_KEY`: private key (`.pem`) for the `knitli-agent` GitHub App
- `CLAUDE_CODE_OAUTH_TOKEN`: org subscription OAuth token for Claude Code
- `ANTHROPIC_API_KEY` (optional): API credential preferred over subscription
  OAuth when configured; useful when subscription OAuth is unavailable in CI

**Triggers**:
- Auto: `pull_request` (opened, synchronize, reopened, ready_for_review)
- On-demand: a comment containing `@knitli-review` on a PR (issue comment) or on a diff line (review comment)

Reviews are queued one at a time per caller repository (`queue: max`) so a
stacked-PR submission cannot consume the provider quota in one burst. Before
starting the agent, the workflow skips superseded queued events and performs a
one-token Anthropic availability probe. The probe logs only the credential type,
HTTP status, and allowlisted rate-limit headers; it never logs the credential or
response body. This keeps authentication failures (`401`) distinguishable from
quota exhaustion (`429`) without enabling the action's sensitive full-output
mode.

**Permission model** (three layers of "review only" enforcement):
1. The minted App token is down-scoped to `pull-requests: write` plus read-only `contents`, `checks`, `issues`, `actions`, and `security-events`.
2. The workflow `GITHUB_TOKEN` carries only the scopes the action needs; all author-facing writes flow through the App token (so comments post as `knitli-agent[bot]`).
3. `--allowedTools` restricts Claude to the GitHub MCP servers (`mcp__github_*`, which includes inline review comments) plus read-only `gh pr`/`gh issue`/`gh run` queries and `Agent(Explore)` — no git, no push, no file edits. The review itself runs the `/code-review` plugin (`code-review@claude-code-plugins`).

**Note on fork PRs**: this uses `pull_request` (not `pull_request_target`), so PRs
from forks are intentionally skipped — fork PRs cannot access secrets. Enabling
fork review needs a separate, carefully-reviewed `pull_request_target` variant.

---

### claude-issue-triage.yml

A reactive Claude triage persona ("Knitli Agent · Issue Triage") that labels,
dedups, and routes issues under the same `knitli-agent[bot]` identity. It applies
existing labels, links likely duplicates, asks for missing information, and posts
one branded summary comment — it never closes, assigns, or edits the issue body.

**Usage in your repository**:

```yaml
# .github/workflows/claude-issue-triage.yml
name: Claude Issue Triage

on:
  issues:
    types: [opened, reopened]
  issue_comment:
    types: [created]

jobs:
  triage:
    permissions:
      contents: read
      issues: write
      pull-requests: read
      id-token: write
      actions: read
      checks: read
    uses: knitli/.github/.github/workflows/claude-issue-triage.yml@main
    secrets: inherit
```

A ready-to-copy caller lives at [`examples/claude-issue-triage.yml`](../../examples/claude-issue-triage.yml).

**Inputs**:
- `triage_alias` (optional): comment mention that triggers an on-demand triage (default: `@knitli-triage`)
- `model` (optional): override the Claude model; empty uses the action default

**Triggers**:
- Auto: `issues` (opened, reopened)
- On-demand: a comment containing `@knitli-triage` on an issue (not a PR)

**Permission model**:
1. The minted App token is down-scoped to `issues: write` plus read-only `contents` and `pull-requests`.
2. The workflow `GITHUB_TOKEN` carries only the scopes the action needs.
3. `--allowedTools` restricts Claude to the GitHub MCP servers plus read-only `gh` queries and `gh issue`/`gh label` label & comment commands — no git, no push, no file edits.

---

### claude-security-review.yml

A reactive Claude security persona ("Knitli Agent · Security Review") that does a
focused application-security pass on pull requests under the same
`knitli-agent[bot]` identity. It flags only real, plausibly-exploitable findings
as inline comments and posts one branded, severity-ordered summary comment.

**Usage in your repository**:

```yaml
# .github/workflows/claude-security-review.yml
name: Claude Security Review

on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]
  issue_comment:
    types: [created]
  pull_request_review_comment:
    types: [created]

jobs:
  security-review:
    permissions:
      contents: read
      pull-requests: write
      id-token: write
      actions: read
      checks: read
      security-events: read
    uses: knitli/.github/.github/workflows/claude-security-review.yml@main
    secrets: inherit
```

A ready-to-copy caller lives at [`examples/claude-security-review.yml`](../../examples/claude-security-review.yml).

**Inputs**:
- `security_alias` (optional): comment mention that triggers an on-demand security review (default: `@knitli-security`)
- `model` (optional): override the Claude model; empty uses the action default

**Triggers**:
- Auto: `pull_request` (opened, synchronize, reopened, ready_for_review)
- On-demand: a comment containing `@knitli-security` on a PR or a diff line

**Permission model**:
1. The minted App token is down-scoped to `pull-requests: write` plus read-only `contents`, `checks`, and `security-events` (code scanning alerts).
2. The workflow `GITHUB_TOKEN` carries only the scopes the action needs; all writes flow through the App token.
3. `--allowedTools` restricts Claude to the GitHub MCP servers plus read-only `gh pr` commands — no git, no push, no file edits.

**Note on fork PRs**: same `pull_request` limitation as the reviewer — fork PRs are skipped.

---

### claude-docs.yml

A reactive Claude docs persona ("Knitli Agent · Docs") that makes documentation
changes under the `knitli-agent[bot]` identity. **On-demand only**: mention
`@knitli-docs` in a comment on an issue or PR and it edits docs on a new branch,
opens a PR, and links it back. It never touches source-code logic or the default
branch.

**Usage in your repository**:

```yaml
# .github/workflows/claude-docs.yml
name: Claude Docs

on:
  issue_comment:
    types: [created]
  pull_request_review_comment:
    types: [created]

jobs:
  docs:
    permissions:
      contents: write
      pull-requests: write
      issues: read
      id-token: write
      actions: read
      checks: read
    uses: knitli/.github/.github/workflows/claude-docs.yml@main
    secrets: inherit
```

A ready-to-copy caller lives at [`examples/claude-docs.yml`](../../examples/claude-docs.yml).

**Inputs**:
- `docs_alias` (optional): comment mention that triggers a docs change (default: `@knitli-docs`)
- `model` (optional): override the Claude model; empty uses the action default

**Permission model**:
1. The minted App token is down-scoped to `contents: write` + `pull-requests: write` (push a branch, open a PR) + `issues: read`.
2. The workflow `GITHUB_TOKEN` carries only the scopes the action needs.
3. `--allowedTools` gives Claude file edits + `git`/`gh` + the GitHub MCP servers — no build/test runners. The prompt forbids source-code logic changes, default-branch pushes, and force-pushes.

---

### claude-fix.yml

A reactive Claude implementation persona ("Knitli Agent · Fix") — the
**highest-trust** bot. **On-demand only**: mention `@knitli-fix` in a comment on
an issue or PR and it explores the codebase, makes a small tested change on a new
branch, runs the project's test/lint commands, opens a PR, and links it back.

**Usage in your repository**:

```yaml
# .github/workflows/claude-fix.yml
name: Claude Fix

on:
  issue_comment:
    types: [created]
  pull_request_review_comment:
    types: [created]

jobs:
  fix:
    permissions:
      contents: write
      pull-requests: write
      issues: write
      id-token: write
      actions: read
      checks: read
    uses: knitli/.github/.github/workflows/claude-fix.yml@main
    secrets: inherit
```

A ready-to-copy caller lives at [`examples/claude-fix.yml`](../../examples/claude-fix.yml).

**Inputs**:
- `fix_alias` (optional): comment mention that triggers a fix (default: `@knitli-fix`)
- `model` (optional): override the Claude model; empty uses the action default

**Permission model**:
1. The minted App token is down-scoped to `contents: write` + `pull-requests: write` + `issues: write` + `checks: read`.
2. The workflow `GITHUB_TOKEN` carries only the scopes the action needs.
3. `--allowedTools` gives Claude file edits + `git`/`gh` + a curated set of build/test runners (`mise`, `make`, `npm`, `pnpm`, `yarn`, `bun`, `uv`, `cargo`, `go`, `pytest`) + the GitHub MCP servers. Extend the runner list in the workflow to match a repo's toolchain. The prompt forbids default-branch pushes, force-pushes, and weakening tests.

---

### teaparty.yml

A deterministic (non-Claude) find-and-replace bot: scans a PR's changed files
and rewrites British spellings to their American equivalents (`colour` ->
`color`, `initialise` -> `initialize`, `travelled` -> `traveled`, ...), then
commits the fix straight back to the branch. It exists because AI coding
assistants habitually leak British spellings into Rust code, which then trips
`typos` in every repo that gates CI on it — teaparty fixes that before the
gate ever sees it.

**Usage in your repository**:

```yaml
# .github/workflows/teaparty.yml
name: Teaparty

on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]

jobs:
  teaparty:
    permissions:
      contents: write
    uses: knitli/.github/.github/workflows/teaparty.yml@main
    secrets: inherit
```

A ready-to-copy caller lives at [`examples/teaparty.yml`](../../examples/teaparty.yml).

**Inputs**:
- `dry_run` (optional): report what would change without committing (default: `false`)
- `exclude_paths` (optional): newline-separated extended-regex (ERE) fragments;
  a changed file whose path matches any of them is skipped. **Added** to the
  built-in exclusions, never replaces them. Blank lines and `#` comments are
  ignored; an invalid pattern fails the run rather than silently scanning
  nothing. See [Byte-sensitive paths](#byte-sensitive-paths) below.

**Secrets** (both optional):
- `KNITLI_AGENT_CLIENT_ID` / `KNITLI_AGENT_PRIVATE_KEY`: if provided, the fix
  commit is pushed as `knitli-agent[bot]`; otherwise it falls back to the
  default `GITHUB_TOKEN` and shows up as `github-actions[bot]`

**How it works**:
1. Diffs the PR's changed files (three-dot, against the merge base) and keeps
   only common text/code file types — no lockfiles, no vendored/build
   directories, no binaries.
2. Runs `scripts/teaparty/replace.py` against that file list, using the
   curated dictionary at `scripts/teaparty/dictionary.yml` (checked out from
   this repo). Case is preserved (`Colour`/`COLOUR`/`backgroundColour` all
   resolve correctly), and the dictionary intentionally leaves out ambiguous
   words (see the exclusion notes at the top of the file) to avoid the false
   positives it's designed to prevent.
3. If anything changed, commits and pushes straight to the PR branch. No
   changes found -> no commit -> nothing happens, so it's naturally
   idempotent and safe to run on every push.

#### Byte-sensitive paths

Teaparty rewrites bytes in place, so before enabling it on a repo, work out
which of that repo's files must **not** be rewritten even when the spelling
genuinely is British, and list them in `exclude_paths`. The workflow has no way
to infer these — the built-in exclusions only cover the universal cases
(`node_modules/`, `vendor/`, `target/`, `dist/`, `build/`, lockfiles).

Typical categories:

- **Vendored upstream sources.** A specification or manual checked in as the
  authoritative reference. Rewriting `amongst` -> `among` there is a silent
  edit to a source of record, and it breaks any review that re-verifies a
  quotation against the file's exact text.
- **Frozen legal or filing snapshots.** Anything that must byte-match what was
  submitted elsewhere (a filed patent provisional, a signed attestation).
- **Golden / expected-output fixtures.** Rewriting an `.expected.json` makes a
  test pass by moving the goalpost instead of fixing the code.
- **Files with deliberate misspellings.** Typo-recovery tables, mangled-input
  corpora, and docs whose examples are misspelled on purpose.

A good starting point is the repo's existing spell-check exclusions
(`_typos.toml`'s `extend-exclude`, `.codespellrc`, ...) — those lists exist for
substantially the same reason. Keeping the two in sync is the intended
practice; `marque-dev`'s caller is the worked example.

#### Identifiers vs. prose

Teaparty edits only the files in a diff, so **renaming an identifier breaks the
references to it that live in files the diff didn't touch** — and it cannot tell
an identifier from prose. The dictionary is therefore curated to leave out words
that are plausibly identifiers: `cancelled` is excluded because
`JoinError::is_cancelled` (Tokio) and `CancellationToken` (.NET) are API
surface, so rewriting them is a compile error rather than a spelling fix.

If you hit a word in this category, the fix is to drop it from the dictionary
with a note in the exclusion list at the top of `dictionary.yml` — not to add
the affected file to `exclude_paths`. A path exclusion goes stale the moment a
new file uses the same identifier.

#### Self-reference

Any file that *documents* the fixer names the spellings it fixes, which means
teaparty rewrites it into nonsense. The caller workflow is the common case —
its header comment lists example British spellings, and a run turns that into
"British spellings (`color`, `initialize`, `behavior`)", which no longer says
anything. `examples/teaparty.yml` therefore ships with itself already in
`exclude_paths`; **keep that entry when you copy it.**

The same applies to this repository. There is deliberately **no teaparty caller
in `knitli/.github`** — only the reusable workflow — and adding one without
excluding `scripts/teaparty/` would be self-destructive rather than merely
untidy: a run rewrites every key in `dictionary.yml` into an identity mapping
(`colour: color` -> `color: color`, 564 of them). That result is still valid
YAML and still runs, so teaparty would silently stop fixing anything rather
than fail. If a caller is ever added here, it must exclude at minimum:

```yaml
exclude_paths: |
  ^scripts/teaparty/
  ^\.github/workflows/teaparty\.yml$
  ^\.github/workflows/README\.md$
  ^examples/teaparty\.yml$
```

**Note**: this is not a Claude persona — there's no model call and no prompt.
It's a small, fully deterministic spelling fix, nothing else. It also refuses
to push directly to a repository's default branch even if a caller wires it
to a `push` trigger.

---

## Agent input gating

Every `claude-*` workflow above starts with a `sanitize` job that the agent job
declares `needs:` on. It scans the untrusted text that reaches the agent for
ANSI/Unicode **echoback attack vectors** and, on finding one, fails — which skips
the agent job. A red check explains why.

Two surfaces are scanned:

- **Comments** on the triggering issue or PR (conversation and review comments).
- **The pull request diff**, for the four workflows that can be invoked on a PR.
  `claude-issue-triage` acts only on real issues, so it has no diff to scan.

### Why it blocks instead of sanitizing

The obvious design is to strip the threat out of the comment and let the agent
read the cleaned text. **That does not work**, and it is worth understanding why
before anyone tries to "improve" this into a filter.

`claude-code-action` deliberately reads the most attacker-controllable inputs
from the **immutable webhook payload**, not from the API:

| Agent input | Source | Effect of a post-trigger edit |
| --- | --- | --- |
| Trigger comment (`@knitli-review …`) | `create-prompt`: `context.payload.comment.body` | **None** — payload snapshot |
| Issue / PR body | `extractOriginalBody()` reads `payload.issue.body` | **None** — payload snapshot |
| Earlier thread comments | live GraphQL fetch | comment is **dropped** from context by `filterCommentsToTriggerTime()` |

Those functions exist specifically to defeat TOCTOU attacks — the upstream
comment says `extractOriginalBody` prevents "TOCTOU attacks where an attacker
edits the body after the trigger but before the action reads it." A sanitizer
edits a comment after the trigger, so from upstream's perspective it is
indistinguishable from the attacker that defense was built to stop, and its
edits are discarded or cause the comment to be filtered out entirely.

A gate does not have this problem: it is a **precondition**, not a mutation, so
it does not matter whether the agent later reads the payload or the API. It also
composes with upstream's TOCTOU defense instead of fighting it.

### False positives are narrow

The gate fails only on exit code `77` from `distill-strip-ansi` — a genuine
echoback vector. Content that merely *contains* escape sequences (a pasted
terminal capture with colour codes) is reported as `stripped`, not `threat`, and
does **not** block the agent. The `sanitize` preset is used rather than `dumb`
for the same reason.

### Why the diff is fetched rather than checked out

`gh pr diff` returns exactly the bytes the agent itself reads when it runs
`gh pr diff`, so the gate scans the artifact the agent actually consumes rather
than an approximation of it. Two consequences worth keeping:

- **No binary filter to get wrong.** Git's diff format renders a changed binary
  as `Binary files a/x and b/y differ`, never its content. Verified against
  knitli/marque-dev#1656: 48 changed binaries, **zero** escape bytes in the diff.
  A "scan the changed files on disk" design has to classify binary itself, and
  that is easy to botch — a naive NUL-byte-in-first-8-KiB filter let **all 110**
  of that repo's escape-bearing PDFs, fonts and images straight through, any one
  of which would have tripped a fail-closed gate and blocked review.
- **No checkout at all.** The gate needs no `contents` scope and never places
  untrusted code on the runner.

A diff too large for the API makes the step exit non-zero, which fails the gate
closed rather than scanning a truncated diff.

### Known gaps — read before trusting this

The gate does **not** scan:

- **file content outside the diff.** The agents hold `Read`, `Grep` and `Glob`,
  so an agent can read a file the PR never touched. Only the diff is gated;
  whole-repository scanning is not practical on an interactive path.

That is the whole list. It is a real limit rather than an oversight, so don't
describe the gate as total coverage either.

The **issue/PR body and title** gap this section used to describe is closed
([`knitli/strip-ansi-action#8`](https://github.com/knitli/strip-ansi-action/pull/8),
via `scan-event-payload`). How it is closed matters more than that it is:

Those fields are read from the **immutable webhook payload**, not re-fetched from
the API. The payload is a snapshot taken when the workflow triggered and cannot be
edited afterwards; a live fetch has no such property, and that difference is
exploitable — trigger on hostile text, then edit it clean, and a re-fetching scan
sees the sanitised version and passes while the agent reads the hostile original
out of the payload. Since `claude-code-action` deliberately reads the trigger
comment and the issue/PR body from the payload as its own TOCTOU defence, a gate
that re-fetches is not gating the same text the model reads.

Which means the payload scan also closed a fail-open in the **comment** surface
this README previously described as sound: the triggering comment is now covered by
the snapshot, not only by a live fetch that a post-trigger edit can launder. The
comment inputs stay switched on regardless, because the payload carries only the
*triggering* comment — earlier thread comments, which the agent also reads, still
come from the API.

The payload scan needs no token and no `permissions:` grant; it reads a file the
runner already has.

### Permissions callers must grant

Reading a **PR's** conversation comments requires `pull-requests`, even though
the endpoint is `/issues/{n}/comments`; reading a real **issue's** comments
requires `issues`. Granting only one of them and triggering the other context
403s, and because the gate is fail-closed a 403 **blocks the agent**.

So a caller job must grant the read scopes for whichever contexts it triggers
on. Each `sanitize` job declares only the scopes its workflow actually reaches,
and the `examples/` callers are already correct. If you add an `issues:` trigger
to a caller that previously only fired on PRs, add `issues: read` alongside it.

This is not hypothetical: `knitli/marque-dev` ran a comment scanner with
`issues: write` but no `pull-requests` scope for 27 consecutive runs, and all 27
failed 403 on a PR thread without anyone noticing, because the file-scanning
half of the same workflow was green.

---

## One-time setup for `knitli-agent` (org admin)

All three personas above share one GitHub App and one set of org secrets:

1. Register a GitHub App `knitli-agent` (webhook **disabled**) with the union of
   permissions the personas down-scope from:
   - Pull requests: Read & write
   - Contents: Read & write  (reviewer/security narrow to read)
   - Issues: Read & write  (triage uses write; others read)
   - Checks: Read
   - Code scanning alerts: Read  (security `security-events`)
   - Metadata: Read (mandatory)

   Install it on the org (all or selected repos).
2. Generate a private key (`.pem`).
3. Add org-level Actions secrets, granted to the target repos:
   - `KNITLI_AGENT_CLIENT_ID` (the App's Client ID, e.g. `Iv23li...`)
   - `KNITLI_AGENT_PRIVATE_KEY`
   - `CLAUDE_CODE_OAUTH_TOKEN` (already exists org-wide)
   - `ANTHROPIC_API_KEY` (optional; preferred by the reviewer when present)

---

## Creating Reusable Workflows

When creating new reusable workflows:

1. **Use `workflow_call` trigger**:
   ```yaml
   on:
     workflow_call:
       inputs:
         # Define inputs here
       secrets:
         # Define required secrets
   ```

2. **Add SPDX headers** for licensing compliance

3. **Document inputs and usage** in this README

4. **Test thoroughly** before using in production repos

5. **Version with tags** for stability (optional):
   ```yaml
   uses: knitli/.github/.github/workflows/cla-check.yml@v1.0.0
   ```

## Benefits of Reusable Workflows

- ✅ **Single source of truth**: Update logic once, applies everywhere
- ✅ **Consistency**: All repos use identical, tested workflows
- ✅ **Maintainability**: Easier to fix bugs and add features
- ✅ **DRY principle**: Don't repeat workflow code across repos

## Troubleshooting

### Authentication Errors & "Failed Membership Checks"

If organization members are routinely being told they need to sign the CLA, there is an authentication issue with the `CLA_ACCESS_TOKEN` preventing the action from accurately retrieving organization membership.

**Root Causes**:
1. The `CLA_ACCESS_TOKEN` (a Personal Access Token) lacks the `read:org` scope required to check organization membership.
2. The Knitli organization enforces SAML Single Sign-On (SSO), and the `CLA_ACCESS_TOKEN` has not been explicitly authorized for SSO. Without SSO authorization, the GitHub API returns `302`/`403`/`404` errors for organization membership checks, even if the token owner is an admin.

**How to Fix**:
1. Go to your GitHub Settings -> Developer settings -> Personal access tokens (classic).
2. Generate a new token with the `read:org` and `repo` scopes (or update the existing one).
3. **Crucial Step**: Next to your token, click "Configure SSO" and authorize it for the Knitli organization.
4. Update the `CLA_ACCESS_TOKEN` organization secret with this new, authorized token value.

## See Also

- [GitHub Docs: Reusing workflows](https://docs.github.com/en/actions/using-workflows/reusing-workflows)
- [CLA Setup Guide](../cla-signatures/README.md)
