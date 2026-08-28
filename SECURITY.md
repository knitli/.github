<!-- SPDX-FileCopyrightText: 2026 Knitli Inc. -->
<!-- SPDX-License-Identifier: MIT OR Apache-2.0 -->

# Security Policy

> [!IMPORTANT]
> Please **do not report security vulnerabilities in our public issues or
> discussions**. That can let an attacker exploit the vulnerability before we
> have a chance to fix it.

**The policy lives at <https://knitli.com/security/>.** That page is canonical
and carries all of it: the safe-harbor authorization for good-faith research,
what is in and out of scope, the rules, how to report, what to include, our
response commitments, and the coordinated-disclosure window.

## How to report

- **Encrypted email** to
  [security@knitli.com](mailto:security@knitli.com). Our public PGP key is at
  <https://knitli.com/.well-known/pgp-key.txt> (fingerprint
  `0F54 64D4 F700 BFCB 86C9 9653 2199 67BF 4361 8F4D`).
- Semaphore, but at that point just go a little further and talk to us.

The machine-readable pointer is
<https://knitli.com/.well-known/security.txt>.

## Why this file is short now

The policy used to live here in full, and a second, shorter version lived in
each repository. They drifted — the numbers disagreed. Published commitments
are only worth anything if there is exactly one copy of them, so there is now
exactly one.

Because of that reality, if for some reason we fail to update it and the fingerprint
above doesn't match the key at `pgp-key.txt`, you should still consider it official
IF it matches what `security.txt` is signed by. Those are the canonical files.
