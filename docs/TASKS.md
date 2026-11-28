# 四人协作与第一批任务

2026-11-26 已确定先完成当前 v1 演示，再推进 v2 和模型微调。2026-11-19 的[灵活合同架构规划](FLEXIBLE_CONTRACT_ARCHITECTURE.md)保留为后续设计，新版条款能力尚未实现。

当前共同起点：真实 Agent 1 已接入网页，Node 保存对话草稿；用户明确确认后进入既有 Agent 2 生成、独立验证及有限修复流程，通过后可显式本地部署，再由 Agent 3 提出操作并汇报回执。手写参考演示仍保留；正式模型评测仍待完成。先读[接手说明](TEAM_HANDOFF.md)和[完整 v1 演示](AGENT1_DEMO.md)。本轮完善现有流程，不加入钱包签名、退款、RAG 或数据库。

每人先按[完整 v1 演示](AGENT1_DEMO.md)完成描述、澄清、确认、生成、部署、存款、付款；安装步骤见[运行说明](FRONTEND_INTEGRATION.md)。之后读[模块交接 v1](../shared/INTERFACES.md)。A/B/C 是待认领岗位，不是已确认的成员姓名。

## Jiahao Zhang — 集成和 Sepolia

- 目录：frontend/、backend/；协调 shared/，与 B 协调 flows/。
- 张嘉豪负责 Sepolia 测试网接入、测试钱包签名，以及部署、存款和验收付款的公开回执验证。
- 分支：feature/python-bridge。
- 当前已完成：drafting.cjs 保存 Agent 1 对话和草稿版本，新增 `/api/drafts` 系列接口；明确确认后复用 generation.cjs 的版本、确认与异步生成流程。见[演示及草稿接口](AGENT1_DEMO.md)和[生成 HTTP 接口](../shared/GENERATION_API_V1.md)。
- 网页已接入：真实澄清、规则摘要、明确确认、生成查询、本地部署和 Agent 3 操作；刷新只恢复服务端状态。下一项任务：完善 v1 完整流程的联调和失败恢复记录；Sepolia 仍是后续任务。
- 交付：能发送样例并显示生成结果或明确错误；原有手写合约演示仍能运行。生成项目和参考演示各有自己的部署入口。

## Xiangyi Zhu — Agent 3 操作规划与交易汇报

- 目录：agent3/；接入 backend/、frontend/ 时与 Jiahao 协调。
- 分支：feature/agent3、feature/agent3-integration。
- 当前已完成：Agent 3 提出操作意图（query、deposit、acceptMilestone），并根据交易回执汇报结果；详见 [agent3/README.md](../agent3/README.md)。
- 边界：Agent 3 仅提出操作意图，Node 核对并在用户确认后执行。不是重做一套交易系统。

## 徐露源 Luyuan Xu — Agent 1

- 目录：agent1/；分支 feature/agent1-python。
- 当前已完成：`service.py` 的 `draft_agreement` / `clarify` 接入可配置模型服务，整理付款草稿、追问缺项并保留超范围条件及独立链下原文；已通过 Node 草稿接口接入网页。
- 下一项任务：按[追问流程和六个验收场景](../agent1/README.md)核对真实模型的完整、缺失、矛盾和跨轮回答，记录错误后再整理微调数据。模块替身测试通过不等于真实模型效果达标。
- 边界：不猜缺失规则，不替用户确认，不改网页或合约。需要页面变化时交给 Jiahao 集成。

## 组员 B — Agent 2 与生成修复图

- 目录：agent2/、flows/；分支 feature/agent2-python。
- 当前已完成：SourceBundle 生成、可信开发验证、A/B/C 反馈筛选、有限修复和停止路径。下一项任务：与 C 固定正式样例集和实验预算，再按已定规则扩展合约能力。
- 交付：Python 依赖及版本、固定入口、独立运行样例、失败处理测试。早期先做 maxRepairs=0 的接通演练；当前网页流程已接 C 的开发验证，固定 C 反馈、最多 3 次修复。
- 边界：不覆盖参考合约，不修改独立验证工具和测试，不读取 hidden 结果调提示词；不提交 API key。
- 与 Jiahao 配合：复用 flows.worker 和 flows/generation.py，不另建流程入口；网页接入复用已有 Node 侧调用。两人不各自设计另一套入口。

## 组员 C — 独立验证与实验

- 目录：validation/；分支 feature/validation，由 C 与 Claude 协调，避免同时修改同一文件。
- 当前已完成：validate_development 的编译、静态检查、开发条款测试；工具缺失返回 toolError。下一项任务：准备与开发、训练材料分开的正式评分样例。
- 交付：报告样例、独立运行方式、版本化通过标准，给 B 的开发反馈格式。
- 后续任务：对照 proposal 落实 A/B/C 反馈定义、统一修复预算和 visible/hidden 拆分。三种条件使用相同模型及测试条件，保留失败案例。
- 隔离：hidden 由 C/Claude 独立维护，不发给 B，也不通过生成图的工具或日志泄露。

## 原始合并顺序（历史计划）

以下记录最初的分阶段接通安排，当前上述 v1 本地流程已集成。接下来先完善 v1 并记录真实运行结果，再安排微调及 v2 扩展；后续 Sepolia 工作不属于本轮本地演示。

1. 所有人先复现共同版本；确认认领岗位。
2. A 用样例开发，B 做一次生成，C 做开发验证适配；Jiahao 对接唯一入口。
3. 合并“规则 → 单次生成 → 检查”，再合并有限修复；生成结果暂不自动部署。
4. 本地生成项目已接自然语言操作页面和 Agent 3。后续推进 Sepolia 测试网和钱包签名。

每项 PR 包含输入、输出、运行命令、测试结果和限制。main 保持可演示；个人分支提交，不等所有模块写完才集成。contracts/ 和 tests/ 是共同基线，修改需单独说明。shared/ 变动先记 WORKLOG 决策；REVIEW.md 和 validation/ 仍按 AI 工具分工由 Claude 负责，Codex 不修改。
