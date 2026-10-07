# Chili Desktop

Chili Desktop 是本地优先的 Electron 控制端，通过可替换 transport 驱动 React renderer，复用 protocol、core、server、store、SDK、tools，以及基于 Session 和持久输入队列的 Agent runtime。

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

使用本机已有 MiniMax 配置试用新版界面：

```bash
CHILI_DESKTOP_WORKSPACE="$PWD" CHILI_DESKTOP_MODEL=minimax bun run desktop
```

常用验证命令：

```bash
bun run --cwd apps/desktop typecheck
bun test apps/desktop/src
bun run desktop:build
bun run test:e2e:desktop
bun run desktop:package:dir
bun run smoke:desktop
```

`test:e2e:desktop` 仅支持 macOS；它会先构建真实 Electron 应用和 sidecar，再点击完成 New Task、审批、输入、Steer、Stop、恢复、rename/search/archive、多项目后台运行、队列与草稿隔离、重启后项目恢复，并检查原生 1440/820/390 宽度。已经构建时可用 `CHILI_DESKTOP_E2E_SKIP_BUILD=1 bun run test:e2e:desktop` 跳过重复构建。

`smoke:desktop` 在每轮 `mkdtemp` 目录中独立构建 sidecar、桌面与手机页面，以及当前主机架构的 macOS `.app`，不读写共享 `apps/desktop/release`、`out` 或 `resources` 构建产物。它核验签名、完整 Electron 42 fuse wire、最小 ASAR 与其 header integrity，再实际启动应用内的 `Contents/Resources/chili-sidecar`。它会用同一个隔离 user-data 连续启动两次，通过 preload 创建 session、发送 fake-model 消息并等待 SSE assistant/idle 事件，并走原生 `app.quit()` 路径；两个正常启动都拒绝 forced stage、stderr、源码路径或秘密 canary 泄漏。blocked-Git fixture 通过仓库本地 `include.path` FIFO 阻塞 Git，并验证退出会中止 diff、清理登记的 Git process group。另有独立 fixture 会对 Electron 父进程发送 `SIGKILL`，验证 hard-crash containment。每个场景结束后都会检查 sidecar、登记的 Git/tool process group、继承子进程和 Electron helper 全部消失。

smoke 进程审计以本轮 `spawn` 返回的 PID、直接父进程和启动时间开始登记，再通过已观测父子链与进程组连续性追踪后代；每次发信号前重新核验。可执行文件和 user-data 路径只分类已经登记的进程，不会认领其它 Chili 实例。成功、失败和 `SIGINT`/`SIGTERM` 都清理本轮临时目录。`bun test scripts/desktop-smoke-isolation.test.ts` 用真实子进程验证同可执行文件哨兵不受影响、共享 release 的内容/权限/文件修改时间不变、父进程退出后独立子进程组可清理，以及并发两轮互不干扰。

本地检查用 DMG/ZIP：

```bash
bun run desktop:package
```

本轮最终验收与 `smoke:desktop` 产物固定使用完整 ad-hoc 签名，避免 fuses 修改后产生无效 bundle 签名。它是本地 MVP 验证物，**不可直接作为正式分发包**；当前配置明确拒绝 non-ad-hoc identity，未来独立的发布 pipeline 才会支持 Developer ID 签名与 notarization。正式 DMG/ZIP 发布与升级链路也明确不在本轮范围内。开发运行与本地 ad-hoc 包使用 Chromium mock Keychain，避免每次重签后触发 macOS Keychain ACL 对话；Chili 不在 Chromium storage 中保存 provider 密钥。未来使用稳定身份签名的发布包仍应使用系统 Keychain。

## 本地 Preview

在已提交的干净 checkout 执行：

```bash
bun run desktop:preview
```

默认在 `~/Downloads/Chili Previews/` 创建唯一版本目录，保留 `release/mac-arm64/Chili Preview.app`（Intel Mac 为 `release/mac/`）与 `build-manifest.json`。也可用 `bun run desktop:preview --output /absolute/parent-directory` 选择仓库外的父目录。清单记录完整 Git revision、构建时间、架构、相对应用位置及 executable/ASAR/sidecar 的 SHA-256。构建前后检查 Git revision 与源码状态；构建失败只清理本轮独有目录，成功不自动启动。

Preview 的应用标识为 `dev.chili.control.preview`，默认桌面配置目录为 `~/Library/Application Support/Chili Preview`，在获取单实例锁之前与普通 Chili 分开。窗口品牌区域显示 `Preview · <12 位 Git revision>`，用来确认打开的是哪次构建。它不会复制旧版的工作区选择与远控配置；首次打开需选择工作区。原有项目数据仍在所选工作区，provider 配置仍遵循 Chili runtime 的配置规则，Preview 并非独立复制的项目/runtime 数据库。需要隔离测试时选择专用工作区并设置专用 `CHILI_HOME`。

Preview 使用本地 ad-hoc 签名，不是已公证的正式发布包。打包器不会覆盖共享 `apps/desktop/release`、替换旧应用、修改系统信任或发布产物。

## 产品表面

- **设置 → 通用** 提供跟随系统 / 浅色 / 深色主题。默认跟随 macOS 外观并随系统切换即时更新；手动选择立即生效，由主进程保存到当前应用配置目录的 `appearance-settings.json`，跨任务、刷新和重启保留。启动时先恢复原生窗口外观，再渲染界面；主题独立于工作区与 TUI 配置。
- 左侧 **目录 +** 添加本地目录，侧边栏按项目展示任务及后台运行/待处理数量；点击项目或其任务切换。已打开项目各自保留 runtime，切换不会中断会话运行或消息队列。当前窗口内记住各项目选中的任务与未发送草稿。
- 每个目录可通过名称前的箭头独立收起，当前目录也可点击名称折叠。展开时默认显示最近 5 条会话，“展开更多会话”每次增加 5 条，“收起更多会话”恢复精简列表；正在查看的较早会话也会保留在这 5 条中。搜索涵盖整个目录，切换目录或新建会话会展开对应列表。
- 搜索 active/archived task，创建、重新载入或继续未归档 task，并对 active task 执行 rename/archive；具有 Agent 身份的子会话在 Agent 层级中展示，也不支持 unarchive。
- **设置** 按通用、模型与账号、权限与协作、工具与技能、偏好与记忆、手机连接分类；模型、思考深度与响应速度按模型能力展示，权限标明影响此目录的所有会话，协作方式属于当前会话。工具设置读取 MCP 状态并支持重新加载；不支持显式 tier 的模型使用 provider default，Desktop 不会提交伪造 tier。
- 在对话中实时查看消息、执行步骤、工具结果和审批。
- 发送消息；忙碌时 Queue，或 Steer（中断当前 turn 后优先发送）。
- Stop 当前 session。
- 汇总 root 与 descendant session 的 pending approvals，并允许 deny、allow once、allow session、always allow。
- 展示并提交 `request_user_input` 请求。
- 窗口失焦或后台项目发生审批、输入请求和 turn 完成时发原生通知，点击后切到对应项目并聚焦窗口。

## 新会话与高级任务

打开目录后可直接在输入区描述需求；**新会话** 或 `⌘ N` 创建空会话并聚焦输入，不显示向导。首次发送自动以需求的第一行命名。`Enter` 发送、`Shift + Enter` 换行，中文输入法确认候选词不会触发发送。忙碌时保留排队、调整方向和停止。

输入 `/` 或点击 **更多** 打开可搜索的命令菜单，支持方向键、Enter、Escape。`/settings`、`/model`、`/permissions`、`/mcp`、`/skills`、`/memory` 打开对应设置；`/review` 和 `/help` 填入待发送的需求。`⌘ ,` 随时打开设置。

所有回复直接显示在对话中，可以持续追问并查看历史消息。工作过程默认折叠；通用设置中的“默认展开工作过程”由主进程原子保存到客户端的 `reading-settings.json`。网页内嵌预览、点选页面元素修改及附件上传尚未接入，不显示模拟操作入口。

每次用户请求的多轮模型调用和工具执行合并为一条工作过程。执行中显示当前动作、操作数和耗时；展开后按连续的读取与搜索、文件修改、命令执行等操作分组，再查看思考记录、调用参数和输出。MiniMax 等未提供消息阶段的模型，其关联工具调用的中间文字归入过程，最终回答继续直接显示。手动展开的过程在完成后保持打开；历史失败保留在详情中，取消不计作失败，顶层仅在请求执行失败时突出提示。

模型账号继续使用已有本机配置；设置显示真实模型可用性，不在网页收集密钥。技能和目录说明通过明确标注的“在会话中查看”入口填入需求，不模拟连接或记忆管理。当前无独立的个人记忆库，目录偏好由已有 `AGENTS.md` 机制承载。

`/advanced` 按需打开高级任务对话框，一次配置标题、需求、model、模型能力允许的 reasoning/service tier、permission 和 delegation，配置完成后提交一次普通 prompt。没有公开 service tiers 的模型显示 provider default，并省略显式 tier。

创建结果区分 `not_started`、`started` 和 `unknown`。启动前失败会保留可恢复的 session，并在安全时回滚 permission；最终启动请求若可能已经提交但确认丢失，则返回 `unknown`，不擅自 archive session 或改变一个可能正在运行的 task。

Permission profile 是当前项目 runtime/sidecar 的**全局内存状态**，不是 session 配置：修改后会影响该项目中所有 task，不影响其他项目，Desktop 会串行化 New Task 与 permission 写入。它不写入 Desktop 持久化状态，runtime 重启后回到其配置默认值。

## Stop、Steer、恢复与 archive

- Stop 会中断当前 turn 并暂停持久化输入队列；待处理消息仍会保留。终止完成后点击 **继续处理** 恢复；仍在 cancelling/running 时会拒绝抢跑。
- Steer 会中断当前 turn，优先处理新输入，再处理已有排队消息；被替代的输入不会自动重新执行。
- 暂停后发送的新消息进入待处理队列。点击 **继续处理** 先恢复原来已中断的输入，再处理待处理消息，沿用原 Session 和 inputId。session、事件和输入队列由 runtime/store 持久化；Desktop 或 sidecar 重启后，未完成的执行保持暂停，需显式恢复。
- Archive 在当前 Desktop 中是单向操作：没有 unarchive；busy task 必须先 Stop。archived task 只读，不能 Resume、发送或改配置，其历史记录仍保留用于查看。

MCP 面板读取当前 session scope 的 server 状态与汇总，并提供 reload。Desktop 当前不暴露 add/remove/auth 配置流程；这些仍由现有 CLI/TUI/runtime 配置完成。

## 多项目与对话验收

`bun run test:e2e:desktop` 使用真实 Electron、编译后的 sidecar 与本地 fake model，覆盖主题持久化、多项目切换、持久输入恢复、审批/提问、任务操作，以及委派任务的对话结果、权限和模型设置、目录折叠和会话分页。

`bun run smoke:desktop-projects` 是独立的 macOS 多项目进程门禁：三个项目同时运行，反复切换、分别 Stop，并验证正常退出和强制终止 Electron 后的 sidecar、工具及 Git 进程回收。测试只管理本次启动并确认身份的进程，保留无关进程；成功或失败均留下性能与进程证据。CI 已构建当前源码时可设置 `CHILI_DESKTOP_PROJECTS_SKIP_BUILD=1`。

## 安全约束

- `sandbox=true`、`contextIsolation=true`、`nodeIntegration=false`；打包态关闭 DevTools。
- renderer 只看到冻结的 `window.chiliDesktop.invoke/subscribe` capability。preload 和 main 都做运行时 request/response/event 校验。
- main→renderer 使用私有 READY/ACK 握手、单调 sequence 和 count+完整 envelope UTF-8 byte 双预算。state/queue 可合并，只有 transient tool output 可丢弃；任何 durable 缺口都会保留唯一 resync barrier，renderer 在恢复 `app.state → sessions.list → 当前 snapshot` 前禁用动作。ACK capability 不暴露给网页。
- IPC 要求准确的 BrowserWindow、main frame 和 `chili://app`（开发时准确 Vite origin）。
- 打包态忽略 `ELECTRON_RENDERER_URL`，因此继承或注入的开发环境变量不能把受信 renderer 替换为远端页面。
- 生产 renderer 使用 secure custom scheme 和严格 CSP：无远程连接、无 object/frame/form/base。
- sidecar 只监听 `127.0.0.1:0`，每次启动生成 256-bit bearer token。URL/token 始终留在受信的 main/sidecar 边界，只存在于两端进程内存与两者间的私有继承管道；main 在独立继承的 fd 3 上发送受 128-byte/5-second 握手限制的版本化凭据帧，随后关闭管道并清零传输 buffer，sidecar 也在启动 harness/server 前严格校验帧并清零接收 buffer。token 不进入 child 环境、argv、stdout/log、renderer state 或持久化文件；fd 0 始终只承担 parent ownership，EOF 仍表示 parent loss。
- main 先做鉴权 health gate，再发布 ready；SSE 在 durable cursor 边界定期轮转并无损重连，sidecar 进程异常退出最多退避重启三次。
- 通用 runtime HTTP 在调用 `Bun.serve` 前拒绝不安全的非回环绑定：必须同时提供至少 32 UTF-8 bytes 的 bearer token 与显式非空 TLS cert/key；SDK 也拒绝把 bearer 发往非回环明文 HTTP。当前 CLI 没有远程 token/TLS 配置入口，因此 `serve --host 0.0.0.0` 保持 fail closed，不能直接发布为远程服务。
- Prompt Queue 有 per-session/global item 与累计 UTF-8 byte 预算；pending send/stop 有独立的 per-session/global 数量上限。普通 IPC admission 以及 main→renderer outbox 各有全局 item/UTF-8 byte 预算，Stop 使用独立保留通道。MCP Streamable HTTP、legacy SSE 和 stdio 都在 JSON parse 前执行 4 MiB 单消息/frame 限制；tool/MCP 错误在持久化、SQLite、SSE 与 IPC 前归一化为最多 16 KiB 的安全正文，不复制 stack、cause 或任意对象图。
- 第一方 `write`、`edit`、`apply_patch` 拒绝根级 `.git/**`、`.chili/**` 及其 symlink/gitdir target；模型可达 Bash 还由 macOS Seatbelt 的 metadata 与 hard-link 检查保护。内部受信的 `.chili/tool-results` 存储保持独立 capability。
- Electron 42 的 `before-quit` 由 `DeferredElectronQuit` 同步拦截一次。退出会关闭新控制请求与 Git admission、中止进行中的 diff，并行收口所有已打开项目的 sidecar 及各自 main-owned detached Git process group；Git 使用 `SIGTERM`→`SIGKILL`，所有进程组都必须确认消失。sidecar 正常退出由 main 发送显式 ASCII shutdown frame，stdin EOF 永远表示 parent loss；ownership EOF 与 parent PID 检查为 Electron hard-kill 提供双重兜底。完成 containment 后用 `process.reallyExit` 物理退出，缺失时仅对 Electron main 的准确 PID 发送 `SIGKILL`；12 秒 outer watchdog/forced stage 只处理无法有界收口的异常。
- POSIX 工作区 Git 由独立 supervisor 持有进程组，专用父进程管道关闭时会清理整组，覆盖 Electron 被强制终止的情形。打包态复用 sidecar 的独立 helper 入口，不初始化模型、凭据或 HTTP server；Git 的二进制输入输出与所有权管道分开。
- 锁屏可见的 approval 与 user-input 原生通知只显示固定泛化文案，不包含问题、路径、命令 pattern、token 或其他运行时详情。
- Electron fuses 禁止 RunAsNode、Node options、CLI inspect 和 file-protocol extra privileges，只允许从带完整性校验的 ASAR 加载应用。

`desktop-state.json` 以 0600 权限原子保存项目 ID、规范化目录路径及当前项目；旧版单工作区配置自动迁移。重启后恢复项目列表，仅启动当前项目，其他项目在首次点击时启动并加载历史任务。未发送草稿只保存在当前进程内，已接受的输入队列由 runtime/store 持久化。`appearance-settings.json` 和 `reading-settings.json` 分别以 0600 权限保存主题及阅读偏好。单独的 `remote-control-settings.json` 以 0600 权限保存本机绑定地址、端口及用户通过原生对话框选择的 TLS 文件引用；不复制证书或私钥内容。provider key、OAuth token、sidecar token、手机授权及启用状态均不写入这些文件。

更完整的模块与 transport 设计见 [../../docs/desktop-architecture.md](../../docs/desktop-architecture.md)。

## 私网手机控制 Alpha

通过 **设置 → 手机连接** 开启配有可信 TLS 的私网端点，生成短期一次性配对码并在本地确认设备。手机只控制当前工作区的既有顶层任务（列表、有限消息、Queue / Steer / Stop），与桌面窗口共享同一个 `DesktopControlService`。远控默认关闭；关闭、切换工作区或重启会使旧授权失效。手机刷新需重新配对，审批与提问只能回桌面处理。

Phone 面板可选择本机私网地址与端口，依次在原生文件对话框选择证书和私钥并保存。保存不会开启监听；每次开启都重新检查地址仍可用、证书 SAN/有效期及密钥匹配。证书路径和 PEM 留在主进程，不跨越 renderer IPC。修改配置前须关闭远控；取消文件选择保留旧配置。完整的既有 `CHILI_REMOTE_*` 启动环境仍优先且在面板只读，部分环境配置会报错，不与保存值混用。

证书与私网准备、环境启动兼容方式、3–5 分钟真机清单及测试边界见 [手机 Alpha 验收指南](../../docs/private-mobile-alpha-acceptance.md)。远程真实浏览器门禁：`bun run test:e2e:remote`。它不会修改系统信任、VPN 或防火墙；窄屏浏览器测试不等于 iPhone/Android 真机验收。
