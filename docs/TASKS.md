# 四人协作与第一批任务

当前共同起点：网页、Node 后端和 1–5 阶段参考合约已跑通。Python 模拟模块和 Node 连接已实现；Agent 2 已接通生成、独立验证和有限修复；网页已接确认和生成结果；其余 Agent 和正式评测尚未完成。先读 [接手说明](TEAM_HANDOFF.md)。本轮先把模块接起来，不重写前后端，不加入钱包、退款、RAG 或数据库。

每人先按 [运行说明](FRONTEND_INTEGRATION.md) 完成创建、部署、存款、付款。之后读 [模块交接 v1](../shared/INTERFACES.md)。A/B/C 是待认领岗位，不是已确认的成员姓名。

## Jiahao — 集成及后续 Agent 3

- 目录：frontend/、backend/、agent3/；协调 shared/，与 B 协调 flows/。
- 分支：feature/python-bridge；后续 feature/agent3。
- 当前已完成：generation.cjs 提供确认、版本管理、异步运行和查询接口，复用 python-bridge.cjs；详见 [生成 HTTP 接口](../shared/GENERATION_API_V1.md)。
- 网页已接入：持续对话草稿、版本确认、生成查询和最终结果；刷新不重复启动模型。下一项任务：接真实 Agent 1，把描述可靠地变成待确认规则；AI 部署另立任务。
- 交付：能发送样例并显示生成结果或明确错误；原有手写合约演示仍能运行。第一轮不部署 AI 生成代码。
- 后续任务：Agent 3 仅提出操作意图，Node 核对并在用户确认后执行。不是重做一套交易系统。

## 组员 A — Agent 1

- 目录：agent1/；分支 feature/agent1-python。
- 第一项任务：Python 的 clarify 输入描述，输出 draftSpec、问题和不支持的条款。
- 交付：独立运行方式、至少三个样例（完整描述、缺少金额、不支持退款）及模块测试。
- 边界：不猜缺失规则，不替用户确认，不改网页或合约。需要页面变化时交给 Jiahao 集成。

## 组员 B — Agent 2 与生成修复图

- 目录：agent2/、flows/；分支 feature/agent2-python。
- 当前已完成：SourceBundle 生成、可信开发验证、A/B/C 反馈筛选、有限修复和停止路径。下一项任务：与 C 固定正式样例集和实验预算，再按已定规则扩展合约能力。
- 交付：Python 依赖及版本、固定入口、独立运行样例、失败处理测试。先 maxRepairs=0，接好 C 的开发验证报告后再测试有限修复。
- 边界：不覆盖参考合约，不修改独立验证工具和测试，不读取 hidden 结果调提示词；不提交 API key。
- 与 Jiahao 配合：复用 flows.worker 和 flows/generation.py，不另建流程入口；网页接入复用已有 Node 侧调用。两人不各自设计另一套入口。

## 组员 C — 独立验证与实验

- 目录：validation/；分支 feature/validation，由 C 与 Claude 协调，避免同时修改同一文件。
- 当前已完成：validate_development 的编译、静态检查、开发条款测试；工具缺失返回 toolError。下一项任务：准备正式样例和独立留出评测。
- 交付：报告样例、独立运行方式、版本化通过标准，给 B 的开发反馈格式。
- 后续任务：对照 proposal 落实 A/B/C 反馈定义、统一修复预算和 visible/hidden 拆分。三种条件使用相同模型及测试条件，保留失败案例。
- 隔离：hidden 由 C/Claude 独立维护，不发给 B，也不通过生成图的工具或日志泄露。

## 合并顺序

1. 所有人先复现共同版本；确认认领岗位。
2. A 用样例开发，B 做一次生成，C 做开发验证适配；Jiahao 对接唯一入口。
3. 合并“规则 → 单次生成 → 检查”，再合并有限修复；生成结果暂不自动部署。
4. 后续再接自然语言页面与 Agent 3。上线另立任务，不混进这批。

每项 PR 包含输入、输出、运行命令、测试结果和限制。main 保持可演示；个人分支提交，不等所有模块写完才集成。contracts/ 和 tests/ 是共同基线，修改需单独说明。shared/ 变动先记 WORKLOG 决策；REVIEW.md 和 validation/ 仍按 AI 工具分工由 Claude 负责，Codex 不修改。
