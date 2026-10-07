# 智谱 BigModel 国内接入

核对日期：2026-10-07。`zhipu` 是国内 BigModel；原有 `zai` 继续表示国际 Z.ai。目录按厂商归在一起，连接身份、密钥、地址和价格独立。

配置 `ZHIPU_API_KEY`（或 `BIGMODEL_API_KEY`），选择 provider `zhipu`。默认模型为 `glm-5.3`；也收录 `glm-5.3-flash` 和 `glm-5.3-flashx`。`ZHIPU_MODEL` / `BIGMODEL_MODEL` 可覆盖模型。旧 `glm` 别名和 `glm-*` 自动识别仍指向 `zai`，国内接入应明确选择 `zhipu` 或 `bigmodel`。

默认使用按量 API 地址 `https://open.bigmodel.cn/api/paas/v4`。使用 GLM Coding Plan 时，将 `ZHIPU_BASE_URL`（或 `BIGMODEL_BASE_URL`）设为 `https://open.bigmodel.cn/api/coding/paas/v4`，并配置对应套餐的密钥。团队套餐密钥与其他平台密钥不通用。这里使用 Chat Completions 协议；不要填 Responses 或 Anthropic 地址，也不会自动切换到按量 API。[官方接入说明](https://docs.bigmodel.cn/cn/coding-plan/tool/others)

GLM-5.3 为文本模型；Flash / FlashX 在 Chili 中开放文本和图片输入。官方另有视频、文件能力，但 Chili 当前消息协议未开放这些输入。三款采用 1M 上下文与 128K 输出限制，推理始终开启；Chili 的关闭选项映射为 `low`，中间强度归一为 `low` / `high` / `max`。FlashX 当前不在 Coding Plan 套餐内。[GLM-5.3](https://docs.bigmodel.cn/cn/guide/models/text/glm-5.3)、[Flash / FlashX](https://docs.bigmodel.cn/cn/guide/models/vlm/glm-5.3-flash)

模型价格是国内按量 API 的人民币参考价，每百万 tokens：

| 模型 | 输入 | 输出 | 缓存命中 |
| --- | ---: | ---: | ---: |
| GLM-5.3 | 8 | 28 | 2 |
| GLM-5.3-Flash | 0.8 | 2.8 | 0.23 |
| GLM-5.3-FlashX | 2 | 7 | 0.57 |

缓存存储当前限时免费，套餐额度不以此表结算。更新时单独核实国内价格，不能复制国际 Z.ai 美元价格。[官方价格](https://docs.bigmodel.cn/cn/guide/start/pricing)

维护范围：`domestic-models.ts` 保存模型事实与兼容参数；`domestic-config.ts` 保存国内环境变量和 provider 定义；`domestic-provider.ts` 组装公共协议适配器。推理上下文和工具流必须保留；新增模型先核实这些协议要求。[深度思考参数](https://docs.bigmodel.cn/cn/guide/capabilities/thinking)

未收录的自定义模型仅启用基本文本请求，默认输出请求额度为 4,096 tokens，不继承旗舰模型的上下文、图片或推理能力。需要扩展能力时，应先通过模型目录注册准确的描述信息。

验证命令：`bun test packages/providers/src/vendors/zhipu/domestic-provider.test.ts`。测试使用假传输验证请求、工具流、图片、取消和密钥边界，不消耗真实 API 配额。
