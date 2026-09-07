# MCP 2026-07-28 与第三轮可靠性验收

本轮从 `6b49833` 出发，在独立 worktree 中并行处理 MCP、Goal、任务租约和 Desktop。MCP 生产迁移提交为 `95d8c0f`；其他生产修复为 `f040e33`、`a9e8e1d`、`fed11cb`。后续提交只补验收与文档。

## 协议依据与落地范围

官方当前稳定修订是 **2026-07-28**，TypeScript SDK 已拆分为 v2 的 client/core/server 包。依据：[协议版本](https://modelcontextprotocol.io/docs/2026-07-28/learn/versioning)、[协议变更](https://modelcontextprotocol.io/specification/2026-07-28/changelog)、[官方 TypeScript SDK 发布](https://github.com/modelcontextprotocol/typescript-sdk/releases)。

Chili 将旧的 `@modelcontextprotocol/sdk` 替换为精确固定的 `@modelcontextprotocol/client@2.0.0` 与 `@modelcontextprotocol/core@2.0.0`。生产客户端采用自动协商，现代服务走 `server/discover`、逐请求版本/能力元数据和 `subscriptions/listen`，不再发送旧 initialize 握手或依赖 session header。旧版 HTTP、stdio 和显式 SSE 配置保留兼容路径。初始化结果返回实际协商版本。

升级保留现有工具、提示词和资源接口。SDK 自动聚合无 cursor 的列表请求，最多 64 页；结构化工具结果可为 JSON 原始值。认证失败和服务端 HTTP 故障不会触发旧协议回退。新协议的输入补充请求会明确失败：Chili 尚未接入 MRTR/elicitation/sampling 的交互桥，不自动重新执行可能改变状态的工具。任务扩展、OAuth 交互授权和资源订阅管理界面也不在本轮范围内。

stdio 使用真正的 SDK 原生 transport 实例，让协议探测运行在一次性兄弟进程中；严格要求先 initialize 的旧服务即使退出探针，也能正常启动主会话。保留主会话逐 frame 的 4 MiB 解析前限制、UTF-8 边界、原错误类型与只关闭一次语义。探针也有 SDK 原生缓冲限制。替换 SDK 内部 read buffer 的适配依赖精确版本，未来 SDK 升级须重跑这些回归。

独立审查发现 SDK 探测早于正常连接所有权建立，预取消或 close 可能仍接受迟到连接。Chili 增加探测取消控制、连接代次校验、并发初始化去重和未连接调用检查。HTTP/SSE 接收上限保持有效；超限后的调用不能被 SDK 的空列表回退误报为成功。

## 同轮修复和压力证据

- Goal 派生投影丢失后，事务入口原先判断无 Goal，与事件回放结果不一致。现同事务恢复最后已提交快照，保留终态和 receipt；最后事件为 clear 时绝不复活旧账本。
- 调用方取消运行中子任务后，原先跳过终态 CAS，留下 running 行直到租约过期。现取消阻止 provider 入口，同时允许仍持有有效租约的 runner 结算终态。
- 续轮的成功续租回执可能在过期后才返回。现核对 owner、run、generation、状态与有效期，拒绝旧回执授权执行，并按已观察租约完成关闭或重排队。
- Desktop 修复 641–695px 对话区裁剪；隐藏侧栏和工作台使用 inert，键盘关闭或跨断点收起时把焦点移回外部按钮。

Goal 使用 10,001 条 receipt 的单机探针：建历史 164.6ms，重开 22.39ms，捕获/结算约 9–10ms；clear/recreate、最早 receipt 重试和第 10,002 条追加均通过。历史扫描仍为 O(n)，这些观测不是延迟承诺。

任务压力测试用两个固定种子共 500 个任务、真实 SQLite 连接和逻辑过期时钟，覆盖取消、心跳、恢复与关闭；每批重新打开读取连接，检查单 run 至多一个 runner、无悬挂任务以及 lease/permit/timer 收口。

进程压力使用前一轮已构建的 `6b49833` 运行三轮，包含正常退出与父进程 SIGKILL，共 180 次项目切换。六个阶段进程数均为 7→7，清理 102–133ms，所有自有进程身份均已回收、哨兵存活。此证据验证前一轮进程实现；本轮新依赖另外通过新打包门禁验证。

## 验收

| 检查 | 结果 |
| --- | --- |
| `bun run typecheck` | 全工作区通过 |
| `bun test` 最终重跑 | 2874 通过、0 失败；236 文件、20647 断言，138.48 秒 |
| `bun run smoke:all` | 10/10，包括两组 team smoke |
| MCP 定向 | 现代 HTTP/生命周期 14 项、stdio 11 项，以及原 HTTP/SSE、接收边界、manager、adapter 回归通过 |
| Goal / 任务租约 | 各自定向 70 / 102 项通过；组合复核 8 项、67 断言通过 |
| `bun run test:e2e:desktop` | 四次真实 Electron 启动，9 个原生宽度：390/640/641/695/696/820/1080/1081/1440；6 个边界宽度真实按钮与键盘导航通过 |
| `bun run smoke:desktop` | 新 arm64 ad-hoc 包、签名/fuses/ASAR、凭据审计、离线 provider 加载、两次退出和父进程强制结束回收通过 |
| `bun run test:e2e:remote` | 同机私网可信 HTTPS、真实 Electron/sidecar；断线、未知结果、项目隔离和 18 项旧授权请求拒绝通过 |

第一次全仓为 2873 通过、1 条基础提示词测试超时。这条测试无意连接了用户 MCP 配置，单独重跑仍耗时 4.37 秒。修复为该测试使用 manual MCP 连接模式；提示词断言不变，同文件 38 项测试耗时 1.32 秒。随后按上表重跑全仓，未放宽超时。

原始日志保存在 `.worktrees/soak-20260907-integration/apps/desktop/out/soak-validation/2026-09-07/`。最终原生截图位于该 worktree 的 `apps/desktop/out/electron-e2e/2026-09-07T06-33-15.806Z/`，641px 截图已视觉复核；截图等待隐藏动画结束，避免把过渡帧当作最终效果。远控证据位于 `apps/desktop/out/remote-control-e2e/2026-09-07T06-33-48-972Z/evidence.json`，保持 TLS 校验、未修改系统信任。

本轮仅合并本地 `dev`，不推送远端。使用 fake model 或本地 HTTP/stdio 夹具；远控使用同机私网浏览器，不等同于移动真机验收。
