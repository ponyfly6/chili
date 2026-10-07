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

桌面端支持选择工作区、创建/恢复 session、实时 timeline、Queue/Steer/Stop、Agent 层级与输入回执、Agent 暂停/恢复、审批、用户输入和 turn/workspace diff。详细运行说明与安全边界见 [apps/desktop/README.md](apps/desktop/README.md)，架构说明见 [docs/desktop-architecture.md](docs/desktop-architecture.md)。

私网手机 Alpha 使用独立的 `apps/control-web` 页面，通过受信任的私网 HTTPS、HostBridge 和桌面窗口共用的 `DesktopControlService` 操作真实 sidecar/runtime。远控默认关闭；在桌面开启后，手机使用短期一次性配对码申请授权，再由桌面本地确认。手机仅能查看当前工作区已有的顶层任务及有限消息，并执行 Queue、Steer、Stop；任务创建、工作区选择、审批、用户输入答复和权限设置仍在桌面完成。关闭远控、撤销设备、切换工作区或重启桌面会使对应授权失效。

在桌面 Phone 面板选择本机私网地址和端口，再通过原生对话框选择证书及私钥；保存后单独开启，无需启动环境变量。配置会保留，启用状态与手机授权不会保留。网络与证书配置、浏览器自动化入口和五分钟手机检查清单见 [私网手机 Alpha 验收指南](docs/private-mobile-alpha-acceptance.md)。当前已有真实浏览器到桌面/runtime 的自动化验证，**iPhone / Android 真机验收尚未执行**。此 Alpha 不包含公网 relay、账号、原生手机 App 或后台 daemon。

运行时会话使用 `session-id` 标识；旧的 `--thread` 参数不再支持。`--resume` 只接受已存在且活跃的交互式 session。每个 Agent 的 `agentId` 就是其会话身份，`inputId` 标识提交给它的一次持久输入；消息、等待和恢复都沿用这套身份。

会话 ID 不包含目录或环境信息，关闭和恢复后保持不变。`--resume <session-id>` 只查当前工作区的 `.chili/chili.sqlite`，不存在就失败；cwd 和创建时的环境元数据独立保存，不因历史环境哈希不同而拒绝继续。工作区范围由启动目录（或 `--cwd`）确定，不向上查找 Git 根目录，也不跨项目搜索。

Agent 管理统一使用六个操作：`agent_spawn` 创建、`agent_list` 查看层级与状态、`agent_send` 提交输入、`agent_wait` 等待输入结果、`agent_stop` 暂停、`agent_resume` 恢复。`agent_spawn({ name, prompt, cwd? })` 异步返回 `{ agentId, inputId }`；`agent_send` 同样返回输入回执。`agent_wait` 按 `agentId + inputId` 等待具体输入，超时只结束本次等待。`agent_stop` 持久暂停调度并取消当前执行，保留队列和历史；`agent_resume` 恢复原 Agent 身份。[参数与生命周期说明](packages/tools/AGENT_TOOLS.md)。

同一根会话下的 Agent 可以互相发送输入和等待结果，列表包含根 Agent 与调用者自身；暂停和恢复仅控制调用者的后代。消息携带发送 Agent 的可信身份，不能冒充用户指令。

所有 Agent 默认可使用 Code Mode，六个 Agent 操作也可在脚本中组合调用。创建多个 Agent 可用 `Promise.all` 并行调用单个 `agent_spawn`。每次工具调用仍检查当前 Agent 的工具权限、资源范围和审批要求，Code Mode 与创建子 Agent 都不会扩大权限。

默认 delegation 策略为 `proactive`：对能改善速度或质量的独立工作主动分工，并遵守用户明确指定的分工、范围和限制。

会话父子关系只由 `agent.parentSessionId` 表达。数据库直接使用当前 Session、Input 和 Run 模型，不再兼容旧 Team/Task 数据库；使用新库启动。

工作目标和完成标准由对话表达，Agent 自行判断如何推进及何时结束。运行时不维护独立 Goal 状态机，也不会在一轮完成后自动注入续跑指令；后续工作通过同一输入队列交给原 Agent。

通过配置中的 `[agents]` 设置 `max_children`（每个 Agent 的直接子 Agent 数量）、`max_depth`（主 Agent 为第 0 层的最大深度）和 `max_concurrent`（共享并发数量），控制横向与纵向扩展。[配置示例](packages/host/AGENT_CONFIG.md)。

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

也兼容旧的 `ANTHROPIC_API_KEY`、`ANTHROPIC_BASE_URL`、`ANTHROPIC_MODEL` 命名。默认使用 `MiniMax-M3`：1M context、524,288 最大输出；CLI 默认申请 131,072 输出 token。`--thinking off|high` 对应 disabled/adaptive thinking，`--service-tier fast` 对应 priority tier。另可选择 `MiniMax-M3.1-Flash-Preview`（仅限 M Plan／MiniMax Code），支持 `low|medium|high|xhigh|max` 推理强度，不能关闭思考；它不会替换 M3 默认值。

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

可选模型为 `deepseek-v4-pro`（0813 版本）和 `deepseek-flash`（V4.1 Flash，支持图片）；旧名 `deepseek-v4-flash` 继续可用，官方会路由到 V4.1 Flash。两者均为 1,048,576 context、393,216 最大输出，支持 `off|low|high|max` reasoning；兼容输入的 `medium|xhigh` 会映射到 `high`。官方 Anthropic 格式端点为 `https://api.deepseek.com/anthropic`，当前 CLI 默认使用 OpenAI 格式端点。

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

也兼容 `KIMI_API_KEY`、`KIMI_BASE_URL`、`KIMI_MODEL` 命名。K3 为固定 thinking 模型，支持 `low|high|max` effort，1,048,576 context；CLI 使用 `max_completion_tokens=131072` 作为请求默认值。目录还提供 `kimi-k2.7-code` 和 `kimi-k2.7-code-highspeed`：262,144 context、支持图片，始终思考并保留历史推理，无可调 effort。

Z.ai 默认使用最新 `glm-5.3`：

```bash
ZAI_API_KEY=... bun run chili -- --model zai "总结这个仓库"
```

```bash
ZAI_API_KEY=
ZAI_BASE_URL=https://api.z.ai/api/paas/v4
ZAI_MODEL=glm-5.3
```

GLM-5.3 为固定 thinking 模型，支持 `low|high|max` effort，1M context、131,072 最大输出。新增 `glm-5.3-flash` 和 `glm-5.3-flashx`，同样为 1M context、131,072 最大输出，并支持图片。FlashX 当前不在 Coding Plan 中。目录同时保留官方 Coding Plan Anthropic 协议名 `glm-5.3[1m]`；它是同一代模型的协议 alias，不是旧模型。

xAI 使用 OpenAI-compatible Chat Completions，默认模型为 `grok-4.7`：

```bash
XAI_API_KEY=... bun run chili -- --model grok "总结这个仓库"
```

```bash
XAI_API_KEY=
XAI_BASE_URL=https://api.x.ai/v1
XAI_MODEL=grok-4.7
```

`grok`、`xai` 和 `x.ai` 都可作为 provider alias。Grok 4.7 支持 text/image、500k context 与 `low|medium|high|xhigh` reasoning；reasoning 不能关闭。Chat Completions 未显式设置时使用 128,000 的可见输出默认值，仍可显式选择 Grok 4.6。

以上目录于 2026-10-07 核对；官方来源、计价条件与接入限制见 [模型目录维护记录](packages/providers/README.md#model-catalog-verification-2026-10-07)。

Codex 有两条独立的连接，通过 provider 明确区分：

- `openai-codex`：使用 ChatGPT 订阅的 OAuth 凭据，只连接 ChatGPT Codex 后端。
- `codex-api`：使用 API key 和自定义 base URL，连接第三方 OpenAI Responses-compatible API。

两者不会互相回退或混用凭据。ChatGPT OAuth token 不会发往 `codex-api` 的自定义 endpoint，第三方 API key 也不会被 `openai-codex` 使用。

### ChatGPT OAuth (`openai-codex`)

ChatGPT 订阅里的 Codex 可以通过 TUI 斜杠命令登录：

```bash
bun run chili -- serve --provider openai-codex --model gpt-6.1-sol
bun run tui
```

在 TUI 里执行 `/auth login`，浏览器完成 ChatGPT 登录后，Chili 会把 OAuth 凭据保存到 `~/.chili/auth.json`。这个文件包含 access/refresh token，应按密码处理。`openai-codex` 的默认模型为 `gpt-6.1-sol`：

```bash
bun run chili -- --model openai-codex/gpt-6.1-sol "总结这个仓库"
```

ChatGPT 与 Codex API 的默认模型为 `gpt-6.1-sol`，目录还提供 `gpt-6-astra`、`gpt-6-luna`、`gpt-6-sol`，并保留 `gpt-5.6-sol`、`gpt-5.6-terra`、`gpt-5.6-luna`。官方 alias `gpt-5.6` 仍规范化为 `gpt-5.6-sol`，不会随默认模型改变。以上模型均为 1,050,000 context、128,000 最大输出。

GPT-6.1 Sol 和 GPT-6 Astra 的推理档位从 `low` 开始，旧配置中的 `off` / `minimal` 会转换为 `low`；GPT-6 Sol 和 GPT-6 Luna 支持 `off`（发送 `reasoning.effort=none`）。Luna 最高支持 `max`，其余型号保留 Chili 的 `ultra` 选项（请求转换为 `max`）。GPT-6 开启推理时不发送 `temperature`。实际模型访问权限取决于 ChatGPT 账号或 API 服务商。型号与参数核对于 2026-10-01，参见 [OpenAI 模型说明](https://learn.chatgpt.com/docs/models)和 [GPT-6 接入指南](https://developers.openai.com/api/docs/guides/latest-model)。

也可以用 `/auth` 查看 OAuth 状态，或用 `/logout` 删除本地 ChatGPT Codex 凭据。`openai-codex` 是 OAuth-only provider，不从 API key 或自定义 base URL 取凭据。

### 第三方 Responses API (`codex-api`)

第三方 Responses-compatible 网关使用专用的 `CODEX_API_*` 环境变量：

```bash
CODEX_API_KEY=...
CODEX_API_BASE_URL=https://gateway.example/v1
CODEX_API_MODEL=gpt-6.1-sol
```

选择该 provider 时，Chili 才会使用这组 API 配置：

```bash
bun run chili -- --model codex-api/gpt-6.1-sol "总结这个仓库"
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
/model openai-codex/gpt-6.1-sol
/model codex-api/gpt-6.1-sol
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

`bun run smoke:all` 是跨平台 CLI/runtime 的完整 fake-model smoke 入口，不需要 API key 或外网访问。Electron 的 macOS 打包与实机生命周期门禁独立运行 `bun run smoke:desktop`；发布或修改桌面代码时两者都必须通过。

`smoke:desktop` 在每轮独立临时目录中构建并清理桌面、sidecar 与手机页面，不覆盖共享 release，也只清理本轮启动的进程及其后代。隔离回归入口为 `bun test scripts/desktop-smoke-isolation.test.ts`。远程浏览器全链路使用 `bun run test:e2e:remote`，所需 Firefox、NSS `certutil` 与证书验证说明见上述 Alpha 验收指南。

局部开发验证可单独运行 `smoke`、`smoke:cli`、`smoke:p0p1` 或统一 Agent 验证入口 `smoke:agents`。`smoke:p0` 是 `smoke` 的别名。`bun run smoke` 会在系统临时目录创建 fixture workspace，覆盖 CLI fake model 基础工具循环、`--resume`、runtime `read`/`glob`/`grep`/`edit`/`apply_patch`/`bash` 工具面，以及最小 context compaction 路径。通过的 fixture 会清理；失败的 fixture 会保留并打印路径。需要保留全部 fixture 时可设置 `CHILI_SMOKE_KEEP_WORKSPACE=1`。

`smoke:agents` 通过真实 Host、HTTP 服务和 SDK 验证每次输入的独立结果、暂停后的 Host 重建与恢复、身份额度不变、同根通信、跨根隔离、Code Mode 嵌套和共享并发限制，并确认旧 Team/Task 路由不可执行。

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
