# Security policy

v0.4.0 的实现与验证由 Lead 完成。兼容范围以 package.json 声明的 Harness 版本为准。这是个人单用户集成，不是多租户服务。

For a vulnerability, use GitHub's private vulnerability reporting if available: https://github.com/satanfire/dsh-wechat/security/advisories/new. If private reporting is unavailable, open an Issue asking for a private contact channel without posting exploit details or sensitive data. No response-time SLA is promised.

Include the plugin/Harness/Node versions, the affected boundary, and a minimal reproduction with fake credentials. Never upload bot tokens, QR codes, context tokens, signed media URLs, credentials storage, raw store.json, or private chat logs.

The Host runs plugin code in-process. The bridge relies on Harness Connection authentication and tool authorization; it is not an additional sandbox. Phone approval is single-use and requires a verified WeChat turn. Review the full concrete operation before approving. Oversized/unverified operations fall back to Web.

An approval or question reply is bound to the owner, the request's own Session, and its verified turn — not to the Session currently bound to WeChat. A pending request therefore stays answerable after `/switch`, while a stranger, a replayed nonce, a finished task, or an unverified turn is still refused.

本地活动记录仍含敏感正文及上下文。v0.4.0 对失败或结果不明的入站、出站消息只保留去重 ID，不保留正文。存储打开时自动清理旧失败记录，不改变绑定、游标和会话，也不删除 DSH 会话日志。

提交结果未知不重提。观察超时会丢弃跟踪，不取消 DSH 任务。先到 Web 核对结果，避免重复执行。iLink 层仅对已知未接受的网络请求保留有限重试。

去重 ID 最多保留最近 10,000 个，非常旧的重放可能无法识别。平台去重及上下文长期有效性未经实机证明。不再提供离线恢复脚本；丢弃的正文无法从插件恢复。不要删除存活进程的存储锁。
