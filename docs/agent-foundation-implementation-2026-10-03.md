# 编码智能体基础层实施记录

日期：2026-10-03。实施基线：本地 `dev e1733bb`。远端 dev 经 `git ls-remote` 核对为 `53f9d1b`，是本地已有祖先，本地领先 190 个提交；报告基线之后没有新的本地或远端提交需要合入。保留工作区已有的 `docs/product-direction.md` 修改。本次保留 Bun/TypeScript、共享 Host、SQLite、持久输入、工具执行器及 Task/Run 的既有机制，未改变公开分发或 UI 优先级。

本记录对应[复核报告](agent-foundation-review-2026-10-03.md)。实现进入 Host/CLI、HTTP/SDK 及共享子会话路径，桌面修改仅涉及公共事件兼容和进程守护入口。没有使用真实账号、付费模型或真实服务测试。测试使用临时目录、假凭据、假 transport、受控本地进程；完整门禁使用独立临时 profile。

## 第一批：已确认一致性问题

| 原问题 | 现在的行为与回归 |
| --- | --- |
| 文件路径别名绕过 deny | 先解析真实资源，再评价政策。相对/绝对/`./`、symlink、包含 `*` 的字面文件名均有回归。多硬链接保守拒绝；真实文件与权限 glob 使用不同规范化。 |
| 等待审批后旧决定放行 | 审批决定绑定政策版本/资源，等待后、快照后、发布 running 后、文件锁等待后重新校验。新增 deny、撤销 allow、撤销持久 grant 都不能被旧答复覆盖。 |
| 同名 MCP 配置继承凭据/信任 | 身份绑定 transport/URL/command/args/cwd/env/OAuth 目标；普通工具和 resource read 都固定目标与目录版本。同名换目标不继承旧 name-only 信任/批准。 |
| shell 前缀扩大权限 | executeScope 改为完整 invocation allowlist（或显式 `*`），`[]` 拒绝执行。实际写范围/网络/升级约束交给有能力的 backend；不支持的 scoped runner 拒绝。 |
| command 丢失空集合 | 从配置、MCP prompt、CLI/HTTP 转换到工具政策保留 `[]`，错误类型拒绝，不静默放宽。 |
| provider call ID 串写 | 每次调用生成内部 ID，另存 providerCallId。SQLite 同时防止旧写入者跨 session/turn 冲突；协议回放兼容旧历史和重复外部 ID。 |
| 文件观察跨会话 | 按 session、canonical workspace/path、内容摘要隔离，读者必须自己观察当前版本；跨进程协作锁保护校验与写入。 |
| revert 绕过运行权 | 整次恢复持 session operation，Stop 可取消；snapshot v3 再持资源锁并统一检查全部目标，拒绝其他会话或未知修改。 |
| 第二 Host 伪控制成功 | 同 store 活 owner 存在时创建直接拒绝；独立 RuntimeService 连接也拒绝外部 owner 的 Stop/Steer 等操作。没有伪 attach。 |
| OAuth 刷新并发/撤销 | 同账户同 auth store 跨进程协调、可取消锁等待/网络、刷新期限、版本 CAS；logout、switch、同账号重新登录均不能被迟到刷新覆盖。未知 refresh 结果不自动重试。 |

## 第二批：共同执行契约

- Host 保存 profile/auth path/project/workspace 元数据；Git worktree 共用项目 ID，保留独立工作区 ID。同一 Host 的不同 cwd 仍各自解析项目规则、skills 和 Memory。会话恢复现仅查当前工作区存储并沿用原 ID，历史环境元数据不再限制恢复或继续执行。
- 权限资源、审批决定、OS 隔离分开。文件 deny 同时进入文件工具及 Bash backend；macOS Seatbelt 落实实际读写禁止、scoped 写入和网络边界。存在文件 deny 时 full-access 也不能绕过；不支持隔离的 backend 拒绝，无法精确落实的复杂 deny glob 拒绝。executeScope 是完整命令准入规则，不是系统调用 allowlist。
- PreparedToolCall 固定定义、已校验参数、分类、资源与目录版本。统一 JSON Schema 校验拒绝非法参数及不支持的异步 schema。最新撤销规则仍在效果边界复核。无效的 interruptBehavior 声明移除，实际取消沿 signal。
- 资源限制必须由本地工具实现显式支持；远端 MCP 的 read-only 标注不能证明可以落实文件或执行范围。受限调用拒绝未知能力工具；Git 无法安全过滤历史对象和 hooks 时也保守拒绝。搜索先过滤实际文件，再读取内容，返回前重新核对授权。
- 结构化程序数据、模型内容、显示投影与审计分离。超限程序数据明确失败，不截断为另一个值。SQLite→HTTP/SSE→客户端只投影显示内容，完整数据留存。
- 子代理首次、follow-up、mailbox 共用 RuntimeService。真实 Task/Run 投影决定完成情况，保持 generation/lease、额度、取消和既有 Team 验证/合并保证；reasoning ultra 不再暗中改变委派政策。
- POSIX 进程启动先与 owner 登记握手；宿主硬崩溃由 guardian 清理进程组，Host 重开同时检查 owner 和 guardian/group，不能把 lease 过期当成已停止。编译后的 CLI/Desktop 同样有守护入口。
- 三模型协议统一覆盖认证、限流等待及完整响应的总期限，并在实际网络请求前保存认证身份。旧 core Anthropic/MiniMax 适配器保留公开入口并改为共享 providers 的薄包装，避免第二套认证和执行边界。原有流式闭合检查、仅未输出时的保守重试保持。

## 第三批：上下文和长期工作

- 项目指令、长期 Memory、会话历史分别管理。不同来源保留信任标签和协议角色，项目/skills/MCP 材料不能因错误拼接成为平台指令。
- 每次实际请求（包括重试、压缩）保存最终消息、规则/工具内容版本、模型/账户身份、预算与删减原因。inspect 默认读实际请求；带假设输入时才返回 preview。历史请求不会随文件或 Memory 更新而改变。
- Memory 使用 profile SQLite 权威存储：稳定 ID、scope/project、revision/CAS、事务更新、墓碑、词法相关检索。旧 Markdown 一次性导入并保留来源，可导出，不双写两个权威。
- 自动 Memory 注入检查当前 memory.read 政策。规则 paths/alwaysApply 按本会话实际文件目标生效，遗漏记录可检查；已知目标还发现嵌套指令。
- 压缩边界保持 call/result 配对及未完成调用，EOF/取消/不完整摘要不能替换旧历史。当前 Goal/规则继续由独立持久状态恢复；摘要的语义完整性仍需真实模型评估。

## 兼容与明确限制

- 未实现跨进程 attach、独立常驻服务、MCP OAuth 登录；静态 MCP 凭据和目标信任已支持。旧 name-only stdio 信任不自动升级为任意新目标授权。
- SQLite/additive 事件迁移保留旧数据。已被旧 provider-ID 冲突破坏的历史 projection 不声称自动还原。Snapshot v2 只允许已经相同的 no-op，缺少后像证据的更改恢复明确拒绝；备份仍保留。
- 文件锁是内置工具间协作，不是通用文件系统 CAS。外部编辑器、任意 shell、扩展不参与该锁；多文件 patch/revert 不是文件系统事务。快照变更 journal 丢失后，对更改文件保守拒绝自动恢复。
- POSIX guardian 不保证约束主动脱离进程组或同时被杀死的守护者；Windows 未实现同等树清理。运行中的 OS 进程不会因文件政策后来变化自动撤销，明确 Stop 才终止它。
- 限流协调当前为进程内；OAuth refresh 的跨进程协调限于同 auth store。远端已接受操作和 token rotation 不能保证撤回或 exactly-once。
- Command 尚无 readScope 字段；schema 按需激活未默认开启。MCP prompt 渲染在 durable admission 前，同 Host 并发渲染不承诺恰好一次。
- 存在文件 deny 或资源 scope 时，Git 和无法落实约束的 MCP/扩展工具保守拒绝。默认只读 Git 也拒绝外部过滤器并关闭 fsmonitor；有此需求须走隔离 Bash。grep 暂不读取 ignore/config 文件，保留隐藏目录及 `.git`/`node_modules` 排除，并限制候选数量。
- 同步 accepted receipt 可能先于异步身份校验；身份不符会在执行前失败，不会改用另一个 profile 执行。无持久 Task 投影的旧适配器保留 legacy 完成解码，真实 Host 使用类型化投影。
- 首次尚未知文件目标时，不能保证提前注入所有 scoped rule；遗漏可追踪。Memory 检索是词法检索。保存的请求是共享模型适配器输入，不是 provider HTTP 字节级重放。
- 假模型验证软件约束；未做真实模型的长任务、压缩语义或同模型新旧能力对比。该能力验收没有冒充完成。

## 验证记录

最终稳定代码在 macOS、Bun 1.3.14 上完成以下门禁，使用独立临时 `CHILI_HOME` / `CHILI_AUTH_FILE`：

| 门禁 | 结果 |
| --- | --- |
| `bun test` | 3267 通过，0 失败；281 个文件，229.86 秒 |
| `bun run typecheck` | 通过，含各 workspace、Desktop 与 control-web |
| `bun run smoke:all` | 10/10 套件通过 |
| `smoke:p3-team-model`、`smoke:p3-team-parallel` | 均在完整 smoke 中执行并通过 |
| `git diff --check` | 通过 |

报告中的临时复现已转为仓库行为用例。独立审查重新制造并复验了审批撤销、字面通配符资源别名、异步 schema、MCP 资源换目标、跨 Host guardian 归属、文件内部等待后撤权、Bash scope 撤销、搜索泄露和 Git 过滤器副作用。实际 Host 还验证了永久批准的保存时机和同会话撤销；受控进程验证了真正的 SIGKILL、子孙进程退出和 owner 重开屏障，未以 lease 到期替代进程检查。

门禁中的旧假工具能力声明、受限 Git 可见性预期已经按新契约更新，并保留/增加拒绝副作用的行为断言；最终重新跑完全部测试。验证日志保留于本机 `/tmp/chili-foundation-tests-final-verified.log`、`/tmp/chili-foundation-typecheck-final-verified.log`、`/tmp/chili-foundation-smoke-verified.log`。

这些结果验证假模型/假 transport 下的软件契约，以及受控本地文件、SQLite、进程和 OS 隔离的真实行为。**未执行真实模型的长期任务能力验收**，不据此推断真实模型的压缩语义、任务成功率或新旧能力提升。

关键实现与证据：

- [Host](../packages/host/README.md)、`owner-identity.test.ts`、`resource-contract.test.ts`、`runtime-owner-consistency.test.ts`。
- [文件与快照](file-observation-contract.md)、[进程](managed-processes.md)。
- [Context](../packages/core/src/context/README.md)、[Memory](../packages/core/src/memory/README.md)。
- [MCP](../packages/mcp/README.md)、[providers](../packages/providers/README.md)、[commands](../packages/commands/README.md)。

## 2026-10-06：权限执行链收拢

本次仅整理工具授权链，保留其余未提交改动，以及既有的即时撤权行为：等待审批、备份、文件锁或文件版本校验期间权限被收紧，旧批准不能继续放行后续效果。已启动的 OS 进程仍由 Stop 终止，不承诺通过后续政策修改撤销已发生的效果。

职责分为三处：

1. `PolicyApprovalBroker` 是规则观察和审批的入口。每个检查点只调用一次规则 resolver，复制规则与会话 grant，并从同一份副本生成权限决定、版本和文件资源限制。副本不会因调用方原地修改规则而变化；跨检查点重新读取，不使用整轮缓存、TTL 或跨会话缓存。
2. `ToolExecutor` 统一验证工具/目标身份、worker 约束、文件访问和批准版本。worker 判断与传给 backend 的范围来自同一次 worker policy 读取。审批返回 `ApprovalResolution`，同时携带决定和接受该决定的版本，执行器不再读一份新政策给旧答复重新绑定版本。永久 grant 的保存会合法改变配置；保存后重新检查 deny 与撤权，其他审批不能借异步回调换用新版本。
3. 备份与文件工具在实际效果边界调用统一的 `assertCurrentAuthorization`。保留备份读取、文件锁等待、目录创建、写入/删除之前的检查，以及工具进入执行前、running 事件发布后的最后检查。执行器移除快照完成后与进入工具前相邻的重复全量检查，由后一个检查覆盖期间变化。路径安全、文件版本和协作锁仍分别负责资源身份和文件一致性。

`ApprovalBroker.capturePolicy` 和 `resolve` 是可选增强接口；已有只实现 `decide`/`preflight`/资源检查的自定义 broker 保留原有调用方式。跨检查的一致快照与批准版本交接由内置 `PolicyApprovalBroker` 提供。Bash backend 的实际隔离配置验证、搜索结果返回前的资源检查继续保留，它们负责不同的执行边界。

在同一份受控复现（单文件、已读取、自动允许、启用真实文件备份）中，规则 resolver 调用次数如下；这是读取入口计数，不等同于底层磁盘读次数：

| 操作 | 整理前 | 整理后 |
| --- | --- | --- |
| edit | 23 | 7 |
| write | 26 | 8 |
| 单次 preflight | 2 | 1 |

新增 `packages/tools/src/authorization.test.ts` 覆盖决定与版本同源、规则原地修改、grant 撤销、并发 session/workspace 隔离、读取次数上界、三种批准的等待期撤权、真实文件锁阻塞后的撤权、规则加载失败、批准版本交接和 worker 范围收紧。已有快照/事件发布/文件版本校验后的撤权、资源别名与搜索返回约束继续作为行为回归。

本次验证（macOS、Bun 1.3.14；全量单测与 smoke 使用各自独立的临时 profile）：

| 门禁 | 结果 |
| --- | --- |
| `bun test` | 3281 通过，0 失败；282 个文件，226.56 秒 |
| `bun run typecheck` | 通过，含 Desktop 与 control-web |
| `bun run smoke:all` | 10/10 套件通过，包含 team-model 与 team-parallel |
| 最后补跑授权、foundation、Host 审批回归 | 33 通过，0 失败 |
| `git diff --check` | 通过 |

日志：`/tmp/chili-permission-tests.log`、`/tmp/chili-permission-typecheck.log`、`/tmp/chili-permission-smoke.log`、`/tmp/chili-permission-final-focused.log`。原受控计数脚本再次确认 edit 7 次、write 8 次、单次 preflight 1 次；其中旧脚本统计的 `fullChecks` 只包装旧的公开方法，不能用于计数新的 snapshot 内部文件检查。
