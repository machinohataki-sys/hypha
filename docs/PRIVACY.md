# 隐私

本地优先。这一段告诉你每一个字节去哪里。

## 留在本机的

- 你的目标、笔记、课程对话 transcript
- LLM API key
- 你上传的 PDF / Markdown / 文本
- 用量计数与成本账本
- 错题、考试历史、growth project spine
- Companion 状态、persona wisdom 蒸馏文件

存储位置：`vault/`（路径由你在首次启动时指定）。
schema 版本见各文件 frontmatter；migration 在 `app/scripts/_dev_migrate_*.js`。

## 会发给 LLM provider 的

- 当前一轮的对话消息（system + user + assistant 历史）
- 用到的资料片段（按 token budget 截）
- Goal Contract 字段（题目、目标、archetype）

发到哪：你在设置里选的 provider —— Anthropic / GLM / DeepSeek / Kimi。
各家按自己的 TOS 处理。Hypha 自己不持有这部分对话的服务端副本。

## 永远不会发的

- 你 vault 里其他课程的内容（除非你在当前轮显式引用）
- 错误日志、崩溃栈
- 用量统计、产品 telemetry
- 机器标识符、IP、地理位置

代码层证据：Hypha 没有 analytics SDK，没有 sentry，没有 mixpanel。`package.json` 依赖列表是完整可审计的。

## BYOK vs Trial

- **BYOK**（自带 key）：你的 key 调你自己的 provider 账户，Hypha 只做请求转发，零中间人
- **Trial**：用 Hypha 代付的额度（cashflow-shield 限 Pro ¥5/天 / Founders ¥10/天）。对话仍直发 provider，但请求经 Hypha 的 proxy 中转以鉴权 —— 这种模式下，proxy 日志只记 token 计数和成本，不存对话内文

切换：设置 → Provider → BYOK / Trial。

## 遥测

默认关。
没有"匿名使用统计"勾选项，因为根本没接收端。
未来若加，会以明确 opt-in 弹窗 + 可审计源码方式，不会默认开。

## Commons 包

你导出的 Knowledge Pack（`.hypha-pack`）默认 CC BY-NC 4.0。
内容由你决定 —— 导出前 `commons:pack-export` 会让你勾选哪些 lesson / 笔记进入包。
不会自动塞进任何你没勾的资料。

## 删除

- 删一门课：UI 上的删除按钮，或直接删 `vault/<slug>/` 目录
- 删全部：删 vault 根目录
- 没有"云端删除"按钮，因为没有云端
