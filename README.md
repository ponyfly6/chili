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

---

## 当前状态

- 早期开发中
- 还没有稳定公开 API
- Bun + TypeScript workspace
- 终端优先，本地优先

---

## License

TBD
