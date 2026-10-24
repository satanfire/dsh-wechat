# DSH WeChat

[中文](README.md) · [MIT License](LICENSE)

A community, single-owner WeChat iLink Bot bridge for **DeepSeek Harness Web**. Scan a QR code, send tasks from WeChat, receive final replies, answer questions, review eligible tool approvals, and ask another DSH session to notify your bound WeChat. This project is not affiliated with Tencent or DeepSeek. Account eligibility depends on the platform.

## Requirements and installation

Requires **`@deepseek-ai/dsh >= 0.2.0-rc.2`** (a lower bound only, no upper bound) with Web services and a configured model, plus Node.js **22+**. Supports macOS and Linux; Windows has not been verified.

```sh
git clone https://github.com/satanfire/dsh-wechat.git
cd dsh-wechat
dsh plugin --profile web add "$PWD"
```

Alternatively, enter the clone's absolute path in the Harness plugin manager, or use a GitHub source with a supporting installer:

```sh
dsh plugin --profile web add github:satanfire/dsh-wechat
```

QR dependencies are prebundled inside the plugin. Installation needs no external runtime dependencies, build step, or install scripts. After installation, restart the existing Harness Web process and refresh its page. Install from GitHub or a local directory; the package is not yet published to npm.

Do not run multiple WeChat bridges using the same bot account.

## Connect and use

Open **Settings → WeChat**, select **Scan to connect**, confirm on your phone, then select **Start**. Send the bot a text message. The bridge creates a dedicated Harness session; settings shows its title, and hovering reveals the full session ID. The conversation can be opened in Web. Use `/list` to see switchable sessions, then `/switch NUMBER` to send later messages to another one.

| Text command | Effect |
| --- | --- |
| `/new` | Create and bind a new session |
| `/list` | List switchable sessions; the bound one ends its row with ✅ |
| `/switch NUMBER` | Bind the session at that position in the latest `/list` |
| `/status` | Check connection |
| `/stop` | Cancel the task in the bound session |
| `/stop all` | Cancel every running WeChat task, including one left in an older session |
| `/help` | Show commands |
| `/approve CODE` | Allow this operation once |
| `/reject CODE` | Reject this operation |
| `/answer CODE ANSWER` | Answer a question; option numbers and comma-separated multi-select are supported |

Control commands must be literal text. Use `text:` for an answer that should remain a numeric string. Codes expire within five minutes and do not survive restart.

`/list` shows what the Web sidebar shows: no subagent sessions, no archived sessions, and a blank unused session only while it is the bound one. Rows are ordered by recent activity and capped at 15. The bound session always stays listed: an archived binding is kept and marked `已归档`, and it is appended when activity order would drop it past the cap. A deleted binding is reported. `/switch` numbers come from the latest `/list`; after ten minutes, or after a newer list, send `/list` again.

Switching only redirects later messages; it does not widen `/stop`. `/stop` cancels the bound session only — use `/stop all` for a task still running in an older session. Approvals and questions from that session stay answerable through `/approve`, `/reject`, and `/answer`, even while another session is bound. A message that is already queued but not yet dispatched uses the binding that exists when it is dispatched.

Phone approvals include the actual tool arguments and verify durable WeChat request/turn ownership. Missing or over-500-character arguments and unverified calls fall back to Web review. Mixed Web/WeChat turns cannot use request-scoped media sending or phone interactions.

## Attachments and notifications

- Text, voice with an existing transcript, images, files, and videos are accepted. The plugin does not transcribe audio.
- PNG/JPEG/WebP/GIF images: 12 MiB each, subject to Harness image policy.
- Files/videos: 50 MiB each and combined per message, at most eight attachments. Videos enter as files, not model video frames.
- `wechat_send_media({path,kind})` sends a workspace attachment from a verified WeChat turn. External paths and escaping symlinks are refused. Videos are delivered as file attachments.
- Ask any ordinary Harness session to notify your WeChat when done. It loads `load_wechat_tools({})`, then uses its scoped `wechat_send_text({text})`. Text is 1–800 Unicode characters; the recipient is always the bound owner.
- `queued` only means persisted, not delivered. `sent` only means the WeChat service accepted the message, not that the phone read it. `failed` means the message was dropped, either after a clear failure or an unknown result; a failed dedup result is never reported as `sent`.
- A failed push is retried up to five times (after 5 s, 30 s, 2 min, 6 min and 15 min), each attempt using the freshest owner context; only then is it dropped. Uncertain outcomes are not retried, so a message the service may already hold is never duplicated.
- When the context is stale (`ret=-2 prepare failed` / `-14`), the send is retried once without `context_token`: iLink accepts that degraded form for short outages.
- If iLink still refuses (session not ready - the owner has not messaged the bot for a while), the message is not lost: it is held (at most 20 items, 24 hours) and delivered after the owner's next message. This avoids spending the ~10-message quota each inbound message grants.

Push uses the latest owner conversation context. Send the bot a fresh phone message when context is missing or expired; indefinite offline proactive delivery is not promised. WeChat text does not render Markdown headings, bold, or tables.

## Configuration

New sessions default to the Harness process startup directory and the `standard` preset. Existing sessions retain their own directory. Override the existing row in the profile's user patch:

```yaml
- id: dsh-wechat
  config:
    cwd: /absolute/path/to/your/workspace
    agentPreset: standard
```

Use an existing absolute Host directory and an installed preset ID. Configuration is replaced wholesale, not merged. Restart after changes. Do not commit private paths or credentials.

## 持久化与故障处理

设置页显示连接、运行状态和当前会话。不再显示“待发送”“发送状态待确认”行及计数。

收件批次与游标原子保存。最多保留最近 10,000 个去重 ID；超出后可能无法识别非常旧的重放。已明确提交的任务正常重启后继续观察，不重新提交。`queued` 中尚未发送的任务可在正常重启后恢复。

入站收件失败即删除，不重试。失败或结果不明的入站、出站消息不保留正文，仅保留去重 ID。提交结果未知时不重提，提示“状态不明，已丢弃，可在 Web 查看”。观察等待超时也丢弃跟踪，并提示到 Web 查看。这不会取消 DSH 任务，也不再自动转发该任务回复。消息已从收件队列取出、提交记录尚未落盘时，插件继续等待而不判为状态不明；该窗口通常数个事件内闭合，另有 60 秒上限，超限才按状态不明处理。

同一分段回复中，某段失败或结果不明时，丢弃尚未发送的后续段，其他消息继续处理。iLink 层仅对已知未接受的网络请求保留有限重试。平台 `client_id` 去重尚未实机证明，不承诺 exactly-once。

存储打开时自动清理旧失败记录。重启时删除中断的 `sending` 及遗留的失败、`uncertain`、`control-pending` 记录，仅保留去重 ID。清理不改变绑定、游标和会话。收件队列最多 1,000 条，不适合高吞吐或多租户服务。

状态位于 `$DSH_HOME/storages/dsh-wechat/PROFILE/`，默认使用用户主目录下的 `.dsh`。活动记录仍可能包含正文、上下文、媒体描述和任务关联，属于敏感数据。新增 POSIX 目录使用 0700，文件使用 0600。登录 token 保存在 DSH credentials，管理接口不返回 token。

先在 Web 对应会话核对不确定任务，避免手动重发已执行的操作。丢弃的正文不能从插件恢复。v0.4.0 不再提供离线恢复脚本 `scripts/recover.mjs`。

“停止”仅停止桥接轮询与等待，不取消已提交的 DSH 任务。取消任务请用 `/stop` 或 Web。“退出登录”清除插件凭据、绑定和队列，保留 DSH 会话日志。不要删除存活进程的存储锁。

## Upgrade, development, and scope

For a local clone, stop Harness, `git pull --ff-only`, then restart. For a GitHub package, update/reinstall through plugin management and restart. Uninstall with `dsh plugin --profile web remove @satanfire/dsh-wechat`; unlinking the package does not erase credentials or local state. Log out before uninstalling to clear them.

```sh
npm ci --ignore-scripts
npm run build:vendor
npm run check
npm test
npm run check:package
```

These commands check the code, run tests, and validate package contents. Tests do not send WeChat messages. See [CONTRIBUTING.md](CONTRIBUTING.md) for development guidance.

See [CONTRIBUTING.md](CONTRIBUTING.md), [SECURITY.md](SECURITY.md), and [NOTICE.md](NOTICE.md). Do not attach tokens, QR codes, context tokens, local state, or private chats to Issues.
