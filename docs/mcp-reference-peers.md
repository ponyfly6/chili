# 本地 MCP 参考核对（2026-09-07 14:42）

只读本地快照，未联网、未启动 app/provider、未修改项目。下述为机制借鉴，不把旧实现当作 MCP 2026 规范依据。

## 快照边界

- OpenCode `/Users/pony/Code/agent/codingAgent/opencode`，HEAD `55f984126c`；`packages/opencode/package.json:83` 固定 `@modelcontextprotocol/sdk: 1.29.0`。
- Gemini CLI `/Users/pony/Code/agent/codingAgent/gemini-cli`，HEAD `5411f113c`；`packages/core/package.json:34` 固定 SDK `1.23.0`。
- Chili `/Users/pony/Code/agent/codingAgent/chili/.worktrees/soak-20260907-integration`，本轮首次读取 HEAD `21baff1`；`packages/mcp/package.json` client/core `2.0.0`。期间 manager.ts 正在被主任务完善；最后读取的 refreshStateTools/Prompts 已有 signal 与 client identity 校验，不把它描述为完全没有隔离。
- OpenCode `packages/opencode/src/mcp/index.ts:38-49` 的 CLIENT_OPTIONS 注释掉 sampling、elicitation、tasks，仅启用 roots；`createClient:75-80` 配对 roots/list handler。
- Gemini `packages/core/src/tools/mcp-client.ts:1857-1874` 的 connectToMcpServer 仅显式注册 roots 并配 roots/list handler。搜索到的 Agent elicitation 类型不是 MCP 已实现的证据：`packages/cli/src/ui/hooks/useAgentStream.ts:303-310` 明确忽略 elicitation_request/response。

## 1. 能力声明与真实请求处理器成对注册

**参考入口**：OpenCode `packages/opencode/src/mcp/index.ts:38` CLIENT_OPTIONS、`:75` createClient；Gemini `packages/core/src/tools/mcp-client.ts:1838` connectToMcpServer，特别是 `:1857` registerCapabilities 和 `:1863` setRequestHandler。绝对根见上。

**机制**：只有实际处理的 roots 才声明；未实现 elicitation 不借 SDK 的类型名宣称支持。Gemini roots 目录监听在 `:1876-1899` 失败/close 时取消，并保留原 onclose。

**Chili 对应**：`packages/mcp/src/sdk-client.ts:82-95` createClient 默认 capabilities 空且 autoFulfill=false，方向正确；但 `:340-341` toSdkClientCapabilities 直接透传调用方能力，`packages/mcp/src/client.ts:12-15` 暴露 roots/sampling/elicitation，无配套 host handler。`docs/mcp-interactive-input-plan.md:3,20` 已规定首期只做 form，其他不声明。

**最小落地/验收**：form host bridge 就绪时才构造所支持的 elicitation capability；没有 bridge 的 default 和显式传参路径均不能宣称 roots/sampling/elicitation。以握手捕获验证声明，再发一条受支持表单请求验证进入对应 session/call 的真实输入队列；不支持 schema 明确失败。MRTR 与旧 elicitation/create 的两轮续调，仍以 Chili SDK2/计划为准，不能从参考仓库推导。

## 2. OAuth 作为独立、可取消、成功后提交的认证事务

**参考入口**：OpenCode `packages/opencode/src/mcp/index.ts:236` connectRemote、`:898-915` authenticate 回调、`:918` finishAuth、`:944` removeAuth；`packages/opencode/src/mcp/oauth-provider.ts:183` McpOAuthPendingProvider 和 `:212` commit；`packages/opencode/src/mcp/oauth-callback.ts:133` waitForCallback、`:149` cancelPending；`packages/opencode/src/mcp/auth.ts:89` getForUrl。

**机制**：普通连接的 onRedirect 是空操作 (`index.ts:263`)，401 分为 needs_auth/needs_client_registration (`:295-318`)，用户认证入口才打开浏览器。每次 callback 按随机 state 精确匹配；取消/超时删 pending 与 timer。新 tokens/clientInfo 先保留内存，finishAuth 成功后 commit；读取 token 同时核对服务器 URL，避免只按名字复用。Gemini `mcp-client.ts:1981-1990` 也默认提示 /mcp auth，只有显式 oauth.enabled 才自动认证。

**Chili 缺口**：`packages/mcp/src/config.ts:209` readOAuth 只解析配置；`sdk-client.ts:303-315` createSdkMcpTransport 没有 authProvider；`manager.ts:16` 状态只含 failed，无 needs_auth 分流。form elicitation 计划没有声称已经实现 OAuth，应该保持两个生命周期独立。

**最小验收**：初始化遇到401只出 needs_auth，不自行开浏览器；用户触发后两个 server 并发认证不串 state；取消后迟到 callback 无效；失败交换不覆盖旧 token；同名 server 改 URL 不携带旧 token。认证成功只重新建立连接与列表发现，不能把未知结果的 tools/call 自动重播。

## 3. 按 server 和目录类型合并 list_changed 刷新

**参考入口**：Gemini `packages/core/src/tools/mcp-client.ts:596` refreshPrompts（`:597-612` isRefreshing + pending 位 + 单循环，`:618-620` 传 AbortSignal）；`:497` refreshResources 使用同类合并；`:287` disconnect 先移除各 registry 中该 server 的条目，再断连。

**机制**：同一类型刷新只允许一个在途请求，期间再来通知仅标 pending，完成后最多补一轮；避免通知风暴并发多次 list 与旧结果覆盖新目录。借这个合并机制，不照搬其 500ms verification retry；这也不是 tools/call 自动重试授权。参考实现在 await 后的完整 epoch 防护不能假定充分，Chili 仍需自己的 ownership 检查。

**Chili 对应**：`packages/mcp/src/manager.ts:223` subscribe 当前每次 notification 都调用 refreshStateTools/Prompts/Resources。最后读取 `:271-289` 已按 client identity 与 signal 丢弃换连接结果，但同一 client 下多个刷新仍可能并发、逆序提交。计划 `docs/mcp-interactive-input-plan.md:10,18` 已明确迟到结果不能恢复断开的连接、不能自动重播工具。

**最小验收**：第一轮 list 挂起期间发送100条同类通知，只保留一在途+一补刷；受控逆序返回时目录最终是最新版本；断连/重连后旧代结果不能写入或发布 onToolsChanged；原 tools/call 请求计数始终不因目录刷新而增加。分 tools/prompts/resources 独立合并，避免一个慢目录阻塞其他目录。
