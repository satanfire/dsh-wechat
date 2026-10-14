# DSH WeChat

[中文](README.md) · [MIT License](LICENSE)

A community, single-owner WeChat iLink Bot bridge for **DeepSeek Harness Web**. Scan a QR code, send tasks from WeChat, receive final replies, answer questions, review eligible tool approvals, and ask another DSH session to notify your bound WeChat. This project is not affiliated with Tencent or DeepSeek. Account eligibility depends on the platform.

## Requirements and installation

First public version: **0.3.0**. The declared supported Harness version is **`@deepseek-ai/dsh 0.2.0-rc.2`**, with its Web services and a configured model. Node.js **22+** is required. Local validation uses macOS; CI is configured for Ubuntu/macOS and Node 22/24. Windows and other Harness versions have not been accepted yet.

```sh
git clone https://github.com/satanfire/dsh-wechat.git
cd dsh-wechat
npm ci --ignore-scripts
dsh plugin --profile web add "$PWD"
```

Alternatively, enter the clone's absolute path in the Harness plugin manager, or use a GitHub source with a supporting installer:

```sh
dsh plugin --profile web add github:satanfire/dsh-wechat
```

The package loads source directly; no build or install lifecycle scripts are needed. Restart the existing Harness Web process and refresh its page. The package name is `@satanfire/dsh-wechat`; GitHub availability does not mean it has been published to npm.

Do not enable this package and the old `@local/dsh-wechat` together in the same profile: both use the same settings slot, route, credential namespace, and state directory. Disable the old bundle first. Do not run another bridge polling the same bot account.

## Connect and use

Open **Settings → WeChat**, select **Scan to connect**, confirm on your phone, then select **Start**. Send the bot a text message. The bridge creates a dedicated Harness session; its ID is visible in settings and its conversation can be opened in Web.

| Text command | Effect |
| --- | --- |
| `/new` | Create and bind a new session |
| `/status` | Check connection |
| `/stop` | Request cancellation of the current Harness task |
| `/help` | Show commands |
| `/approve CODE` | Allow this operation once |
| `/reject CODE` | Reject this operation |
| `/answer CODE ANSWER` | Answer a question; option numbers and comma-separated multi-select are supported |

Control commands must be literal text. Use `text:` for an answer that should remain a numeric string. Codes expire within five minutes and do not survive restart.

Phone approvals include the actual tool arguments and verify durable WeChat request/turn ownership. Missing or over-500-character arguments and unverified calls fall back to Web review. Mixed Web/WeChat turns cannot use request-scoped media sending or phone interactions. Settings omit inbound queue/review counters without a corresponding action UI.

## Attachments and notifications

- Text, voice with an existing transcript, images, files, and videos are accepted. The plugin does not transcribe audio.
- PNG/JPEG/WebP/GIF images: 12 MiB each, subject to Harness image policy.
- Files/videos: 50 MiB each and combined per message, at most eight attachments. Videos enter as files, not model video frames.
- `wechat_send_media({path,kind})` sends a workspace attachment from a verified WeChat turn. External paths and escaping symlinks are refused. Videos are delivered as file attachments.
- Ask any ordinary Harness session to notify your WeChat when done. It loads `load_wechat_tools({})`, then uses its scoped `wechat_send_text({text})`. Text is 1–800 Unicode characters; the recipient is always the bound owner.
- `queued` means persisted, `sent` means accepted by the provider, `failed` means definite failure, and `uncertain` means acceptance cannot be established. None means the phone user read it.

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

## Durability and recovery

Incoming batches and cursors commit atomically. Stable message/request IDs prevent duplicate admission. Restart reconciles dispatching work with the durable Harness log; submitted work resumes observation. Observation timeouts retain submitted work and continue waiting.

Preparation failures and ambiguous submissions retain recovery records. They are never automatically replayed. Ambiguous network errors, timeouts, HTTP 5xx, or invalid send responses stop delivery retries immediately; only known nonacceptance can receive bounded retries. Provider `client_id` deduplication has not been proven on real devices, so exactly-once delivery is not promised.

State lives under `$DSH_HOME/storages/dsh-wechat/PROFILE/`, defaulting to the user's `.dsh` directory. It includes messages, context tokens, media descriptors, and request linkage. New POSIX directories use 0700, state files use 0600. Login tokens are held by Harness credentials and never returned by the management route. The inbox is capped at 1,000 records; failed records count toward this limit, and dedup IDs grow over time. This is not a high-throughput or multi-tenant service.

For local recovery, first exit the Harness process using the profile; the Settings Stop button alone does not release its storage lock:

```sh
node scripts/recover.mjs --profile web list
node scripts/recover.mjs --profile web retry MESSAGE_ID
node scripts/recover.mjs --profile web discard MESSAGE_ID
node scripts/recover.mjs --profile web hold MESSAGE_ID
```

The offline script lists only IDs/status/session linkage. Retry is allowed only for known preparation/session-creation failures; uncertain submissions cannot be replayed. Discard removes a failed inbound record but preserves its dedup ID and does not cancel a Harness task. Review the Web session first. A verified stalled tracked request can be put on `hold` offline to free the queue after restart; this does not cancel the Harness task and stops automatic reply forwarding for it. Uncertain outbound messages have no resend shortcut.

Stop affects bridge polling and waiting, not admitted Harness tasks. Use `/stop` or Web cancellation for tasks. Log out clears bridge credentials/binding/queues but preserves Harness session history. Never delete a live process's storage lock.

## Upgrade, development, and scope

For a local clone, stop Harness, `git pull --ff-only`, run `npm ci --ignore-scripts`, then restart. For a GitHub package, update/reinstall through plugin management and restart. Uninstall with `dsh plugin --profile web remove @satanfire/dsh-wechat`; unlinking the package does not erase credentials or local state. Log out before uninstalling to clear them. Tasks already discarded by the older local 0.2.2 cannot be restored.

```sh
npm ci --ignore-scripts
npm run check
npm test
npm run check:package
```

Checks cover manifest/lockfile/client identity, syntax, recovery, deduplication, ownership, approval details, attachment bounds, and a real packed tarball. Tests use mocked network and temporary stores. Real QR login, long-lived context, media interoperability, provider deduplication, and other operating systems still require manual acceptance. See [verification](docs/verification.md). GitHub pushes do not publish npm automatically.

See [CONTRIBUTING.md](CONTRIBUTING.md), [SECURITY.md](SECURITY.md), and [NOTICE.md](NOTICE.md). Do not attach tokens, QR codes, context tokens, local state, or private chats to Issues.
