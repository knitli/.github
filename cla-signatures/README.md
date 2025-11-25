# CLA Signatures

This directory stores Contributor License Agreement (CLA) signatures for all Knitli repositories.

## Files

Each repository has its own JSON file:
- `codeweaver.json` - CLA signatures for knitli/codeweaver
- (Additional repos will be added as needed)

## How It Works

The CLA Assistant GitHub Action automatically:
1. Checks if PR authors have signed the CLA
2. Prompts unsigned contributors with instructions
3. Records signatures in this directory when users agree

## Bot Allowlist

The following accounts are exempt from CLA requirements:
- `bashandbone` (founder)
- `github-actions[bot]`
- `dependabot[bot]`
- `codegen-sh[bot]`
- `changeset-bot`
- `claude[bot]`
- `copilot`

## Privacy Note

While this repository is public, signature files only contain:
- GitHub username
- Timestamp
- PR/Issue number

No email addresses or personal information are stored.

## Manual Access

To view signatures:
```bash
cat cla-signatures/codeweaver.json | jq
```

To verify a specific user:
```bash
cat cla-signatures/codeweaver.json | jq '.signedContributors[] | select(.name=="username")'
```

## Maintenance

Signature files are automatically created and updated by the CLA Assistant bot.
Manual modifications are not recommended as they may be overwritten.
