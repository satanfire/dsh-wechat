# DSH WeChat

[English](README.en.md) · [MIT License](LICENSE)

为 **DeepSeek Harness Web** 接入微信的单用户插件。使用微信 iLink Bot 接口，扫码绑定后，可以在微信发送任务、接收最终回复、处理可核实的工具审批和追问，也可以让其他 DSH 会话把完成通知发到你的微信。

这是社区插件，与腾讯和 DeepSeek 无隶属关系；微信平台是否向你的账号开放扫码机器人能力，以平台实际返回为准。

## 环境要求

- 已安装并配置模型的 DSH Web，兼容声明目前限定为 **`@deepseek-ai/dsh 0.2.0-rc.2`**。
- Node.js **22 或更新版本**；本地开发和测试需要 npm。
- 运行 DSH 的设备需要能够访问微信 iLink 和媒体 CDN。
- 一个 profile 绑定一个微信机器人，只接收绑定者本人的消息。

支持 macOS 和 Linux。Windows 暂未验证。请勿让多个微信桥接程序同时使用同一个机器人账号。

## 安装

推荐从此仓库克隆并安装本地包：

```sh
git clone https://github.com/satanfire/dsh-wechat.git
cd dsh-wechat
dsh plugin --profile web add "$PWD"
```

也可以在 DSH 的插件管理页“添加插件”中输入克隆目录的**绝对路径**。二维码依赖已预先打包在插件内，安装时无需额外下载运行时依赖、构建或运行安装脚本。安装后重启已有 DSH Web 进程，再刷新浏览器。

支持 GitHub 包来源的安装器也可使用：

```sh
dsh plugin --profile web add github:satanfire/dsh-wechat
```

目前请通过 GitHub 或本地目录安装，尚未发布到 npm。

## 扫码与使用

1. 打开设置 → **微信**，点击“扫码连接”。
2. 用微信扫描二维码并确认绑定。
3. 绑定后点击“启动”，给机器人发送一条普通文字。
4. 插件创建独立 DSH 会话；会话 ID 可在设置页查看，也能在网页版打开。

设置页可查看连接、运行状态、当前会话和发件状态。处理任务时，微信会显示“正在输入”，完成后收到最终回复。

| 微信文字命令 | 作用 |
| --- | --- |
| `/new` | 创建并切换到新会话 |
| `/status` | 检查微信连接 |
| `/stop` | 请求停止当前 DSH 任务 |
| `/help` | 查看命令 |
| `/approve <请求码>` | 仅批准当前一次工具操作 |
| `/reject <请求码>` | 拒绝操作 |
| `/answer <请求码> <回答>` | 回复追问，选项用序号，多选用逗号分隔 |

控制命令必须是文字消息。数字原文答案使用 `text:` 前缀。请求码最长 5 分钟有效，重启后不能复用。

审批会核对持久日志中的微信请求和工具调用，并显示实际工具参数。取不到参数、参数超过 500 字符，或无法核实轮次归属时交给网页版处理；不要只因看到理由而批准未知操作。微信与网页混合在同一轮时，插件会拒绝归属不明的媒体发送和手机交互。

## 附件与通知

- 接收文字、带识别文本的语音、图片、文件、视频。插件自身不做语音识别。
- 图片支持 PNG/JPEG/WebP/GIF，单张最多 12 MiB，并受 DSH 图像策略限制。
- 文件/视频单个及每条消息附件总量最多 50 MiB，每条最多 8 个附件。视频作为文件传入，不承诺模型直接理解视频帧。
- 微信任务可调用 `wechat_send_media({path,kind})` 回传当前工作区文件。`kind` 为 `image`、`file` 或 `video`；视频发送采用文件附件，不是原生视频卡片。工具执行核对微信轮次和工具调用，外部路径及越界符号链接被拒绝。
- 在任意 DSH 会话告诉 Agent“完成后通知我的微信”。Agent 按需调用 `load_wechat_tools({})`，随后使用该会话的 `wechat_send_text({text})`。单条 1–800 个 Unicode 字符，收件人固定为绑定者。
- `queued` 只表示已落盘，`sent` 表示微信服务接受，不代表手机已读。`failed` 为明确失败，`uncertain` 为发送结果无法确认。

推送使用绑定者最近一次消息的上下文。缺失或过期时，请先在手机给机器人发消息；不承诺无限期离线主动推送。微信不渲染 Markdown 标题/加粗/表格，通知宜用短标题、空行、短段落和 `•` 列表。

## 配置

默认新会话使用 **DSH 进程启动目录** 和 `standard` Agent Preset。已有会话继续使用自身目录。可在当前 profile 的用户 patch 中覆盖已有 `dsh-wechat` 行：

```yaml
- id: dsh-wechat
  config:
    cwd: /absolute/path/to/your/workspace
    agentPreset: standard
```

`cwd` 必须是 Host 上的现有绝对目录；Windows 使用该系统的绝对路径。`agentPreset` 必须是 Host 中可用的 preset ID。`config` 被整体替换，请一次写全需要的字段。修改后重启 DSH Web。请勿把个人路径和凭据提交到本仓库。

## 可靠性与本地数据

- 收件批次和平台游标原子保存；重复的微信消息 ID 不会再次提交。
- 重启后通过稳定请求 ID 对照 DSH 会话日志；已提交任务恢复观察，不重复提交。等待观察超时会继续等待，保留任务记录。
- 提交前失败、提交结果不明或混合轮次无法归属的任务保留本地恢复记录，不自动重放。后续新消息仍可处理。无效附件会得到提示。
- 网络错误、超时、HTTP 5xx 或格式不明的发送结果立即标记为 `uncertain`，**不再自动重发**。仅明确未接受的可重试错误使用有限重试。分段回复的某一段明确失败时取消尚未发送的后续段，避免只收到不完整后半段。平台 `client_id` 去重尚未实机证明，本插件不承诺 exactly-once。
- 单个收件队列最多 1,000 条。失败记录仍占容量；去重 ID 随使用增长。这是个人使用的 JSON 存储，不适合高吞吐或多租户服务。

状态位于 `$DSH_HOME/storages/dsh-wechat/<profile>/`；未设置 `DSH_HOME` 时使用用户主目录下 `.dsh`。状态包含消息正文、任务关联、收件上下文和媒体描述，属于敏感数据；新增目录使用 POSIX 0700、文件使用 0600，其他系统由 OS 权限保护。登录 token 存在 DSH credentials，API 不返回 token。

**“停止”仅停止桥接网络与等待，不等于取消已提交的 DSH 任务。** 停止任务请使用 `/stop` 或网页版。“退出登录”会删除本插件凭据与本地队列/绑定，保留 DSH 会话日志。

## 故障恢复

不确定任务先在网页版对应会话核对结果，避免手动重发已执行的操作。要检查本地记录，先退出使用该 profile 的 DSH 进程（仅在设置页停止桥接不会释放存储锁），然后使用仓库里的离线管理脚本：

```sh
node scripts/recover.mjs --profile web list
node scripts/recover.mjs --profile web retry MESSAGE_ID
node scripts/recover.mjs --profile web discard MESSAGE_ID
node scripts/recover.mjs --profile web hold MESSAGE_ID
```

`list` 输出 ID、状态和关联会话，不输出正文、上下文或 token。`retry` 只允许已确认在准备/建会话阶段失败的入站记录；`needs-review` 不允许直接重试。`discard` 仅清除指定失败入站记录、保留去重 ID，不取消 DSH 任务。若已提交任务长期不结束，`hold` 可在确认后把它标为待核查，重启时不再阻塞后续队列；它不取消 DSH 任务，之后也不再自动转发该任务回复。发件结果不明不提供重发捷径，请先核对手机。

存储锁保护同一 profile 的队列。仅操作系统确认旧进程已退出时自动回收，无法验证时拒绝启动。不要删除存活进程的锁。无效锁或遗留恢复锁需要先确认所有相关进程已退出，再人工处理。

## 升级与卸载

本地来源更新：停止该 profile 的 DSH，进入克隆目录执行 `git pull --ff-only`，再重新启动。切换 GitHub 包版本时，通过插件管理器更新/重新安装，然后重启；单纯刷新浏览器不会替换 Host 模块。

卸载使用插件管理页，或：

```sh
dsh plugin --profile web remove @satanfire/dsh-wechat
```

卸载本身不删除本地状态和凭据。若要解绑并清空数据，请先在微信设置中退出登录。

## 开发与验证

```sh
npm ci --ignore-scripts
npm run build:vendor
npm run check
npm test
npm run check:package
```

上述命令检查代码、运行测试并验证安装包内容。测试不会向微信发送消息。开发和贡献说明见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 安全、贡献与许可

安全问题请按 [SECURITY.md](SECURITY.md) 报告。普通问题可提交 Issue，提供版本、复现步骤和脱敏日志，不提交二维码、token、context token、登录文件或私人对话。

欢迎小范围 PR；请先阅读 [CONTRIBUTING.md](CONTRIBUTING.md)。项目采用 MIT，协议参考及依赖归属见 [NOTICE.md](NOTICE.md)。
