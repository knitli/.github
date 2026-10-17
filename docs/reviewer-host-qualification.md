# Dormant synthetic host-handoff qualification

This slice implements host callback capture, fresh-job handoff sealing, and completed-source-run acquisition. It installs no workflow and makes no SDK, provider, native-client, PR, or hosted execution claim. Templates live under `scripts/fixtures/reviewer-host-qualification/`, every job is disabled, and every shell entry point refuses execution. They are review contracts, not dispatchable workflows.

## Boundary

`captureQualificationPublication()` invokes the existing producer and captures its publication callback. Only the host returns the serialized attempt identity and envelope digest. A fresh sealing job accepts those two platform `needs` outputs plus independently captured platform context; it cannot obtain identity from downloaded producer JSON. The signer attests the resulting `reviewer-host-handoff.json` bytes using `actions/attest-build-provenance` v4.2.2 pinned to `4d101475d8b20a2381f78447822ac1eab6504dd8`.

A separate acquisition run starts after the source attempt finishes. `acquireQualificationEvidence()` verifies the handoff signature before parsing identity, checks authenticated run/attempt and job metadata, validates the existing producer bundle, invokes the existing composer, and checks the source metadata and bundle again before publishing without overwrite. Repository ID, caller source SHA, reusable workflow SHA, run ID and attempt are trusted host policy. A branch name alone does not prove protection. Artifact bytes, names and attestation predicate identity are not authority.

The acquisition API accepts a host-prepared directory and bounded handoff/bundle buffers. It does not download or extract archives. The authenticated GitHub `get` port and optional verifier port are trusted host dependencies; neither can be selected by artifact content. Tests inject a verifier stub explicitly. A production caller must use the default pinned cryptographic verifier.

## Verified schema and pins

The local verifier is GitHub CLI **2.101.0**, revision `0cf1092493af067646fc5f3db9421c6a6ec9c938`, macOS arm64 executable SHA-256 `aa97dfb4a82f7c56063cdcbfaa39a738b923c1bdca29bd5a041b8e959ca38e04`. Its absolute executable path is intentionally local. Other platforms refuse verification. The checked-in GitHub trusted-root JSONL has SHA-256 `26b3382d5700afbcd84f980d1d5b6c52bff743dc2a8ee86b8b44c8e1245ce485`; it is the GitHub-only record acquired with the pinned CLI's `attestation trusted-root --hostname github.com` on 2026-10-17, not a fixture CA. Public Sigstore identities are denied. Root refresh is a reviewed code change.

Primary sources:

- [CLI policy](https://github.com/cli/cli/blob/0cf1092493af067646fc5f3db9421c6a6ec9c938/pkg/cmd/attestation/verify/policy.go) and [verification implementation](https://github.com/cli/cli/blob/0cf1092493af067646fc5f3db9421c6a6ec9c938/pkg/cmd/attestation/verification/sigstore.go). Signer-workflow matching is a prefix check, so the adapter uses exact certificate identity plus signer digest and rechecks the returned signed certificate fields.
- [sigstore-go v1.3.0 certificate extensions](https://github.com/sigstore/sigstore-go/blob/22d3691c7b8e0c5530fae3c05577690bfef5cd00/pkg/fulcio/certificate/extensions.go) and [verification result](https://github.com/sigstore/sigstore-go/blob/22d3691c7b8e0c5530fae3c05577690bfef5cd00/pkg/verify/signed_entity.go).
- [Fulcio GitHub principal](https://github.com/sigstore/fulcio/blob/78da569beb478103bf24d8b5085dd33f8ac33c7e/pkg/identity/github/principal.go) binds `runInvocationURI` to repository, run ID and attempt from GitHub OIDC claims.
- [Pinned attestation action](https://github.com/actions/attest-build-provenance/blob/4d101475d8b20a2381f78447822ac1eab6504dd8/action.yml) accepts a fixed subject name and digest and returns its bundle path.

The JSON is an array; certificate claims are flattened under `verificationResult.signature.certificate`, not a nested `extensions` field. The adapter requires exact issuer, SAN, signer URI/digest, GitHub-hosted environment, source repository URI/ID/digest/ref/private visibility, manual trigger, caller workflow URI/digest, and run invocation URI. It also checks the verified statement's sole subject name and SHA-256 digest. Workflow-controlled predicate fields cannot replace certificate claims.

A real offline verification using the pinned CLI and upstream CLI reusable-workflow artifact, signed bundle and upstream trusted-root fixture confirmed this output shape. That public upstream signature proves the CLI/schema mapping only; it does not prove a Knitli qualification run. The focused suite additionally executes the actual pinned verifier against an unsigned bundle and requires refusal. All positive host pipeline tests use an explicitly labelled trusted verifier stub.

## Remaining activation gates

The synthetic fixture creates its own temporary Git repository and drives the real snapshot/producer publication path with a deterministic completion stub. Acquisition must still yield `unavailable`, `missing-review-step`, `unverified`, and `unknown`; synthetic completion is never SDK completion.

Before any hosted qualification: review platform check-run discovery and host-only output wiring, pin and qualify a hosted Node/CLI/root runtime, pin artifact upload/download and bounded extraction, bind the caller and reusable revisions, and resolve the reusable workflow's existing required provider-secret interface without exposing secrets to this fixture. Obtain independent trust-boundary review and completed-run evidence before proceeding to an SDK canary. No credential acquisition, native attachment, full Node process/Docker/UDS isolation claim, Mesh delivery, idle-session wake, or production activation is part of this slice.
