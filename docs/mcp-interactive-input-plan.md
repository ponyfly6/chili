# MCP 交互输入：下一步实现边界

2026-09-07 的 SDK v2 迁移保留 `inputRequired.autoFulfill: false`。下一步优先做 form elicitation 的单调用闭环；不要全局开启自动补充输入。

## 实现顺序

1. **携带调用身份。** `packages/mcp/src/tool-adapter.ts` 到 `manager.ts`、`sdk-client.ts` 目前主要传递 signal。输入队列需绑定 server、sessionId、callId、轮次；SDK 合成的请求 ID 仅是 `inputRequests` 的键，并行调用可以重名，不能作为全局身份。
2. **复用输入生命周期并扩表单类型。** `packages/tools/src/user-input.ts` 的 requested/resolved/cancelled 事件与队列可复用，但现有 `string[]` 答案不足以表达数字、布尔值和嵌套表单。先定义支持的 schema 子集、字段与字节上限，再做类型校验和 UI。确认表单不授予工具或系统权限。
3. **控制协议续调。** 每次有效 `input_required` 只创建该调用当前轮的输入请求。接受后，原样回传 `requestState`，按协议提交当前轮答案。仅最终 complete 结果进入成功工具结果；用户拒绝与取消分别保留。调用级手动循环可以维持身份和轮次上限，避免全局 handler 对不同请求串线。
4. **贯通取消。** 用户取消、任务终止、超时与断连必须取消队列和底层请求；迟到答案不能续调。manager 的超时入口需传递 AbortSignal，操作结束移除监听器和计时器。刷新列表/初始化的迟到结果不能恢复已失败或关闭的连接。

## 必须通过的验收

- 现代 MRTR 与旧版 `elicitation/create` 各完成至少两轮；每轮替换答案而非无条件累加，最终结果通过 schema 验证。
- 并行同名输入、重复提交、项目切换和迟到回答不会串调用或重复续调。
- accept、decline、cancel 分流正确；不支持的 schema、过量输入、超额轮次均明确失败。
- 总时长、轮次、字段数及字节数有界；成功、失败、取消后没有遗留队列、计时器或监听器。
- 只有有效 `input_required` 允许协议续调。网络错误、认证失败、接收超限、显式终止，以及重启后的未知结果，都不能自动重播原工具调用。

sampling、roots、URL elicitation、持久化交互恢复，以及 prompts/resources 的交互可后延。先不对外声明这些能力。

依据为本地 SDK 2.0.0 实现及其[官方迁移指南](https://github.com/modelcontextprotocol/typescript-sdk/tree/main/docs/migration)。本文件是后续实现计划，不代表这些交互能力已经启用。
