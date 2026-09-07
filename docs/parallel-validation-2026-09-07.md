# 2026-09-07 并行改进与验收

本轮接续 Desktop 主题与多项目任务，以 `461ee88` 为交付基线，在九个独立 worktree 中开发、复核和集成。参考同级目录中的 Codex、OpenCode、Pi、Aider；参考仓库保持只读。最终运行代码验收版本为 `5fae9266722904c5ae7b19b974dfda60e36fd2b4`。

## 交付内容

- Goal：保存每轮计费凭据，暂停后的在途用量仍能结算；工具续轮与超预算收尾保持原目标归属，清除后重建目标不会被旧轮次计费。
- Team verifier：判定格式消歧，限制补丁数量、字节和总耗时；不完整写入证据不能判为通过，纯只读任务可在非 Git 目录验证。
- Activity：子代理层级、任务说明、结果、错误和历史；长内容分页，执行统计默认折叠，项目/任务切换重置选择。
- Changes：按文件查看补丁、增删行号、统计与原文；长内容分页，保留截断提示并拒绝过期作用域的响应。
- SDK：保留执行开始前的合法工具输入预览，区分容量限制与因果缺口；接受没有任务名的合法树分组节点。
- Desktop 生命周期：Git supervisor 在 Electron 被强制结束后回收整个所属进程组；构建前更新共享 TypeScript 输出，避免旧 SDK 混入新包。
- 验收：新增三项目真实进程门禁、实际委派与 Git 面板交互，以及跨项目旧手机授权的负向测试；接入 macOS CI。

## 最终验证

| 检查 | 结果 |
| --- | --- |
| `bun run typecheck` | 全部通过 |
| `bun test` | 2799 通过，0 失败，225 个文件 |
| `bun run smoke:all` | 10/10，包含两组 team smoke |
| `bun run test:e2e:desktop` | 四次真实 Electron 启动通过，覆盖 Goal、审批/提问、多项目、主题、新面板及 1440/820/390 布局 |
| `bun run smoke:desktop-projects` | 三项目各轮切换 30 次，独立 Stop、正常退出、父进程 SIGKILL 与无关进程隔离全部通过 |
| `bun run smoke:desktop` | 新构建 arm64 ad-hoc 包、签名/fuses/ASAR、凭据审计、两次启动与强制退出回收全部通过 |
| `bun run test:e2e:remote` | 同机私网可信 HTTPS Firefox 测试通过；18/18 旧授权请求被拒绝 |

最终多项目记录的正常退出耗时为 257ms，父进程强制终止后收口为 434ms。这是本机本轮观测值，不作为性能承诺。

本机证据相对于集成 worktree：

- `apps/desktop/out/parallel-validation/2026-09-07/`：日志、进程测量和截图。
- `apps/desktop/out/electron-e2e/2026-09-07T03-57-14.430Z/`：最终桌面界面截图。
- `apps/desktop/out/remote-control-e2e/2026-09-07T03-59-20-064Z/evidence.json`：最终远控证据。

## 已知边界

手机远控此次使用电脑上的私网 Firefox，`physicalDeviceTested: false`，未做 iPhone/Android 真机验收。Goal 串行化覆盖同一个 store 对象内的写入；独立数据库连接/进程之间的原子事务，以及首次持久化前丢失的 usage，仍不在本轮保证范围内。
