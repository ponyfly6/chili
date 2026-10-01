# Chili 辣椒🌶️

> 一个以终端为先、真正面向代码库工作的 coding agent。

🚧 **开发中**  
这是一个实验性项目。API、行为和架构都可能频繁变化。

---

## 这是什么？

**Chili** 是一个本地运行的 coding agent runtime 和 CLI。

它主要关注：

- 仓库探索
- 结构化工具调用
- 文件编辑和 patch 应用
- shell 命令执行
- 权限审批和恢复流程
- 可恢复的 coding session

产品方向是一个终端优先、面向真实代码库执行的本地 coding agent。

---

## 为什么叫 Chili？

Chili 是“辣椒🌶️”。

这个名字来自九紫离火的意象：火代表行动、速度和持续燃烧的能量。这个项目希望做的不是只会给建议的聊天工具，而是一个能进入代码库、调用工具、推进任务、把事情做热起来的 coding agent。

“辣椒”也有一点直接、醒神、不拖泥带水的意思。它适合一个终端里的 agent：反应快，能执行，敢推进，同时保持本地、可控、可恢复。

---

## 使用

运行 CLI：

```bash
bun run chili -- "总结这个仓库"
```

自动批准工具权限：

```bash
bun run chili -- --yes "读取 package.json"
```

查看 session：

```bash
bun run chili -- sessions
```

恢复 session：

```bash
bun run chili -- --resume <session-id> "继续"
```

### 桌面控制端

CLI 和 Electron 桌面端通过 [`@chili/host`](packages/host/README.md) 装配同一套运行能力，TUI 通过 HTTP/SSE 接入。桌面通过受限 preload bridge 控制本地 Bun sidecar；renderer 不接触 Node、sidecar URL 或 bearer token。当前统一的是公共业务装配，跨进程发现和连接同一个 Host 实例仍在迁移中。

开发运行：

```bash
bun run desktop
```

构建、生成 macOS `.app` 目录并执行完整打包烟测：

```bash
bun run desktop:build
bun run desktop:package:dir
bun run smoke:desktop
```

需要保留一个可与旧版同时运行的本地试用包时，在已提交、干净的 checkout 执行 `bun run desktop:preview`。它在 `~/Downloads/Chili Previews/` 新建带 Git 版本的独立目录，保留 `Chili Preview.app` 与校验清单。Preview 使用独立桌面配置目录，窗口显示构建版本；此命令不会自动启动应用。详情见 [Preview 打包说明](apps/desktop/README.md#本地-preview)。

桌面端支持选择工作区、创建/恢复 session、实时 timeline、Queue/Steer/Stop、agent tree、tasks、审批、用户输入和 turn/workspace diff。详细运行说明与安全边界见 [apps/desktop/README.md](apps/desktop/README.md)，架构说明见 [docs/desktop-architecture.md](docs/desktop-architecture.md)。

私网手机 Alpha 使用独立的 `apps/control-web` 页面，通过受信任的私网 HTTPS、HostBridge 和桌面窗口共用的 `DesktopControlService` 操作真实 sidecar/runtime。远控默认关闭；在桌面开启后，手机使用短期一次性配对码申请授权，再由桌面本地确认。手机仅能查看当前工作区已有的顶层任务及有限消息，并执行 Queue、Steer、Stop；任务创建、工作区选择、审批、用户输入答复和权限设置仍在桌面完成。关闭远控、撤销设备、切换工作区或重启桌面会使对应授权失效。

在桌面 Phone 面板选择本机私网地址和端口，再通过原生对话框选择证书及私钥；保存后单独开启，无需启动环境变量。配置会保留，启用状态与手机授权不会保留。网络与证书配置、浏览器自动化入口和五分钟手机检查清单见 [私网手机 Alpha 验收指南](docs/private-mobile-alpha-acceptance.md)。当前已有真实浏览器到桌面/runtime 的自动化验证，**iPhone / Android 真机验收尚未执行**。此 Alpha 不包含公网 relay、账号、原生手机 App 或后台 daemon。

运行时会话现在只使用 `session-id` 标识；旧的 `--thread` 参数不再支持。`--resume` 只接受已存在且活跃的交互式 session，子代理 session 请通过 `task_followup` 继续。多代理任务仍以 `task-id` 作为用户可见标识，每个子代理对应唯一的 child session，后续消息会复用同一个 `task-id` 和 child session。邮箱工具输出中的接收方字段已从 `child_session_id` / `childSessionId` 更名为 `recipient_session_id` / `recipientSessionId`。

身份职责保持正交：`SessionId` 标识可恢复的对话上下文，`TaskId` 标识逻辑代理任务，`AgentRunId` 标识该任务的一次执行尝试，`TurnId` 只标识一次模型轮次。Follow-up 会复用 `TaskId + SessionId`，同时创建新的 `AgentRunId` 并递增 generation。

使用 fake model 做本地 smoke test：

```bash
bun run chili -- --model fake "read package"
```

查看 prompt 分层和当前注入的上下文：

```bash
bun run chili -- prompt-debug --cwd .
bun run chili -- prompt-debug --cwd . --text 'use $reviewer' --content
```

Skills 可以用 `$skill` 显式激活，也可以在 CLI/TUI 中启用或禁用：

```bash
bun run chili -- skills
bun run chili -- skills disable reviewer
bun run chili -- skills enable --user reviewer
```

TUI 中执行 `/skills` 会打开 `$` skill picker，`/skills enable|disable <name>` 会更新 skill 配置。

默认模型是 `minimax`。它会加载自研 `@chili/providers` 里的 MiniMax router：

```bash
MINIMAX_API_KEY=... bun run chili -- "总结这个仓库"
```

MiniMax 配置优先使用这些环境变量：

```bash
MINIMAX_API_KEY=...
MINIMAX_BASE_URL=https://api.minimaxi.com/anthropic
MINIMAX_MODEL=MiniMax-M3
```

也兼容旧的 `ANTHROPIC_API_KEY`、`ANTHROPIC_BASE_URL`、`ANTHROPIC_MODEL` 命名。当前只在目录中提供最新的 `MiniMax-M3`：1M context、524,288 最大输出；CLI 默认申请 131,072 输出 token。`--thinking off|high` 对应 disabled/adaptive thinking，`--service-tier fast` 对应 priority tier。

DeepSeek V4 使用 OpenAI-compatible 接入：

```bash
DEEPSEEK_API_KEY=... bun run chili -- --model deepseek "总结这个仓库"
```

DeepSeek 配置优先使用这些环境变量：

```bash
DEEPSEEK_API_KEY=
DEEPSEEK_BASE_URL=https://api.deepseek.com
DEEPSEEK_MODEL=deepseek-v4-pro
```

可选模型为当前 V4 系列的 `deepseek-v4-pro` 和 `deepseek-v4-flash`。两者均为 1,048,576 context、384,000 最大输出，支持 `off|low|high|max` reasoning；兼容输入的 `medium|xhigh` 会映射到 `high`。官方 Anthropic 格式端点为 `https://api.deepseek.com/anthropic`，当前 CLI 默认使用 OpenAI 格式端点。

Kimi 使用月之暗面 OpenAI-compatible 接入，默认模型为当前官方推荐的 `kimi-k3`：

```bash
MOONSHOT_API_KEY=... bun run chili -- --model kimi "总结这个仓库"
```

Kimi 配置优先使用这些环境变量：

```bash
MOONSHOT_API_KEY=
MOONSHOT_BASE_URL=https://api.moonshot.cn/v1
MOONSHOT_MODEL=kimi-k3
```

也兼容 `KIMI_API_KEY`、`KIMI_BASE_URL`、`KIMI_MODEL` 命名。K3 为固定 thinking 模型，支持 `low|high|max` effort，1,048,576 context；CLI 使用 `max_completion_tokens=131072` 作为请求默认值。

Z.ai 默认使用最新 `glm-5.3`：

```bash
ZAI_API_KEY=... bun run chili -- --model zai "总结这个仓库"
```

```bash
ZAI_API_KEY=
ZAI_BASE_URL=https://api.z.ai/api/paas/v4
ZAI_MODEL=glm-5.3
```

GLM-5.3 为固定 thinking 模型，支持 `low|high|max` effort，1M context、131,072 最大输出。目录同时保留官方 Coding Plan Anthropic 协议名 `glm-5.3[1m]`；它是同一代模型的协议 alias，不是旧模型。

xAI 使用 OpenAI-compatible Chat Completions，默认模型为 `grok-4.6`：

```bash
XAI_API_KEY=... bun run chili -- --model grok "总结这个仓库"
```

```bash
XAI_API_KEY=
XAI_BASE_URL=https://api.x.ai/v1
XAI_MODEL=grok-4.6
```

`grok`、`xai` 和 `x.ai` 都可作为 provider alias。Grok 4.6 支持 text/image、500k context 与 `low|medium|high|xhigh` reasoning；reasoning 不能关闭。Chat Completions 未显式设置时使用 128,000 的可见输出默认值。

Codex 有两条独立的连接，通过 provider 明确区分：

- `openai-codex`：使用 ChatGPT 订阅的 OAuth 凭据，只连接 ChatGPT Codex 后端。
- `codex-api`：使用 API key 和自定义 base URL，连接第三方 OpenAI Responses-compatible API。

两者不会互相回退或混用凭据。ChatGPT OAuth token 不会发往 `codex-api` 的自定义 endpoint，第三方 API key 也不会被 `openai-codex` 使用。

### ChatGPT OAuth (`openai-codex`)

ChatGPT 订阅里的 Codex 可以通过 TUI 斜杠命令登录：

```bash
bun run chili -- serve --provider openai-codex --model gpt-5.6-sol
bun run tui
```

在 TUI 里执行 `/auth login`，浏览器完成 ChatGPT 登录后，Chili 会把 OAuth 凭据保存到 `~/.chili/auth.json`。这个文件包含 access/refresh token，应按密码处理。`openai-codex` 的默认模型为 `gpt-5.6-sol`：

```bash
bun run chili -- --model openai-codex/gpt-5.6-sol "总结这个仓库"
```

GPT 目录只保留 5.6 系列：`gpt-5.6-sol`、`gpt-5.6-terra`、`gpt-5.6-luna`；官方 alias `gpt-5.6` 会规范化为 `gpt-5.6-sol`。三者均为 1,050,000 context、128,000 最大输出。`off` 会发送 `reasoning.effort=none`，并支持 GPT-5.6 的 `pro` mode 与 persisted-reasoning context 参数。

也可以用 `/auth` 查看 OAuth 状态，或用 `/logout` 删除本地 ChatGPT Codex 凭据。`openai-codex` 是 OAuth-only provider，不从 API key 或自定义 base URL 取凭据。

### 第三方 Responses API (`codex-api`)

第三方 Responses-compatible 网关使用专用的 `CODEX_API_*` 环境变量：

```bash
CODEX_API_KEY=...
CODEX_API_BASE_URL=https://gateway.example/v1
CODEX_API_MODEL=gpt-5.6-sol
```

选择该 provider 时，Chili 才会使用这组 API 配置：

```bash
bun run chili -- --model codex-api/gpt-5.6-sol "总结这个仓库"
```

为了平滑迁移，以下旧变量仍作为 `codex-api` 的兼容别名：

```text
OPENAI_CODEX_ACCESS_TOKEN -> CODEX_API_KEY
OPENAI_CODEX_BASE_URL     -> CODEX_API_BASE_URL
OPENAI_CODEX_MODEL        -> CODEX_API_MODEL
```

新配置应优先使用 `CODEX_API_*`。这些旧变量只配置 `codex-api`，不会改变 `openai-codex` 的 OAuth 连接。

### 选择与检查连接

模型选择器用 `[ChatGPT]` 标记订阅 OAuth 连接，用 `[Api]` 标记第三方 API 连接；实际 provider ID 仍分别是 `openai-codex` 和 `codex-api`。

在 TUI 中可以显式切换两个 provider：

```text
/model openai-codex/gpt-5.6-sol
/model codex-api/gpt-5.6-sol
/status
```

`/status` 会同时显示当前 `model`、`connection`、`auth` 和脱敏后的 `endpoint`，可用来确认请求实际会走 ChatGPT OAuth 还是第三方 API。

---

## 开发

```bash
bun run typecheck
bun test
bun run smoke:all
bun run test:index
bun run scripts/probe-minimax.ts --mock
```

`bun run smoke:all` 是跨平台 CLI/runtime 的完整 fake-model smoke 入口，不需要 API key 或网络访问。Electron 的 macOS 打包与实机生命周期门禁独立运行 `bun run smoke:desktop`；发布或修改桌面代码时两者都必须通过。

`smoke:desktop` 在每轮独立临时目录中构建并清理桌面、sidecar 与手机页面，不覆盖共享 release，也只清理本轮启动的进程及其后代。隔离回归入口为 `bun test scripts/desktop-smoke-isolation.test.ts`。远程浏览器全链路使用 `bun run test:e2e:remote`，所需 Firefox、NSS `certutil` 与证书验证说明见上述 Alpha 验收指南。

局部开发验证可单独运行 `smoke`、`smoke:cli`、`smoke:p0p1`、`smoke:p2`、`smoke:p2-control`、`smoke:p3`、`smoke:p3-background`、`smoke:p3-team-model`、`smoke:p3-team-parallel` 或 `smoke:p3-multi-agent-lifecycle`。`smoke:p0` 是 `smoke` 的别名。`bun run smoke` 会在系统临时目录创建 fixture workspace，覆盖 CLI fake model 基础工具循环、`--resume`、runtime `read`/`glob`/`grep`/`edit`/`apply_patch`/`bash` 工具面，以及最小 context compaction 路径。通过的 fixture 会清理；失败的 fixture 会保留并打印路径。需要保留全部 fixture 时可设置 `CHILI_SMOKE_KEEP_WORKSPACE=1`。

`bun run test:index` 会输出当前 smoke 脚本和按 workspace 分组的 `*.test.ts` 清单，便于后续 worker 快速选择验证范围。

配置好真实 MiniMax key 后，可以运行 `bun run probe:minimax` 做端到端探针。

Prompt、memory/project context 和 skills 的维护说明见 [docs/prompt-skills.md](docs/prompt-skills.md)。

---

## 当前状态

- 早期开发中
- 还没有稳定公开 API
- Bun + TypeScript workspace
- 终端优先，本地优先

---

## 🥚 彩蛋

> 青椒记忆在线 🌶️  
> 祝你假期愉快 🎉

---

## License

Apache-2.0. See [LICENSE](LICENSE).
