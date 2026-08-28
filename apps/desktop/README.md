# Chili Desktop

Chili Desktop 是本地优先的 Electron 控制端。它不是把 TUI 放进窗口，而是通过可替换 transport 驱动 React renderer，同时复用现有 protocol、core、server、store、SDK、tools、team 和 session runtime。

## 开发运行

先在仓库根目录安装依赖：

```bash
bun install
bun run desktop
```

`electron-vite` 会启动 renderer dev server；Electron main 随所选工作区启动 Bun sidecar。首次进入应用后选择项目并创建 session。也可以用环境变量直接指定开发工作区和 fake model：

```bash
CHILI_DESKTOP_WORKSPACE="$PWD" CHILI_DESKTOP_MODEL=fake bun run desktop
```

常用验证命令：

```bash
bun run --cwd apps/desktop typecheck
bun test apps/desktop/src
bun run desktop:build
bun run desktop:package:dir
bun run smoke:desktop
```

`smoke:desktop` 会删除旧 release 输出并重新生成当前主机架构的 macOS `.app`，核验签名、完整 Electron 42 fuse wire、最小 ASAR 与其 header integrity，再实际启动应用内的 `Contents/Resources/chili-sidecar`。它会用同一个隔离 user-data 连续启动两次，通过 preload 创建 session、发送 fake-model 消息并等待 SSE assistant/idle 事件，并走原生 `app.quit()` 路径；两个正常启动都拒绝 forced stage、stderr、源码路径或秘密 canary 泄漏。blocked-Git fixture 通过仓库本地 `include.path` FIFO 阻塞 Git，并验证退出会中止 diff、清理登记的 Git process group。另有独立 fixture 会对 Electron 父进程发送 `SIGKILL`，验证 hard-crash containment。每个场景结束后都会检查 sidecar、登记的 Git/tool process group、继承子进程和 Electron helper 全部消失。

本地检查用 DMG/ZIP：

```bash
bun run desktop:package
```

本轮最终验收与 `smoke:desktop` 产物固定使用完整 ad-hoc 签名，避免 fuses 修改后产生无效 bundle 签名。它是本地 MVP 验证物，**不可直接作为正式分发包**；当前配置明确拒绝 non-ad-hoc identity，未来独立的发布 pipeline 才会支持 Developer ID 签名与 notarization。正式 DMG/ZIP 发布与升级链路也明确不在本轮范围内。开发运行与本地 ad-hoc 包使用 Chromium mock Keychain，避免每次重签后触发 macOS Keychain ACL 对话；Chili 不在 Chromium storage 中保存 provider 密钥。未来使用稳定身份签名的发布包仍应使用系统 Keychain。

## 产品表面

- 选择或切换本地工作区。
- 列出、创建和恢复 session。
- 实时查看消息、工具和审批，并在 inspector 中查看 agent/task 状态。
- 发送消息；忙碌时 Queue，或 Steer（中断当前 turn 后优先发送）。
- Stop 当前 session。
- 汇总 root 与 descendant session 的 pending approvals，并允许 deny、allow once、allow session、always allow。
- 展示并提交 `request_user_input` 请求。
- 查看 agent tree、tasks、当前 turn diff 和 workspace diff。
- 窗口失焦时对审批、输入请求和 turn 完成发原生通知，点击后恢复并聚焦窗口。

## 安全约束

- `sandbox=true`、`contextIsolation=true`、`nodeIntegration=false`；打包态关闭 DevTools。
- renderer 只看到冻结的 `window.chiliDesktop.invoke/subscribe` capability。preload 和 main 都做运行时 request/response/event 校验。
- main→renderer 使用私有 READY/ACK 握手、单调 sequence 和 count+完整 envelope UTF-8 byte 双预算。state/queue 可合并，只有 transient tool output 可丢弃；任何 durable 缺口都会保留唯一 resync barrier，renderer 在恢复 `app.state → sessions.list → 当前 snapshot` 前禁用动作。ACK capability 不暴露给网页。
- IPC 要求准确的 BrowserWindow、main frame 和 `chili://app`（开发时准确 Vite origin）。
- 打包态忽略 `ELECTRON_RENDERER_URL`，因此继承或注入的开发环境变量不能把受信 renderer 替换为远端页面。
- 生产 renderer 使用 secure custom scheme 和严格 CSP：无远程连接、无 object/frame/form/base。
- sidecar 只监听 `127.0.0.1:0`，每次启动生成 256-bit bearer token。URL/token 始终留在受信的 main/sidecar 边界，只存在于两端进程内存与两者间的私有继承管道；main 在独立继承的 fd 3 上发送受 128-byte/5-second 握手限制的版本化凭据帧，随后关闭管道并清零传输 buffer，sidecar 也在启动 harness/server 前严格校验帧并清零接收 buffer。token 不进入 child 环境、argv、stdout/log、renderer state 或持久化文件；fd 0 始终只承担 parent ownership，EOF 仍表示 parent loss。
- main 先做鉴权 health gate，再发布 ready；SSE 在 durable cursor 边界定期轮转并无损重连，sidecar 进程异常退出最多退避重启三次。
- Prompt Queue 有 per-session/global item 与累计 UTF-8 byte 预算；pending send/stop 有独立的 per-session/global 数量上限。普通 IPC admission 以及 main→renderer outbox 各有全局 item/UTF-8 byte 预算，Stop 使用独立保留通道。MCP Streamable HTTP、legacy SSE 和 stdio 都在 JSON parse 前执行 4 MiB 单消息/frame 限制；tool/MCP 错误在持久化、SQLite、SSE 与 IPC 前归一化为最多 16 KiB 的安全正文，不复制 stack、cause 或任意对象图。
- 第一方 `write`、`edit`、`apply_patch` 拒绝根级 `.git/**`、`.chili/**` 及其 symlink/gitdir target；模型可达 Bash 还由 macOS Seatbelt 的 metadata 与 hard-link 检查保护。内部受信的 `.chili/tool-results` 存储保持独立 capability。
- Electron 42 的 `before-quit` 由 `DeferredElectronQuit` 同步拦截一次。退出会关闭新控制请求与 Git admission、中止进行中的 diff，并行收口 sidecar 及 main-owned detached Git process group；Git 使用 `SIGTERM`→`SIGKILL`，所有进程组都必须确认消失。sidecar 正常退出由 main 发送显式 ASCII shutdown frame，stdin EOF 永远表示 parent loss；ownership EOF 与 parent PID 检查为 Electron hard-kill 提供双重兜底。完成 containment 后用 `process.reallyExit` 物理退出，缺失时仅对 Electron main 的准确 PID 发送 `SIGKILL`；12 秒 outer watchdog/forced stage 只处理无法有界收口的异常。
- 锁屏可见的 approval 与 user-input 原生通知只显示固定泛化文案，不包含问题、路径、命令 pattern、token 或其他运行时详情。
- Electron fuses 禁止 RunAsNode、Node options、CLI inspect 和 file-protocol extra privileges，只允许从带完整性校验的 ASAR 加载应用。

运行状态只持久化工作区路径。provider key、OAuth token、sidecar token 和 endpoint 都不会写入 desktop state。

更完整的模块与 transport 设计见 [../../docs/desktop-architecture.md](../../docs/desktop-architecture.md)。
