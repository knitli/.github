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

**Triggers**:
- Auto: `pull_request` (opened, synchronize, reopened, ready_for_review)
- On-demand: a comment containing `@knitli-review` on a PR (issue comment) or on a diff line (review comment)

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
