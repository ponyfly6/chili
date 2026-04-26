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

产品方向更接近 Codex 或 Claude Code，而不是泛用型 autonomous agent。

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

---

## 开发

```bash
bun run typecheck
bun test
bun run smoke:p0p1
bun run smoke:cli
bun run scripts/probe-minimax.ts --mock
```

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
