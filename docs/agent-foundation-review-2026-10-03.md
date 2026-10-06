# Chili 编码智能体基础层复核

日期：2026-10-03。Chili：`dev e1733bb`。状态：源码研究与架构建议，尚未实施以下运行代码变更。

实施更新：以下问题与复現结论保留为基线证据；后续运行代码、迁移、行为验证和未完成边界见[基础层实施记录](agent-foundation-implementation-2026-10-03.md)与[Host 当前契约](../packages/host/README.md)。不再将下文全部建议视为当前未实施状态。

用户最新决定：暂缓 UI 与交互扩建，先打磨编码智能体底层；从任务全生命周期通盘审视，不限于用户点名的模块。产品目标仍是用户愿意把真实日常工作迁到本地 Chili，公开分发后置。本文件覆盖同日进度报告的客户端优先排序，也更新本报告第一轮“上下文先行”的排序。

## 同日全局复核：先统一执行身份、权限和状态归属

审查覆盖：输入接纳、配置/账户选择、上下文准备、模型请求、工具副作用、子代理、工作区修改、审批、停止、快照恢复、进程崩溃及客户端重连。六个子代理分别审查权限隔离、工具与扩展、执行生命周期、服务接口、模型可靠性、配置与上下文；主代理交叉验证并补查跨会话文件状态。

**主要问题是模块之间的执行约束不一致。共享 Host 已提取，但操作身份、资源权限、文件版本、运行 owner 与请求快照还没有成为贯穿全链路的契约。** 先修这些基础一致性问题，再增强 Memory、复杂 Team 和客户端。

### 已确认的问题及复现边界

| 问题 | 实际触发与影响 | 证据及限定 |
| --- | --- | --- |
| 文件 deny 匹配输入文本，实际操作使用规范路径 | `deny read(blocked.txt)` 拒绝原路径，但 `./blocked.txt` 与同文件绝对路径通过；相同资源权限不一致 | [read-file:87](../packages/tools/src/builtins/read-file.ts:87)、[policy:68](../packages/policy/src/index.ts:68)。真工具＋假文件复现；workspace 外路径防护仍存在 |
| 等审批时改变政策，旧答复仍可放行 | ask 等待中规则改为 deny，再答 allow_once，当前请求获准；紧接着新的 preflight 已 deny | [Host approval:123](../packages/host/src/approval.ts:123)、[tools approval:123](../packages/tools/src/approval.ts:123)。动态 resolver＋假审批复现；需要最新 policy revision 复核 |
| MCP 同名配置复用不属于新目标的信任/凭据 | 项目同名配置替换 URL 后仍继承用户 headers，fake fetch 实收新 URL＋假 Authorization；同名 stdio 替换 command 也继承名称信任 | [MCP config:77](../packages/mcp/src/config.ts:77)、[sdk-client:303](../packages/mcp/src/sdk-client.ts:303)、[Host:882](../packages/host/src/mcp-control.ts:882)。没有联网；Desktop manual 暂不连接，其他连接路径仍受此设计影响 |
| shell scope 与实际命令不一致 | `executeScope=["pwd"]` 放行 `pwd ; printf FAKE_AUDIT_MARKER`，fake runner 收到整条复合命令 | [tool-policy:326](../packages/tools/src/tool-policy.ts:326)。真 executor/bash/snapshot＋fake runner；不是已证明网络逃逸，macOS 沙箱仍阻止网络和 workspace 外写 |
| Command 丢失显式空限制 | 直接 `allowedTools:[]` 禁止全部工具；经 command 转换后变成无 toolPolicy | [submission:40](../packages/commands/src/submission.ts:40)、[project-loader:302](../packages/commands/src/project-loader.ts:302)。同一约束在入口转换时变宽；独立 worker policy 仍会执行 |
| Provider 调用 ID 被当作内部全局 ID | 两个会话均返回 `call_0`，两次工具执行完成，但 tool_calls 只剩一行，session 属于 A、output 属于 B | [runtime:551](../packages/core/src/single-agent-runtime.ts:551)、[store:4355](../packages/store/src/sqlite-event-store.ts:4355)。假模型＋真实 SQLite 复现；需要内部调用 ID 与 provider ID 显式映射 |
| 文件读取状态跨会话共用 | A read 后 B 未读即可 write；B 更新读取记录后 A 未重读即可覆盖 B 的内容 | [executor:81](../packages/tools/src/executor.ts:81)、[file-read-state:207](../packages/tools/src/file-read-state.ts:207)、[Host:521](../packages/host/src/host.ts:521)。同 executor、真 read/write/snapshot 复现；Host 共享 executor 接线由源码确认 |
| 跨 Host 控制不抵达实际 owner | A 执行、B 连同一 SQLite；B 带真实 executionRef 停止报 stale，不带引用只暂停队列，A signal 未取消 | [runtime:1114](../packages/core/src/runtime-service.ts:1114)、[runtime:2418](../packages/core/src/runtime-service.ts:2418)。双连接假 runner 复现；当前 README 已声明不支持跨 Host attach，不将其冒充已承诺的能力 |
| 快照恢复不取得执行互斥权 | A 持有 session run claim 时，B revert 仍调用恢复 provider 并成功返回 | [recovery:27](../packages/core/src/recovery.ts:27)、[recovery:57](../packages/core/src/recovery.ts:57)。双连接＋fake snapshot provider 复现；运行中的文件修改与恢复必须由同一 owner 仲裁 |
| OAuth 刷新不随请求取消，也缺少并发协调 | 同一过期账户两个请求发起两次 refresh；取消后仍等待，假 fetch 释放后仍写两次凭据 | [openai-codex:790](../packages/providers/src/openai-codex.ts:790)、[OAuth:97](../packages/providers/src/oauth/openai-codex.ts:97)。假凭据/假 fetch，无真实账号调用；原子 rename 不保证跨请求更新一致 |

另已用临时 Bun 宿主＋真实 sleep 复现：宿主 SIGKILL 后 detached 子进程仍存活，测试进程已清理。[process:81](../packages/tools/src/process.ts:81) 与 [managed-process:59](../packages/tools/src/managed-process.ts:59) 说明进程清理由宿主回调和内存登记负责。正常 Stop/close 有清理保证，硬崩溃则没有。旧 lease 过期不代表旧外部进程已经停止；需要明确 owner 死亡后的进程清理语义，不能只持久化 PID。

### 全局设计取舍

| 共同约束 | 具体责任与完成标准 |
| --- | --- |
| 运行身份明确 | Host 统一解析 profile、账户、workspace/project/worktree；auth、Memory、skills、commands、MCP 显式消费这些来源。内部 session/input/run/tool-call ID 由系统产生，provider/客户端 ID 作为外部映射，避免记录串联 |
| 权限跟实际资源和操作绑定 | 先规范资源与命令，再计算政策；子代理、command、程序化调用只能收窄继承范围。审批 grant 绑定资源/环境/范围与政策版本，执行前复查当前撤销规则；snapshot 不承担权限兜底职责 |
| 一个 owner 仲裁可变状态 | Prompt、Stop、Steer、revert、归档、配置变更及资源释放遵守相同运行归属。未实现 attach 时，应明确拒绝冲突的第二个控制 Host；以后再接转发，不能让第二个 Host 显示操作成功却控制不到执行者 |
| 文件和副作用有版本 | 文件观察至少按 session/workspace/版本隔离；写入前核对观察版本，并协调同工作区并发变更。工具记录 distinguish started/completed/unknown；恢复检查外部效果，不盲重放 |
| 模型请求可解释、可收束 | 每次请求绑定实际模型、账户、规则/工具版本、最终输入与预算清单；保留现有流式闭合检查。统一 refresh、首响应/读空闲/总期限、取消和账户级限流，不靠适配器各自实现隐式规则 |
| 完成有证据 | 执行完成、产物存在、验证通过是不同事实；保留命令退出结果、文件版本和验证来源。用真实任务检验长任务、并行修改与恢复，而非以测试数量或模型一句完成代替能力验收 |

这些是现有模块需要共守的契约，不要求新建一组服务或包。Host 负责装配/身份/owner；core 负责会话和模型循环；policy/tools 负责操作授权与执行；store 保存事实；providers 做协议和认证适配；客户端提供输入与展示。

权限设计应明确三个维度：**允许访问哪些资源、哪些操作需要人确认、宿主实际如何限制执行。** 它们不能混成单个 full-access 开关。保留现有 deny 优先、无审批接口拒绝、一次性升级范围、子代理禁止沙箱逃逸。macOS Seatbelt 与其他平台的真实能力不同，应按能力生成契约；没有 sandbox 的平台不能仅凭权限模式名宣称已隔离。

### 其余边界的准确判断

- `chiliHome` 尚未贯穿 auth/Memory/skills，是已记录的配置身份缺口。权限 profile 当前为 Host/目录全局状态，设置页也明确说明；创建新任务会改变它，需要决定每次执行的有效策略及变更范围，不能误称已承诺独立 session 权限。
- grant 目前可在同 root 任务树继承，持久 grant 缺少在运行 Host 内的撤销生命周期。应明确 once/run/task-tree/project/user 的范围和方向；不是跨所有独立会话任意共享。
- skill 目录描述标为 `trust:tool` 却进入 developer，trust 当前主要是 debug 标签，见 [Host:982](../packages/host/src/host.ts:982)、[assembler:37](../packages/core/src/prompt/assembler.ts:37)。这是来源与指令权威不一致，未实测攻击效果，也不等于绕过执行器授权。
- 模型声明和执行时各自读取动态工具目录，缺少共同版本；变化时应重准备/明确报定义变更，并继续检查最新权限。当前执行器只有自定义 validate 才验证参数，MCP inputSchema 尚未自动成为统一运行时校验。
- HTTP runtime 当前是 trusted-admin API；Desktop IPC 有窗口/来源校验，手机 adapter 有 capability、工作区、generation、重放和敏感内容裁剪，且不开放审批。未来给受限客户端接 Host 前，需把可信 actor/grants 带入统一接口；不是现有手机越权漏洞，也无需现在构建多租户 IAM。
- HTTP/SSE 可继续使用。未来独立版本客户端需要 protocol/capabilities/instance 握手，协议不兼容应明确失败，不能无限当作网络抖动重试。换 gRPC 本身不能解决身份、权限或 owner。
- 保留已有 EOF/半截工具参数拒绝、仅无 assistant 输出时自动重试、持久 input 去重、lease/generation、未知效果恢复、SQLite 原子迁移与 Team 已验证产物。没有依据整套推倒。

### 全局复核的验证

新增三个相关测试组：权限/Host/snapshot/store **56 pass**；provider/流式/retry **104 pass**；durable input/recovery **30 pass**，均无失败。这些是回归检查；上表的新增问题由独立临时复现暴露，不能用原测试通过否定它们。

复现脚本：`/tmp/chili-permission-audit.ts`、`/tmp/chili-permission-audit-XXXXXX.ts`、`/tmp/chili-provider-id-audit.ts`、`/tmp/chili-provider-auth-audit.ts`、`/tmp/chili-global-file-observation-audit.ts`、`/tmp/chili-owner-audit.ts`、`/tmp/chili-process-audit.ts`。全部使用临时数据、假凭据/transport 或受控本地进程；无真实模型/服务调用、无真实凭据读取。临时脚本不是已提交回归测试，正式修复应将对应行为用例加入仓库。未修改运行代码。

## 决定

**在执行身份、权限和 owner 契约明确后，围绕上下文准备、工具执行、会话执行三条现有链路收敛。保留 Host、Runtime、SQLite 和已有任务保证，当前没有换语言或整套重写的证据。** 以下保留第一轮专项研究；最终实施顺序见本文末尾。

- Memory、Prompt、Context 属于共享 `core/store/host`，CLI、TUI、Desktop 均为入口；不能重新放回 CLI 私有代码。
- Prompt 是最终请求的组成部分；Memory 提供少量相关长期信息；Context 负责把规则、历史、工具、材料装成有预算、可追溯的实际请求。
- 工具执行保留公共审批、策略、快照、事件与输出存储，补齐类型化结果、统一校验及调度契约。
- 多智能体保留持久 Task/Run、lease/generation、共享限流与消息；统一首次执行、续跑和消息触发的执行入口。

## 已经完成、应继续复用

共享 Host 工厂、持久输入接纳和提交去重、后端 Queue/Steer/Stop、显式中断恢复已经在 dev 实现，不再列为待提取架构。见 [Host 当前边界](../packages/host/README.md)。

工具执行器、上下文预算/压缩、子代理、Team dispatch/worktree/verifier/merge 都有真实实现及行为测试。下面讨论的是各机制之间的契约缺口，不能把它们描述成空壳。

跨进程 owner 发现/attach 与独立常驻仍未实现。共享代码不等于共享执行实例；本次整理不改变这一边界。

## 参考范围及取舍

本次阅读本地固定快照，没有更新这些仓库或运行它们的故障实验。

| 参考 | 提交 | 值得借鉴 | 默认行为边界 |
| --- | --- | --- | --- |
| Codex | `67727e7cf114cf3e1b71db368d74b24e32f6cb12` | 项目指令独立管理；usage 锚点；压缩 checkpoint；子代理创建清理；CodeMode 回到公共工具运行时 | 该快照 memories 已标 Stable，但默认关闭；不照搬整个 App Server 与全部协作 API |
| DeepSeek Harness | `639ed015397290b3745d163aafe02ffee4aa3f84` | 指令按作用域发现；最终 prompt 变化入日志；计量后分级压缩；工具 prepare/dispatch/finalize 与程序结果分离 | 普通子代理与实验 Team 分开；Memory 文档为默认关闭的第三方 MCP 参考 |
| Pi | `028c0ec56ee237764af95a77522dd674e8cfe95c` | 命名 prompt sections；usage 加增量估算；压缩保持调用配对；CodeMode 复用工具调用入口 | 自动压缩默认开启；子代理为可选扩展示例；传统会话与实验持久宿主不能混称同一路线 |
| OpenCode | `2fa3363c924c5c3e367b84a87ae478296a0ed59b` | 小而明确的 task 语义、权限继承与深度约束 | 此快照背景 task 需实验开关；V1/V2 能力不混用 |

源码入口：Codex 的 `codex-rs/core/src/agents_md.rs`、`context_manager/history.rs:889`、`compact.rs:372`、`features/src/lib.rs:1175`、`core/src/tools/code_mode/mod.rs:402`；DSH 的 `packages/core/system-prompt/src/index.ts:612`、`core/agent-loop/src/agent.ts:404`、`core/tools/src/ptc.ts:538`、`context/agent-instructions/src/render.ts:275`；Pi 的 `packages/coding-agent/src/core/system-prompt.ts:120`、`compaction/compaction.ts:196`、`extensions/codemode/execute.ts:205`；OpenCode 的 `packages/opencode/src/tool/task.ts:96`。路径均相对上述相邻参考仓库。

官方 [AGENTS.md 文档](https://learn.chatgpt.com/docs/agent-configuration/agents-md)说明了项目指令的发现范围与合并顺序；[子代理文档](https://learn.chatgpt.com/docs/agent-configuration/subagents)强调隔离中间上下文、回传摘要，并指出并行写入需要处理冲突。这些支持职责划分，不是要求 Chili 照搬其产品策略。

## 1. Context/Prompt：优先形成真实请求的唯一准备入口

现状：[inspectPrompt](../packages/core/src/runtime-service.ts:959) 重新装配 prompt，得到的是预算和运行处理之前的视图；它不是历史上实际发给模型的完整请求。[normalizePromptItems](../packages/core/src/context/window.ts:957) 把材料拼成字符串后再截断；[truncateContextText](../packages/core/src/context/window.ts:625) 留头尾，丢失的可能是中间某份规则。项目规则的 `paths/alwaysApply` 已解析，但仍按 unconditional 注入，见 [documents](../packages/core/src/memory/documents.ts:41)。

建议在现有 core 内整理三个职责，不要求新增三个 workspace：

| 模块 | 职责 |
| --- | --- |
| Instructions | 按 workspace、cwd、目标路径解析适用规则，保留来源、内容版本和遗漏原因；从 Memory 中移出 AGENTS/CHILI/rules |
| Memory | 提供用户/项目范围内的相关长期条目；不承担会话恢复或覆盖项目规则 |
| Context preparation | 统一处理有效规则、工具集、历史、材料、预算和压缩，生成最终请求及来源清单 |

最终准备结果应包含 session revision、模型路由、规则/工具版本、实际模型输入及 included/omitted/truncated 清单。保存可稳定回放的内容或引用；不能只记文件路径，下次读到新文件就说那是旧请求。重试可复用同一准备版本；steer、模型/工具变化及压缩使版本失效。

预算借鉴 usage 锚点加新增材料估算，模型/请求结构变化时重新计量；覆盖工具 schema、图片与输出预留。按完整材料取舍，保留不同角色与信任来源，避免为了减少层数把一切提升为系统指令。

保留现有 compaction 的 source message IDs、边界和持久摘要；补齐压缩投影、checkpoint 与请求版本的一致性。压缩后恢复当前目标、未完成动作、有效规则和 tool-call/result 配对；失败不能破坏旧投影。

验收：fake provider 捕获的请求与记录一致；切模型、扩展 MCP schema、加入图片后重新预算；多次压缩、stop、重启后仍能追溯当前目标及未完成工作。Provider 做格式适配，不另起一套隐藏选材或截断。

## 2. Memory：简化语义，修复持久性

[entries](../packages/core/src/memory/entries.ts:15) 目前整文件读改写，没有跨进程协调；删除使用位置索引；新内容追加末尾，而 [documents](../packages/core/src/memory/documents.ts:75) 只取文件前段。[路径解析](../packages/core/src/memory/project-instructions.ts:14) 默认使用系统 home，Host 的 `chiliHome` 尚未贯穿 Memory。以上为源码确认的风险，本轮未制造真实丢更新事故。

建议一个权威事务存储：稳定 ID、scope、revision、来源与更新时间；复用 SQLite 能力。旧 Markdown 明确迁移并可导出，避免长期双写两份权威状态。用户级存储位置跟随 profile，项目身份与执行 cwd 分开。

先做可控的 list/get/search/put/delete 和有边界的相关性选择；暂不引入向量库、知识图谱或多级自动记忆。自动提炼可作为独立、可关闭、有来源的 writer，以后评估，不能成为恢复会话的前提。

验收：并发写不丢；更新/删除不因索引变化误操作；切 profile 不串记忆；长库能命中新条目；修改记忆不改变旧请求回放。项目规则更新与长期偏好更新有不同语义。

## 3. Tools/MCP：保留执行器，补真正可执行的契约

[ToolExecutor](../packages/tools/src/executor.ts:89) 已有查找、校验、策略/审批、快照、取消信号、事件及输出存储；[原生调度](../packages/core/src/single-agent-runtime.ts:968) 已区分安全并发和串行屏障。不能绕过它们直接调用 handler。

需要处理的现有问题：

- [MCP 并发推断](../packages/mcp/src/tool-adapter.ts:145) 把幂等当并发安全；两个不同值的幂等写入仍有顺序关系，应取消此推断。
- [参数校验](../packages/tools/src/executor.ts:241) 仅在有自定义 validate 时执行；携带 inputSchema 不等于统一做过运行时校验。
- 分类与执行两次解析可变 registry，且分类使用未校验参数；建议固定一个 PreparedCall，分类和执行使用同一工具版本及规范参数。此为设计风险，尚未动态复现。
- `shouldDefer/alwaysLoad/interruptBehavior` 只有声明和赋值；[registry](../packages/tools/src/registry.ts:45) 忽略 includeDeferred，[tool_search](../packages/tools/src/builtins/tool-search.ts:40) 只返回名称描述，尚无 schema 激活闭环。实现明确语义或移除无效承诺。
- 路径/执行策略依赖工具名称或 risk，见 [tool-policy](../packages/tools/src/tool-policy.ts:72)。扩展工具要提供受信任的 effect/resource 描述；不能把远端 annotations 当成权限证明。

[ToolResult](../packages/protocol/src/tool.ts:48) 当前以文本为中心。应区分程序使用的类型化结果及大对象引用、按预算生成的模型内容、展示/审计信息。模型预览截断不能改变程序计算数据；也不无限保存原始结果。现有完整文本输出落盘继续保留。

Host 还需完成 MCP connect/disconnect、断线状态、工具目录版本和认证能力；当前 Desktop manual 模式只加载配置，OAuth 返回 unsupported，见 [mcp-control](../packages/host/src/mcp-control.ts:518)。这属于底层能力，不依赖先做设置界面。

本次未找到 Chili 已接通的 CodeMode/PTC 执行路径。若后续增加程序化工具调用，作为公共执行器的新入口：父子调用身份、权限只收窄、取消并收束在途调用、资源限额、独占调用重入均要明确。用户此前说的“Code Model”含义尚未确定，不据此认定已要求实现 CodeMode。

验收：非法参数不进入 handler；幂等写保持顺序；模型截断不改变程序结果；不同入口同权限；取消后不再启动排队子调用；父子独占不死锁；MCP 重连后旧目录版本失效。

## 4. 多智能体：统一执行，保留可靠调度

已有 Task/Run、AgentTree/mailbox、完整 Team 工作流；[Host](../packages/host/src/host.ts:659) 默认全部装配。Team 本来就在共享子任务设施上，不是另一套完全独立引擎。dispatch intent、generation fencing、lease、共享 limiter、取消与崩溃修复应保留。

两个应优先收敛的真实接线：

1. 首次执行经 [AgentRunnerSubagentRunner](../packages/core/src/subagent.ts:1345) 自己跑 max-turn 和完成修复循环；follow-up 经 [task-control](../packages/core/src/task-control.ts:335) 进入 RuntimeService。应共用会话执行入口，统一上下文、计费、取消、工具策略；Task/Run 管调度身份，不再另持模型循环。
2. [delegationTurnActivity](../packages/core/src/runtime-service.ts:3077) 枚举工具名及别名、解析文本结果判断子任务状态。改为读取调度器产生的类型化生命周期事实；工具改名或未来程序包装不能改变任务完成语义。

委派策略与 reasoning 强度解耦，去掉 [ultra 隐式映射](../packages/core/src/delegation.ts:202)。授权和产品策略允许时仍可 proactive，不要求用户每次手工安排代理。

建议默认模型只接触创建/批量创建、查状态/等待、补充输入/消息和取消。Team DAG/verifier/merge 保留为显式启用的高级工作流；这是减少默认复杂度的产品取舍，不是把已有实现判成错误。mailbox claim/reconcile 等内部操作可由宿主处理。

同工作区写冲突与隔离 worktree 后的合并冲突要区别；当前重叠 writeScope 的保守阻断不是已证明的 bug。模型 verifier 的 `VERDICT: passed` 也不能等同命令/测试通过。Goal 预算是否覆盖整个代理树尚需明确契约。

验收：首次→follow-up→mailbox 的权限、上下文、取消和计费一致；配额满时父等子不死锁；旧 generation 不能写新终态；重启不重复投递结果、不盲重放未知副作用；不同 worktree 并行后验证失败/合并冲突不损坏主现场。外部工具不承诺恰好执行一次。

## 实施顺序

1. **修复已复现的一致性问题，建立身份与权限基线。** 内部调用 ID 与外部 ID 分离；文件观察按会话隔离并验证版本；规范资源后授权、审批重新检查政策、保留 command 空限制、修 shell scope；MCP 凭据与信任绑定目标；统一 profile 注入。可分支并行修复，不等待完整新框架。
2. **统一可变操作和副作用的执行归属。** 第二个控制 Host 在未 attach 时明确拒绝/路由，revert 遵守运行互斥；定义进程硬崩溃清理，补 provider refresh/取消/账户协调。首次任务、follow-up、mailbox 共用会话执行；所有工具经同一 PreparedCall/权限/调度/结果协议。保留原 Task/Run、输入队列和迁移保证。
3. **在统一执行链路上完善模型输入和长期工作能力。** PreparedRequest、工具目录版本与信任来源进入真实送模路径；接入可靠 Memory、压缩恢复和共享多代理上下文；用同模型真实任务验证效果，精简默认 Team 工具面。可与前两批并行实现独立部分，但能力验收依赖前述执行契约。
4. **再回 UI。** 此前桌面材料输入、成果入口和账号接入保留为产品待办；公共分发、微服务化、换语言和 gRPC 迁移不占本阶段主线。

不以增加 prompt、工具数量或 token 消耗验收。固定真实代码任务，在同模型、同参数下比较新旧 Chili：规则遵守、长任务续做、错误修改、工具结果追索、协作冲突、完成时间和必须转用其他产品的原因。

## 第一轮专项验证与边界

- 11 个相关测试文件：**280 pass，0 fail，1,394 次断言**。覆盖 prompt、compaction、Memory、工具审批/输出限制、subagent、Team dispatch/execution 和 mailbox 并发。
- `bun run smoke:p3-team-model`、`bun run smoke:p3-team-parallel`：通过。
- 同一 `e1733bb` 的前一轮已通过完整 typecheck 和 Host/持久输入/桌面相关 81 项测试，见 [进度报告](dev-progress-2026-10-03.md)。本轮未重复 typecheck。
- 没有运行完整 `bun test`、`smoke:all`、付费模型或参考仓库故障实验；现有测试通过不证明上述拟新增契约已具备。
- 三个子代理分别研究上下文/记忆、工具/MCP、多智能体；本轮仅修改架构记录，没有修改运行代码。
