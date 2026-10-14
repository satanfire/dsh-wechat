# Changelog

## 0.3.2 — 2026-10-14

- 插件管理卡片改用消息气泡图标。

## 0.3.1 — 2026-10-14

- Prebundle QR PNG generation and its three MIT-licensed libraries; no external runtime dependencies.
- Keep build tools as development-only dependencies and ship reproducible artifacts with full license texts.
- Validate QR pixels against upstream and verify a production-only isolated install generates login QR codes.
- Installation and upgrades no longer require installing dependencies in a local clone.

## 0.3.0 — 2026-10-14

First public preview of `@satanfire/dsh-wechat`.

- Portable source entry and Cordis bundle, with no required build/install lifecycle.
- Single-owner QR login, text/transcribed-voice/media input, final replies and typing feedback.
- Request-scoped media delivery and lazy per-session text notifications.
- Durable ownership checks for media and phone interactions; concrete approval arguments with Web fallback.
- Stop ambiguous sends immediately rather than retrying possible acceptance.
- Retain failed/unknown inbound work and continue observing submitted work after timeout.
- Offline list/retry/discard/hold for failed inbound work; no automatic uncertain replay.
- Bilingual README, MIT licensing/provenance, validation scripts and CI.

Based on the local 0.2.2 prototype. The prototype's failure-record deletion is intentionally not used in the public version; previously discarded payloads cannot be recovered. Supported Harness runtime is pinned to 0.2.0-rc.2 pending broader acceptance.
