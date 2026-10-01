# Codex MCP 本地实现核对（2026-09-07，只读）

参考仓库 /Users/pony/Code/agent/codingAgent/codex，HEAD 728cb12fe5794b0c3a8e776fb4994b1650b973a8（2026-09-03）。本次检查的 rmcp-client/codex-mcp 路径无未提交改动。Chili 检查工作树 /Users/pony/Code/agent/codingAgent/chili/.worktrees/soak-20260907-integration。没有运行参考仓库测试、联网或改动任何源码；下面测试是仓内已有证据，非声称本轮执行通过。

## 快照确实有 2026 实现，但非默认全开

- codex-rs/rmcp-client/src/protocol_mode.rs:8，McpProtocolMode：Legacy 默认；V20260728 映射 ClientLifecycleMode::Auto，preferred 2026-07-28、legacy fallback 2025-06-18。stdio_mode:36 还要求 CODEX_MCP_PROTOCOL_VERSION 显式 opt-in。
- codex-rs/rmcp-client/src/rmcp_client.rs:815，call_tool 在协商确认为现代协议时调用 service.call_tool，多轮输入由现代 SDK 生命周期驱动。
- codex-rs/rmcp-client/tests/mcp_2026_mrtr.rs:219，modern_tool_mrtr_drives_form_and_url_elicitation_and_preserves_metadata，服务返回 input_required/inputRequests/requestState，后续请求断言原 opaque requestState 与客户端输入 metadata；:477 覆盖 resources/read；:652 覆盖只有 state 的多轮。并非只修改版本字符串。
- codex-rs/rmcp-client/tests/mcp_2026_stdio.rs:30，exercise_stdio_server 覆盖 local/executor launcher、modern/legacy、真实 discovery 与一次输入回合。

## 值得借鉴的三项最小机制

1. 输入响应令牌由 host 产生，并只指向一个存活请求。
   - Codex codex-rs/codex-mcp/src/elicitation.rs:88 ElicitationRequestRouter 明确 thread 共享 router、不同 runtime 可复用同一服务端 request ID；:371 生成 host public_request_id；:432 用 (server, routed ID) 注册 oneshot；:106 PendingElicitationRequest::drop 删除 responder。注意这里 event.turn_id 实为 None，不能声称 Codex 在本层已做完整 turn 绑定。
   - Chili packages/mcp/src/sdk-client.ts:92 当前 inputRequired.autoFulfill=false；packages/mcp/src/tool-adapter.ts 承接工具调用。未来 bridge 应保存 project/session/server/connectionEpoch/call/inputRequestId/requestState，而 UI 仅拿 opaque host token；断开或调用取消即销毁 responder，禁止迟到输入落到重连的新调用。
   - 最小验收：两项目/同名server/相同服务端request ID并发；取消A只清A；重连后迟到A回复无效；B继续；opaque requestState逐字节保留。不要直接自动开启交互。

2. 每个连接的启动与发布有独立取消作用域和身份。
   - Codex codex-rs/codex-mcp/src/connection_manager.rs:519 为每个server创建 child_token；:597 publication_gate.wait 后才启动/发布；:620 完成后再次检查取消。codex-rs/codex-mcp/src/rmcp_client.rs:303 ManagedClientStartup::start，对make client设startup deadline，:382 or_cancel包住整个startup。connection_manager.rs:922 call_tool 还核对expected environment_id。
   - Chili packages/mcp/src/sdk-client.ts:70/128/152 已有connectionEpoch防旧initialize回写；packages/mcp/src/manager.ts:166 connectState / :195 disconnectState / reload是下一层归属入口。未来在manager上保持同一连接epoch与shared connect promise，防旧catalog刷新或旧startup完成重新发布已经断开的server；项目身份在边界核验，不单凭同名server。
   - 最小验收：A慢initialize、B正常；disconnect/reload A后释放旧barrier，不得再connected或发布旧tools；B不受影响；A新epoch只启动一次。

3. 交互等待与执行时间分账，取消仍贯穿整次调用。
   - Codex codex-rs/rmcp-client/src/rmcp_client.rs:188 ElicitationPauseState 引用计数；:217 guard Drop恢复计时；:228 active_time_timeout只扣active时间。elicitation_client_service.rs:96 create_elicitation 持pause guard等待输入。connection_manager.rs:947 对server/caller timeout取最小值。rmcp_client.rs:1405 is_retryable_tools_list_error仅允许tools/list transient retry，避免把普通tools/call错误自动重放。
   - Chili packages/mcp/src/manager.ts:138 callTool及withTimeout、sdk-client.ts:182 callTool为对应入口；root本轮正在修复deadline向transport传递，不应再加并行方案。未来启用输入bridge后，把用户思考时间暂停，取消/断连仍即时清理；失败绝不能用重新tools/call冒充继续requestState。
   - 最小验收：100ms执行预算+等待输入1秒仍可继续；等待期间Abort立即终止且迟到输入不发请求；恢复后剩余执行预算耗尽会终止；500/断链的mutating tools/call只发送一次。

## 取消证据边界

已核实Codex启动or_cancel、输入router Drop清理、active-time timeout，以及event stream的send_cancellable_request（rmcp_client.rs:926）。本次未追进rmcp依赖证明所有普通tools/call取消都会发送线上的cancel消息；不要把Rust future被丢弃等同于远端副作用已撤销。Chili最终应保留真实HTTP/stdio假server的线上取消与单次调用门禁，这是本轮root正在处理的范围。
