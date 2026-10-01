# 让 AI 保持程序运行并继续观察

2026-09-08。顶层任务可以启动一个持续运行的命令，在模型回复后继续检查它的输出和状态。实现位于共享 CLI harness，供 CLI、TUI 和 Desktop 使用。

## 工具用法

AI 通过已有 Bash 工具启动前台程序，设置后台托管参数：

```json
{"command":"bun run dev","background":true}
```

不添加 `&` 或 `nohup`。工具返回 `processId`、实际运行状态和最新输出。`running` 只表示命令尚未结束，AI 仍需检查日志或调用服务来判断是否可用。

后续轮次可以调用：

```json
{"action":"read","processId":"process_…"}
{"action":"read","processId":"process_…","waitMs":1000}
{"action":"list"}
{"action":"stop","processId":"process_…"}
```

这些是 `process` 工具的输入。`read` 返回最新尾部，重复读取可能包含相同内容；`waitMs` 等待命令退出或超时，最多 30 秒。它不等待某一条新日志，也不替 AI 判断程序是否就绪。需要重启时，先 stop，再用 Bash 启动。

## 生命周期与边界

- 进程属于当前 session 与规范化工作区，其它任务不能读取或停止这个句柄。
- 普通回复完成或模型失败后保持运行。Desktop Steer 保持已交付句柄的程序运行。
- 明确 Stop、外部 prompt 取消、归档和 harness 关闭时，等待已有 runner 完成进程组清理。启动尚未返回句柄时取消也会清理。
- 进程与日志只保留在当前宿主生命期，关闭后不自动重启。首批只向顶层任务开放，不向 scoped 子代理开放。
- 后台命令没有默认运行时限，可显式设置 `timeoutMs`。前台 Bash 保持原有默认超时。
- 每个 harness 最多 8 个运行命令、保留最近 32 个结束记录；日志保留最多 16 KiB / 200 行的尾部，不持续写日志文件。
- 支持非交互程序；没有 PTY、stdin、任意 PID 或信号控制。

使用原有命令审批、cwd 检查、环境变量处理与 runner。默认 macOS 沙箱的网络限制也仍然有效，包括本地监听；被阻止的开发服务器需要按现有权限流程运行。实现没有新增端口分配、浏览器或沙箱规则。

## 实现与验证

`ManagedProcessManager` 持有已有 `BashRunner.run()` 的 Promise、独立取消信号及有界输出尾部。程序结束和停止都通过原有进程管理路径完成，不另写 spawn / kill 实现。运行中的输出不会继续写回已经完成的启动工具调用。

`apps/cli/src/managed-process.integration.test.ts` 用脚本模型驱动真实工具：启动本地 HTTP 服务 → 模型回复 → 新一轮调用服务和读日志 → 读取并编辑响应文件 → 再次调用得到新结果；同一服务进程贯穿修改。另验证跨任务隔离、Steer 保活以及 idle Stop、归档和关闭清理。

工具和生命周期测试补充覆盖拒绝审批、工作区逃逸、取消启动、输出分片与截断、读取取消、超时、子进程组清理和关闭重入。
