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
