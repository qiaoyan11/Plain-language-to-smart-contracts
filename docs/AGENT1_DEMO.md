# 从描述到付款的本地演示

本轮沿用现有 v1 合约。客户一次足额存入测试 ETH，按顺序确认 1–5 个阶段，每个阶段只向约定服务方支付一次。Agent 1 负责描述与追问，Agent 2 负责生成、独立检查及有限修复，Agent 3 负责读取状态、提出操作并核对回执。

## 本轮参考的交互

| 产品 | 可以借鉴的交互 | 本演示的应用 |
| --- | --- | --- |
| [Ironclad](https://legal.ironcladapp.com/fy2026-product-descriptions) | 结构化启动问题与条件流程 | 用户继续对话，同时看到付款草稿和未解决事项 |
| [Juro](https://juro.com/product-updates/september-2026) | 合同摘要展示状态及下一步 | 确认前集中展示规则、来源与待解决项，避免把一长串聊天当作最终约定 |
| [Escrow.com](https://www.escrow.com/milestones/how-it-works) | 把阶段金额、交付与验收分开呈现 | 明确区分生成、部署、存款和验收付款，每次资金操作单独确认 |

以上仅为交互参考。我们继续使用现有代码与合约能力，未引入这些产品的账户、付款服务或法律条款。

## 启动

安装步骤沿用 [前端运行说明](FRONTEND_INTEGRATION.md)。在本地 `.env` 设置 `OPENAI_API_KEY`，不要把值提交到 Git，也不要贴进聊天。Agent 1 可单独设置 `AGENT1_BASE_URL`、`AGENT1_MODEL` 和 `AGENT1_API_KEY`，用于符合接口要求的模型服务。尚未实际测试的本地模型不能声称已兼容。

在仓库根目录启动后端。

```sh
AGENT1_MODE=live AGENT2_MODE=live AGENT3_MODE=live npm run backend
```

在 `frontend/` 目录启动网页。

```sh
npm run dev
```

打开 `http://127.0.0.1:5173/`。三个 live 开关分别启用对应模型调用。未开启 Agent 1 时，页面说明助手未开启，不会返回模拟理解结果。手写参考演示仍在 `/reference-demo`。

## 走一次流程

1. 输入一段英文或中文服务描述。也可以粘贴下方示例，再由真实 Agent 1 处理。
2. 在消息下方查看 Agent 1 的回复，先回答当前这一问。每个成功回合会保留在对话里。当前链使用本机两个测试账户，可以把钱包逐个补齐，也可以使用页面的测试账户按钮。
3. 查看阶段、金额、钱包与原文。遇到退款、期限或自动付款等超范围条件时，草稿停留在待处理状态。用户在真实谈妥变更后才能明确提出新约定。
4. 核对钱包、金额，并查看首期付款后的余额。当前合约只有顺序付款功能。客户一直不批准时，余款可能永久锁定。勾选确认后，服务端创建项目及确认记录。
5. 在项目页启动生成。Agent 2 的编译、Slither 与开发条款检查由现有工作流执行，失败按预算修复或停止。
6. 通过后点击本地部署。用存款按钮预览金额和去向，确认后再发送交易。存款成功后，用首期验收付款按钮核对收款钱包并确认。也可以继续在 Agent 3 的对话框请求操作。
7. 查看实际合约地址、余额、每个阶段状态及交易回执。使用本机模拟链，无公共浏览器链接。

聊天中的说明和独立链下义务不自动成为链上条件。页面将链下原文与付款字段分开显示。部署代码只执行用户已确认、当前系统能够表达的 v1 付款规则。

中文演示可以直接输入这段话，先留空双方钱包。

> 项目叫「工作室官网」。我是客户，请一位开发者做网站，总价 0.01 测试 ETH，由我一次存入。首页符合设计稿、经我验收后付 30%；整站通过约定的下单测试、经我验收后付 70%。两期按顺序支付。

11 月 27 日的本地浏览器实测中，Agent 1 先问客户钱包，收到回答后才问服务方钱包。Agent 2 第二次生成的版本通过了 24 项付款条款测试。确认存入 0.01 测试 ETH 后，点「验收第 1 阶段并支付」，核对服务方地址，再点「确认验收并支付」。刷新后，首页款 0.003 已付，整站款 0.007 待付，托管余额为 0.007 测试 ETH。

| 本地区块 | 页面交易记录 |
| --- | --- |
| 2 · 足额存入 | `0x713e82676b7a7dfea8b636ed0430fb551023a721059c68f9ba01d8826778ea52` |
| 3 · 验收并支付第一期 | `0x9ba56969d7ce5c523c5e1cec5c8b0cf5a238075f56128b07cd923861b3b73da0` |

也可以用英文开始。

> Project: Studio website. The total budget is 0.01 test ETH. I deposit the full amount once. Pay 30% for the homepage matching the agreed mockup, then 70% for the complete website passing the agreed checkout tests. Only the client approves payments, in that order. There are no deadlines, refunds or automatic acceptance. I will provide both wallet addresses next.

模型追问后，点击 **Use local test accounts**，查看新增的地址消息与付款摘要，再进入 **Review agreement**。本轮实际执行的模型及回执见[运行记录](DEMO_RUN_2026-11-26.md)。

## 草稿保存和错误处理

服务端保存草稿版本、全部用户消息及完整的 Agent 1 结果。浏览器只保存当前草稿 ID，刷新时重新获取服务端结果。后端重启会清空项目与本机链，正式持久化仍是后续工作。

发送失败时保留待处理消息和旧草稿，并阻止使用旧的“可以确认”状态继续。重试使用同一个请求标识。确认成功但响应丢失时，重新读取或重试会返回同一个项目，不重复创建。确认后的对话封存，修改约定需要新建草稿，旧项目及链上交易保持原记录。

## 开发接点

Node 在 `backend/drafting.cjs` 保存对话状态，通过已有 `flows.worker` 调用 Agent 1。`backend/server.cjs` 提供 HTTP 入口。页面只调用 `frontend/src/api/client.ts`。草稿就绪后由服务端构造付款项目，再调用既有 `generation.confirm`。Agent 2 与 Agent 3 使用原来的后续流程。

| 请求 | 输入 | 输出 |
| --- | --- | --- |
| `GET /api/drafts/context` | 无 | 是否启用真实澄清、本机测试账户 |
| `POST /api/drafts` | 空对象 | 新草稿会话 |
| `GET /api/drafts/:id` | 草稿 ID | 当前版本、用户消息、结果、忙碌状态及失败消息 |
| `POST /api/drafts/:id/messages` | `message`、`expectedRevision`、`requestKey` | 更新后的会话 |
| `POST /api/drafts/:id/confirmation` | `approved=true`、`expectedRevision` | 当前规则对应的项目与确认记录 |

`ClarifyResult` 仍保留既有四个必填字段，增加可选 `separateTerms` 字符串数组，用于透传原文中的独立链下约定。旧 fixture 仍然合法。Node 和 Python 都核对响应，Node 为草稿及项目分别管理版本。草稿版本与最终项目的 `specVersion` 是不同计数，`draftOrigin` 保存二者来源关系。

## 接着做什么

先用固定样例记录真实模型的提取错误和完整流程结果，再整理训练数据与独立评分数据。更换微调模型只应改变推理适配器，不能同时悄悄修改确认规则、合约接口或验证标准。

Agent 1 已有可配置模型服务入口。Agent 2 和 Agent 3 当前仍使用既定 OpenAI 接口，后续替换本地模型需单独补适配与测试。不同验收规则、超时领取、退款与结算按[灵活合同规划](FLEXIBLE_CONTRACT_ARCHITECTURE.md)逐步实施。Sepolia 尚未包含在本轮本地 demo 中。
