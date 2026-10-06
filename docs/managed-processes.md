# 让 AI 保持程序运行并继续观察

2026-10-03 更新。顶层任务可以启动一个持续运行的命令，在模型回复后继续检查它的输出和状态。实现位于共享 tools / Host，供 CLI、TUI 和 Desktop 使用。

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

## 硬崩溃与执行归属

POSIX 的 `runProcess` 由独立 guardian 启动命令。guardian 是进程组 leader，先等待 Host 将自己的 PID 与执行 owner 绑定并持久登记，再接受启动握手；登记失败不会运行命令。宿主是控制管道的唯一持有者，工具及其后代不继承管道。宿主被 SIGKILL 时，EOF 触发同组 TERM，宽限期后 SIGKILL；正常完成也清理残留后代。guardian 保持组身份直到最后一次组信号，不读取陈旧 PID 文件来杀进程。

进程 owner 通过异步执行上下文传入，两个同进程 Host 不会相互登记资源。`runProcess` 在结果帧、guardian 实际退出以及组清理检查之后返回；owner 恢复同时检查旧 Host 与登记 guardian 的存活，不把 lease 到期当作外部程序已经停止。CLI 与编译后的 Desktop sidecar 都有独立 guardian 入口，不进入模型、认证或 HTTP 初始化。

guardian 自身不继承工具环境变量、不在项目目录加载运行时配置。命令输出通过有界背压的独立帧传送，控制消息与任意程序输出分开。

`process-guardian.test.ts` 真实启动临时 owner、忽略 TERM 的 shell、孙 shell 及 sleep，再 SIGKILL owner 并确认所有实际 PID 消失；还验证登记失败无副作用、并行 owner 隔离、返回前注销、预加载环境隔离与编译可执行文件自举。没有使用真实账户或持久工作文件。

MCP stdio 使用独立的透明 guardian，SDK 的发现探测和会话连接都先登记 owner 再启动服务器。私有控制连接丢失会清理服务器及同组后代；Host 关闭或恢复前等待实际进程组消失。见 [MCP 契约与实际崩溃测试](../packages/mcp/README.md)。

边界：Windows 尚无 Job Object 硬崩溃树清理，MCP stdio 在此平台拒绝启动。显式 `setsid` / daemonize 脱离组的程序，以及 guardian 本身被外部同时杀死，不在这项进程组保证内。运行句柄不会跨重启复活，恢复不得自动重放未知副作用。

## 执行政策与隔离

scoped Bash 请求把同一个执行政策交给 backend；不能承诺落实政策的自定义 runner 和无沙箱平台拒绝执行。macOS Seatbelt 把 `writeScope` 转成规范路径的实际写入过滤器，空集合不允许工作区写入；只保留单次私有临时目录。网络、跨沙箱进程控制与升级仍被拒绝，full-access profile 不能覆盖 scoped 请求。`executeScope` 只决定命令能否提交，不能替代文件或网络隔离。

配置中的文件 read / write / edit deny 同样约束 Bash。Host 按每次请求的工作区重新解析规则，使用规范资源路径生成 Seatbelt deny；相对路径、绝对路径、`./` 和符号链接指向同一资源时得到相同结果。为防止把不可读资源重命名或硬链接到可读别名，read deny 也禁止修改该资源，并阻止工作区内祖先目录的重命名。权限匹配依赖的复杂 glob 若不能精确转换为 backend 约束，启动会明确失败。

只要存在文件 deny，full-access 也必须经支持资源 deny 的沙箱；`require_escalated`、不支持沙箱的平台和没有声明执行能力的注入 backend 都不能绕过。此路径保留标准 Seatbelt 的网络与工作区写入限制。Host 在 backend 准备完成及 guardian 获准启动前复核文件政策版本；准备期间政策变化会拒绝当前命令，要求重新准备。命令本身的最新授权也在同一启动边界复核，后台延迟启动遵守相同检查。取消发生在最后授权等待时，guardian 会退出，迟到答复不能启动命令。

真实沙箱测试覆盖同命令中越界写、符号链接、显式空写范围及新建跨范围硬链接。有限写范围还会在启动前扫描并拒绝已有多硬链接文件，检查超过 100,000 条目时拒绝运行。完整工作区授权保留已有 metadata 检查，没有全工作区硬链接索引；预先把工作区外文件硬链接进完整授权工作区的情形不提供严格物理文件隔离。运行期间的权限撤销不动态改写已经启动的 Seatbelt profile；停止已有受管进程才会收回它的执行能力。
