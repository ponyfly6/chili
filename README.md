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
MINIMAX_MODEL=MiniMax-M2.7-highspeed
```

也兼容旧的 `ANTHROPIC_API_KEY`、`ANTHROPIC_BASE_URL`、`ANTHROPIC_MODEL` 命名。需要临时回退到 core 里的旧路由时：

```bash
bun run chili -- --model legacy-minimax "hello"
```

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

可选模型为 `deepseek-v4-pro` 和 `deepseek-v4-flash`。官方 Anthropic 格式端点为 `https://api.deepseek.com/anthropic`，当前 CLI 默认使用 OpenAI 格式端点。

Kimi 使用月之暗面 OpenAI-compatible 接入，默认模型为当前官方推荐的 `kimi-k2.6`：

```bash
MOONSHOT_API_KEY=... bun run chili -- --model kimi "总结这个仓库"
```

Kimi 配置优先使用这些环境变量：

```bash
MOONSHOT_API_KEY=
MOONSHOT_BASE_URL=https://api.moonshot.cn/v1
MOONSHOT_MODEL=kimi-k2.6
```

也兼容 `KIMI_API_KEY`、`KIMI_BASE_URL`、`KIMI_MODEL` 命名。可用 `--model kimi:off` 关闭 K2.6 thinking。

ChatGPT 订阅里的 Codex 可以通过 TUI 斜杠命令登录：

```bash
bun run chili -- serve --model codex
bun run tui
```

在 TUI 里执行 `/login`，浏览器完成 ChatGPT 登录后，Chili 会把 OAuth 凭据保存到 `~/.chili/auth.json`。这个文件包含 access/refresh token，应按密码处理。登录后使用 `--model codex` 会走 ChatGPT Codex Responses 后端，默认模型为 `gpt-5.5`：

```bash
bun run chili -- --model codex "总结这个仓库"
```

也可以用 `/auth` 查看状态，或用 `/logout` 删除本地 Codex 凭据。可选环境变量：

```bash
OPENAI_CODEX_MODEL=gpt-5.5
OPENAI_CODEX_BASE_URL=https://chatgpt.com/backend-api
OPENAI_CODEX_ACCESS_TOKEN=...
```

---

## 开发

```bash
bun run typecheck
bun test
bun run smoke
bun run smoke:p0p1
bun run smoke:cli
bun run test:index
bun run scripts/probe-minimax.ts --mock
```

`bun run smoke` 是本地 fake-model P0 smoke 汇总入口，不需要 API key。它会在系统临时目录创建 fixture workspace，覆盖 CLI fake model 基础工具循环、`--resume`、runtime `read`/`glob`/`grep`/`edit`/`apply_patch`/`bash` 工具面，以及最小 context compaction 路径。通过的 fixture 会清理；失败的 fixture 会保留并打印路径。需要保留全部 fixture 时可设置 `CHILI_SMOKE_KEEP_WORKSPACE=1`。

已有分层 smoke 仍可单独运行：`smoke:cli`、`smoke:p0p1`、`smoke:p2`、`smoke:p2-control`、`smoke:p3`、`smoke:p3-background`。`bun run test:index` 会输出当前 smoke 脚本和按 workspace 分组的 `*.test.ts` 清单，便于后续 worker 快速选择验证范围。

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
