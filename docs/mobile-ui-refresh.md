# 手机 UI 更新验收（2026-10-08）

本轮将手机控制页改为任务列表、对话、底部输入区和独立连接页，使用现有生产客户端与桌面控制链路。连接和执行结果来自真实 API；任务仍由电脑上的同一个 runtime 执行。

## 已实现

- [Workspace](../apps/control-web/src/Workspace.tsx)：任务搜索与切换、用户和助手消息、最近消息跟随、统一发送按钮及 Queue/Steer 选择面板。Stop 保持独立操作，不随发送中的状态锁定。电脑与连接页提供重新连接、断开和确认忘记设备。
- [PairingView](../apps/control-web/src/PairingView.tsx)：分别呈现原生 App 的电脑地址及恢复流程、浏览器的临时授权流程，并显示等待桌面确认的实际配对状态。
- [QuestionSheets](../apps/control-web/src/QuestionSheets.tsx)：从任务中的问题入口打开 HTML `dialog` 问题面板，通过 `session.answerInput` 提交完整答案。关闭面板保留本次问题的选择和文字；草稿按任务与问题身份区分，题目变化或失效后不能沿用旧答案。
- [对话状态](../apps/control-web/src/conversation-state.ts)：输入草稿按任务保存在内存中，切换任务不会丢失。提交回执仅清除原任务中仍与已提交文字一致的草稿，保留之后的新编辑。送达结果未知时保留独立待核对提醒，禁止自动重发。
- 原生 App 重开后，先恢复有效设备身份，再读取当前授权任务列表；只有仍在列表中的最近任务才自动打开。`localStorage` 仅保存绑定 `hostId`、`deviceId` 的 `sessionId` 导航元数据，不保存授权、消息或草稿。设备恢复身份继续使用原生安全存储。
- [视口处理](../apps/control-web/src/use-app-viewport.ts)：使用实际可见视口的高度和偏移固定页面，并为问题面板提供相同的边界；必要时仅滚动输入框所在的内部容器。原生 `contentInset: never` 由 CSS 统一处理安全区。对话在已读到末尾时跟随视口变化，阅读旧消息时保留位置。

## 真实能力边界

手机仅能读取桌面当前工作区已授权的既有顶层任务、有限消息快照，发送 Queue/Steer、Stop，以及回答可安全投影的普通模型问题。工具输出和内部事件不进入手机消息；归档任务只读。任务创建、工作区切换、审批、权限或凭据修改、MCP 表单仍在电脑完成。

发送要求当前任务快照可用、读取没有报错，且没有待处理的问题或桌面审批。手机没有公网 relay、推送、后台运行保证或离线任务缓存；电脑须保持运行，原生 HTTPS 使用正常证书验证。授权撤销、桌面重启和工作区切换的边界沿用既有协议。完整范围见 [私网手机验收说明](private-mobile-alpha-acceptance.md) 与 [手机 App 说明](../apps/mobile/README.md)。

## 本轮验证

| 检查 | 结果 |
| --- | --- |
| `bun test` | 最终 2990 通过、0 失败，292 个文件，24848 个断言 |
| `bun run typecheck` | 全工作区通过 |
| `bun run smoke:all` | 5/5 组通过 |
| `bun run --cwd apps/desktop typecheck:e2e` | 手机和远控 E2E 脚本类型检查通过 |
| 控制页定向测试 | 61 个测试、326 个断言通过，包含键盘视口几何回归 |
| `bun run mobile:sync` | 视口、问题面板和对话跟随修正后，手机页面构建与 Capacitor 同步通过 |
| iOS `App` 模拟器构建 | Xcode 27.0、同一独立构建目录、ad-hoc 签名；最终重建及严格签名检查通过 |
| 模拟器更新 | 仅更新已有一次性 `Chili Mobile QA`（iOS 26.5）中的 `dev.chili.mobile`；组件 fixture 检查完成后已重新安装并启动最终生产 App，确认无 fixture 入口或资源；未清除数据、Keychain 或证书信任 |

全库测试、类型检查、smoke 日志位于 `apps/desktop/out/mobile-ui-2026-10-08/` 的 `bun-test-final.log`、`typecheck-final.log`、`smoke-all.log`。本轮原生本机临时证据位于 `/tmp/chili-mobile-ui-20261008.ULDfma/`：最终生产记录为 `sync-production-final.log`、`simulator-build-production-final.log`、`signature-production-final.log`、`install-production-final.log`、`launch-production-final.log` 和 `production-assets-check.log`；此前的构建与组件 fixture 日志也保留。生产 App 位于其 `DerivedData/Build/Products/Debug-iphonesimulator/App.app`。

浏览器中的真实组件 fixture 已在 393×852 和 320×568 检查任务切换与独立草稿、问题关闭后恢复选择、提交中的状态与问题移除、自由文本、多问题窄屏布局、审批与断线时禁发、未知结果提醒、Queue/Steer、配对等待与恢复；未见控制台错误或警告。另验证 393×852 缩至 393×500 时仍跟随末尾，阅读旧消息时调整高度保留滚动位置。这些检查使用示例数据，没有运行真实 HTTPS 操作链路。

原生模拟器生产配对页已验证设备名称输入框在软件键盘上方可见，收起键盘后表单与连接按钮恢复。对话和自由文本问题在独立 App 副本中的真实组件 fixture 验证：对话输入区与发送按钮、问题输入框与提交按钮均位于软件键盘上方；输入中文后问题提交按钮启用。原生坐标点击工具间歇报错，因此问题键盘检查使用无障碍键盘路径及屏幕候选字。截图位于 `apps/desktop/out/mobile-ui-2026-10-08/` 的 `native-keyboard-after.jpg` 和 `native-question-keyboard-after.jpg`；检查完成后已恢复生产 App。

桌面 E2E 的[手机导航辅助代码](../apps/desktop/e2e/phone-navigation.ts)已适配实际任务、连接、发送方式和问题面板，保留原有安全、未知结果、独立 Stop 和项目隔离断言。**本轮未重跑真实浏览器端到端场景、原生 XCTest 或物理手机场景。** 物理手机已安装版本未更新；此前版本的真机结果不能代表本次 UI 更新。组件 fixture 与原生键盘视觉检查不代表真实传输、后台恢复或完整交互链路通过。
