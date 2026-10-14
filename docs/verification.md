# Verification record

## Release 0.3.1

QR generation uses a checked-in reproducible bundle. Tests compare decoded PNG pixels with upstream, check artifact hashes/licenses, and install the real tarball into a separate directory with development dependencies omitted. That production install must contain only the plugin and must generate the login PNG without resolving qrcode or esbuild externally. These tests do not scan a live account QR or send WeChat messages.

## Release 0.3.0

Review scope: source code, current Harness Service/Event contracts, package contents and automated tests. No private credentials or local live message stores were inspected. No live WeChat message was sent during the public-version review.

Harness reference runtime: 0.2.0-rc.2. Local environment: macOS. The public manifest intentionally does not declare support for newer/unverified Harness versions.

Automated validation includes:

- Message/cursor persistence, crash lock handling, deduplication and restart recovery.
- Preservation of failed inbound payloads; continued observation after timeout; refusal to replay uncertain submissions.
- Immediate stop after uncertain text/media acceptance; bounded retries only after known rejection.
- Rejection of Web-origin, pending, mixed-turn, ended-turn and uncorrelated media/interaction calls.
- Exact phone approval arguments, Web fallback when unavailable/oversized, expiration and one-shot decisions.
- File containment, escaping symlinks, upload/download bounds and immutable attachment snapshots.
- Manifest/client ID agreement, syntax, lockfile identity, and real npm tarball imports/file allowlist.

A matching API contract and a passing mocked suite do not establish live activation or phone rendering. This public package was not installed alongside the currently enabled local package because both own the same route and store. Existing local prototype phone tests do not count as acceptance of 0.3.0 changes.

Before treating this preview as production-ready, manually verify:

1. Clean-profile installation into DSH Web 0.2.0-rc.2, QR binding, stop/start, restart and logout.
2. Light/dark settings rendering and client console without slot crashes.
3. Real text/image/file/video reception and delivery, including empty files and malformed attachments.
4. Concurrent Web/WeChat tasks and approval fallback with PTC/nested calls.
5. Context expiry, long tasks, network loss after possible send acceptance and long-running storage growth.
6. Other supported operating systems before widening the environment claims.

CI outcomes are available in GitHub Actions; workflow configuration is not evidence that an unobserved run passed.
