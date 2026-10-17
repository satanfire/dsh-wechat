# Changelog

## 0.5.1 — 2026-10-17

- 优化 `/list` 排版：去掉行首的当前会话箭头，序号左对齐；当前会话改在行尾用 `· 当前` 标注，列表首行不再附带图例。手机端每行起始位置对齐，当前会话仍一眼可辨。
- 无行为变化：可见性、排序、15 条上限、800 字符上限、`/switch` 语义均不变。全量 167 项测试通过。

## 0.5.0 — 2026-10-16

- 新增 `/list`：列出可切换的会话，`▸` 标出当前会话。列表沿用网页侧栏的可见性规则：不列子代理会话，不列已归档会话，空的未使用会话只在它是当前会话时显示。按最近活动排序，最多 15 个。
- 新增 `/switch <序号>`：把后续微信消息切到该会话。序号取自最近一次 `/list`，只覆盖列表实际渲染的最近 15 个会话，10 分钟后失效；切换前用**当前绑定**重新计算可见列表并复核目标仍然存在，已归档、已删除或重新变回空会话时拒绝并提示重新 `/list`。命令大小写不敏感。
- 新增 `/list` 的标签清洗：标题压成单行，清除 C0/C1 控制字符与双向文本覆盖字符，并截断到 24 字符，使 15 行输出稳定落在单条 800 字符以内。
- 新增 `/list` 与 `/switch` 读取失败时仍回复提示，不再静默丢弃。
- 切换只改绑定的会话，提交仍走 `sessionController.prompt`（内部隐式 resume），不调用 `create`，因此不会触发 cwd 或 agentPreset 冲突，也不需要改存储或迁移。
- 归档集合通过 `ctx.get('workspaceRegistry')` 可选读取；部署未挂载 workspace 注册表时跳过归档过滤。该读取不需要新增注入依赖。
- `/stop` 只停止当前绑定会话的任务，作用范围不随切换扩大。
- 新增 `/stop all`：停止所有正在运行的微信任务，包括切换后留在旧会话里的任务；没有运行中的任务时明确回复。未知作用域回用法提示，不会静默按 `/stop` 处理。
- 修复 `/stop` 失败时无回复：`sessionController.cancel` 是同步方法，冷会话会同步抛出 `session/not-found`；同步抛错现在被兜住，`/stop` 回「停止请求失败，请稍后重试。」，`/stop all` 按「已请求停止 N 个会话，其中 M 个失败」汇总，不会整条命令失败且无回复。
- 修复切换会话后旧会话的审批和追问无法回复：`/approve`、`/reject`、`/answer` 不再要求当前绑定等于请求所属会话。仍校验绑定用户、请求所属任务是否仍在运行、以及轮次归属，未降低校验强度。
- 新增 21 项回归用例（会话列表可见性与排版、`/list`、`/switch`、`/stop` 与 `/stop all` 的作用范围、切换后的审批回复、命令失败时仍回复）。全量 167 项测试通过。

## 0.4.2 — 2026-10-16

- 修复入站消息丢失回复：「已从队列取出、提交尚未落盘」此前被判为结果不明并立即丢弃，实际这是投递途中的正常窗口，真实回复会随之产生却发不出去。实测 20 条入站消息中 5 条中招。
- `inspectRequest` 新增 `inflight` 状态，与需要人工确认的 `needsReview` 区分；取出到提交之间的窗口不再判为不可确认。
- 等待该窗口的时长单独设上限 `inflightGraceMs`（默认 60 秒）。正常情况提交在毫秒级落盘，立即返回；提交始终未落盘时按该上限报错，不占用 30 分钟的观察超时，也不长时间阻塞后续消息。
- 重启恢复路径接受 `inflight`，继续等待已有结果，仍不重提任务。
- 回归用例覆盖两条路径：窗口内提交后正常拿到回复，窗口内始终未提交则按宽限上限失败。146 项测试通过。

## 0.4.1 — 2026-10-16

- `@deepseek-ai/dsh` 兼容声明由精确锁定 `0.2.0-rc.2` 改为下限 `>=0.2.0-rc.2`。DSH 的兼容性检查按 `peerDependencies` 的版本范围判定，精确锁定会让更新运行时直接跳过整个 bundle。
- DSH 的这项检查不读 `peerDependenciesMeta.optional`，所以此前把该 peer 标为 optional 并不能免除拦截；本次直接放宽范围。
- 验证范围：仅确认在 DSH 0.2.1-alpha.4 上 bundle 可被加载（不再被版本拦截）。微信登录、消息收发等链路未在 0.2.0-rc.2 之外的运行时复验。
- `scripts/check.mjs`、`package-lock.json`、`README.md`、`README.en.md`、`docs/verification.md` 同步该声明。

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
