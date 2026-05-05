<!-- SPDX-FileCopyrightText: 2026 Knitli Inc. -->
<!-- SPDX-License-Identifier: MIT OR Apache-2.0 -->

# Security Policy

> [!IMPORTANT]
> Please **do not report security vulnerabilities in our public issues or discussions**. This may allow attackers to exploit the vulnerability before we have a chance to fix it.

## Reporting a Vulnerability

Our customers expect uncompromising security, and we're obsessive about delivering it. We take security vulnerabilities seriously and **appreciate responsible disclosure.**

## Disclosing Vulnerabilities Responsibly

### We Welcome Good Faith Security Research (white hats welcome)

**Knitli Inc. authorizes good-faith security research.** If you follow the [basic rules](#rules-like-fight-club) and reasonably stay in the [scope](#scope---whats-fair-game) we lay out here, **we will not try to sue you, file criminal charges or complaints, or refer you to law enforcement**. We consider good faith research activities necessary, valuable and authorized under the Computer Fraud and Abuse Act (18 U.S.C. § 1030), Digital Millennium Copyright Act's anti-circumvention provisions (17 U.S.C. § 1201), and similar state laws, and our terms of service. We won't revoke this authorization retroactively if we can't validate your findings or find them immaterial.

If anyone else tries to sue, charge, or investigate you because of activities you conducted in good faith under this policy, we will let everyone necessary know that you had our authorization. [^1]

Knitli's authorization only covers activities you conduct yourself against assets that are [in scope](#scope---whats-fair-game) -- the scope does **[not](#out-of-scope)** extend to our customers, contractors, or other third parties. 

### Scope - What's Fair Game

#### In Scope

> - Marque source code in the marquetools GitHub organization
> - Source code for any repository in the Knitli GitHub organization
> - Released Marque or Knitli artifacts distributed through our official channels (crates.io, PyPI, npm, GitHub Releases)
> - Knitli-operated infrastructure directly supporting Marque (marque.tools, *.marque.tools, knitli.com, *.knitli.com)
> - Marque or Knitli hosted services operated by Knitli (none currently; we'll list them here when they exist)

#### Out of Scope

> - Deployments of Marque or any other Knitli customers operated by customers, contractors, or other third parties — report those to the operator
> - Third-party dependencies of Marque — report upstream, and let us know so we can coordinate
> - Social engineering attacks against Knitli personnel, customers, or contractors
> - Physical attacks against Knitli facilities or personnel (not advised; I have a special set of skills...)
> - Denial-of-service testing against any system
> - Automated scanning that generates significant traffic without prior coordination
> - Findings already publicly disclosed or previously reported

### Rules (like Fight Club)

**When conducting research, you agree to:**

- Stop testing as soon as you confirm a vulnerability exists. Do not develop exploit capability beyond what's needed to demonstrate the issue.
- Not access, modify, exfiltrate, or destroy data that isn't yours. If you encounter such data accidentally, stop, report it, and don't retain copies.
- Use test accounts and test data wherever possible.
- Not publicly disclose the vulnerability before [coordinated disclosure](#we-follow-coordinated-disclosure-consistent-with-isoiec-29147).
- Not perform actions that could degrade service for other users.

### How to Report

You can report a vulnerability through one of the following channels:

1. **GitHub Private Vulnerability Reporting (preferred)**
   Use GitHub security advisories reporting for the relevant product or deployment.
   - [Marque application](https://github.com/marquetools/marque/security/advisories/new)
   - [CodeWeaver application](https://github.com/marquetools/marque/security/advisories/new)
   - [Thread application](https://github.com/marquetools/marque/security/advisories/new)
   - [Everything else](https://github.com/marquetools/.github/security/advisories/new)

   With this method, you may optionally submit a private pull request with a fix. Learn more [in the GitHub docs](https://docs.github.com/en/code-security/how-tos/report-and-fix-vulnerabilities/privately-reporting-a-security-vulnerability).

3. **Encrypted Email**
   Send a detailed report to: **[security@knitli.com](mailto:security@knitli.com)**. **Please encrypt your email.** You can find our **public PGP key [here](https://knitli.com/.well-known/pgp-key.txt)** (key fingerprint: 5c6f01e5ca848e0d0926596177f53342fc6ecc67)

### What to Include

Please include as much of the following information as possible in your report:

1. **Type of issue** (e.g. cross-site scripting, authentication bypass, etc.)
2. **Full paths of source file(s) at the root of the issue** (if relevant)
3. **The location of the affected source code** (tag/branch/commit or direct URL)
4. **Any special configuration required to reproduce the issue**
5. **Step-by-step instructions to reproduce the issue**
6. **Proof-of-concept or exploit code** (if possible)
7. **Impact of the issue**, including how an attacker might exploit the issue
8. **Suggested fix or mitigation** (if you have one)
9. **Your contact information** (email, Twitter, etc.) so we can follow up with you if we need more information or when the issue is resolved

## Our Response Process

**We take all vulnerability reports seriously and will respond to you promptly**. We may ask follow-up questions, and we will keep you updated on our progress as we investigate and fix the issue. We will work to resolve the issue as quickly as possible, but please understand that some issues may take longer to fix than others depending on their complexity and severity.

### Response Timeline

Response times will vary by severity and complexity. The following are the longest we would expect to take:

| Stage                    | Target      |
|--------------------------|-------------|
| Acknowledgment           | 24 hours    |
| Initial triage           | 5 business days[^2] |
| Fix development          | Varies by severity |
| Public disclosure (coordinated) | [IAW ISO/IEC 29147](#we-follow-coordinated-disclosure-consistent-with-isoiec-29147) |

### We Follow Coordinated Disclosure Consistent with ISO/IEC 29147

*Default timeline*: Public disclosure happens **90 days after you report the vulnerability**, or **after we release a fix and our users have had reasonable time** to deploy it — **whichever is later**, but in no case more than 120 days from initial report without your written agreement.

For vulnerabilities under active exploitation, we may accelerate this timeline. For vulnerabilities requiring substantial architectural changes, we may request an extension. We'll explain why and how long we need.

## Appreciation

**We appreciate your help in keeping Marque and Knitli secure.** When we publish a security advisory, we will credit you (or preserve your anonymity - as you wish) and link to any CVE we obtain. We commit to requesting CVEs for security-relevant findings rather than treating them as ordinary bug fixes. We will also include you in our security hall of fame on our website (doesn't exist yet because we've never had one -- you can be first!).

(And no, we don't offer bounties. I'm a solo dev bootstrapping a startup; money is scarce. You'll have my deepest appreciation. When I have customers, I'll re-evaluate.)

[^1]: And that they're being really uncool.
[^2]: We like to pretend we have weekends. We don't.
