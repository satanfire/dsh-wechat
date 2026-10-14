# Changelog

## 0.4.0 — 2026-10-14

- 设置页移除“待发送”“发送状态待确认”行及计数。
- 入站收件失败即删除，不重试。失败、结果不明的入站和出站消息不保留正文，仅保留去重 ID。
- 提交结果未知不重提，提示状态不明、已丢弃，可在 Web 查看。观察等待超时也丢弃跟踪并提示到 Web 查看，不取消 DSH 任务。
- 已明确提交的任务正常重启后继续观察，不重新提交；`queued` 未发送任务可恢复。
- 重启删除中断的 `sending` 及遗留失败、`uncertain`、`control-pending` 记录。存储打开时自动清理旧失败记录，绑定、游标和会话不变。
- 同一分段回复失败或结果不明后，丢弃尚未发送的后续段，其他消息继续处理。iLink 层仍仅对已知未接受的网络请求有限重试。
- 去重 ID 最多保留最近 10,000 个，超出后可能无法识别非常旧的重放。
- 移除 `scripts/recover.mjs` 和对应测试，不再提供手动恢复失败消息的入口。
- 明确工具语义：`queued` 不等于送达，`sent` 仅表示服务接受，失败去重结果不误报 `sent`。
- 修复停止清理写入失败后无法重试的问题。144 项回归及发布包检查通过；浏览器和真实微信验收尚未完成。

## 0.3.3 — 2026-10-14

- 设置左侧的微信导航改用消息气泡图标。
- 为 DSH 0.2.0-rc.2 的默认齿轮增加兼容处理，支持中英文切换和卸载清理。

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
