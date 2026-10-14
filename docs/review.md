# Release review — 0.3.0

The local 0.2.2 prototype was reviewed before creating the public package. The public version differs intentionally; the installed local prototype was not modified by this release preparation.

| Finding | Public-version handling | Regression evidence |
| --- | --- | --- |
| Failed/ambiguous inbound work lost its original record | Retain payload and request linkage; no uncertain replay; offline retry only for known preparation failure | Bridge, store and recovery tests |
| Observation timeout dropped an active task | Keep submitted tracking and continue observing; explicit offline hold for stalled work | Eventual-reply and recovery tests |
| Uncertain network sends retried possible acceptance | Stop on the first uncertain result; retry only known nonacceptance | Text and final media-send tests |
| Session-level ownership could include unrelated Web calls | Require durable admitted request/turn correlation and exact tool call; mixed/ended/pending turns fail closed | Media and interaction ownership tests |
| Phone approval omitted concrete arguments | Include exact short arguments; missing/oversized/unverified call falls back to Web | Approval-detail/fallback tests |
| Manual versioned build made generic distribution fragile | Load portable source entry; package check expands actual tarball and imports Host modules | Manifest and package verification scripts |
| License/compatibility/install documentation incomplete | MIT license and notices, exact Harness peer declaration, Node engine, bilingual docs, CI | Manifest/metadata checks |
| Transient media preparation failure discarded attachments | Retain retryable preparation record; only known invalid/oversized media is terminal | Temporary-media failure test |
| Definite text rejection mislabeled uncertain and blocked suffix | Mark definite failure and cancel unsent chunks from that reply | Multipart failure test |

The prototype's distribution artifact did exist and matched source at review time; the release issue was dependence on a manually generated versioned path, not a missing working artifact. Missing peer dependencies also did not reject installation: they allowed unknown compatibility, now constrained explicitly.

Authentication review found no concrete bypass in the existing shared Connection route; this was source/API inspection, not a live authentication penetration test. File/turn checks narrow known races but do not make the plugin a sandbox against malicious Host code or a hostile process racing the filesystem.

No live WeChat acceptance was performed for this public version. See [verification.md](verification.md) for remaining manual checks. Passing local tests and tarball checks justify a public preview, not production or cross-version guarantees.
