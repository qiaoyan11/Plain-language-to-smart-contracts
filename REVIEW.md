# REVIEW.md — 独立审查（Claude，2026-11-02）

审查对象：本地未推送的两个 commit（`3e8fc0f`、`210c773`）和《从基础托管流程到三个 Agent 协作的最终版本》计划。
方式：不信任文档描述，自行读代码并运行测试。

## 已核实

| 项 | 结果 |
| --- | --- |
| `npm test`（contracts，node:test + Hardhat 内置链） | 7/7 通过 |
| `npm run test:api`（HTTP 生命周期） | 1/1 通过 |
| 前端 → 后端接通 | 是。`frontend/vite.config.ts` 把 `/api` 代理到 `127.0.0.1:3001`；`client.ts` 在非 mock 模式下走 `request()` |
| 文档与代码一致 | `docs/LOCAL_DEMO.md`、`docs/FRONTEND_INTEGRATION.md` 描述准确 |
| 浏览器端到端 | 未由我复现（文档声称已验证；API 测试覆盖了同一路径，可信度高） |
| `cd frontend && npm test` | 在审查环境失败：rolldown 原生绑定与平台不匹配，是环境问题，不是代码问题 |

代码质量方面做得对的地方：自定义 error、`immutable`、checks-effects-interactions 顺序、用 `throwOnTransactionFailures:false` 拿到真实的 status=0 回执来测试 revert、测试了收款方拒收时的状态回滚、后端拒绝非本机 Origin、同一项目并发操作用 `busy` 锁。

## 问题（按严重程度）

### 高

**H1. 两个 commit 没有推到 GitHub。** 组员看到的仍是空骨架。建议立即 `git push origin main`（或推到 `feature/local-escrow` 再开 PR）。

**H2. 计划偏离了课程评分点。** 计划是一份产品路线图（开源应用、钱包、数据库、RAG），而课程按评测、grounding、失败分析、可复现性打分，proposal 的核心实验是 A/B/C 三种修复信号的对比。计划第 26 节的评估没有这个对比，也没有 visible/hidden 测试拆分。
建议：把 proposal 的实验设计写回计划，作为阶段三的完成标准；所有"产品化"项（钱包、数据库、RAG）排在评测之后。

**H3. 没有日期。** 计划说"不是固定日期"，但课程有硬截止：12/1–4 CA meeting 2、12/6 slides+视频、12/16 报告代码。建议每个阶段挂一个截止周。

### 中

**M1. 浏览器钱包（MetaMask）签名被放在主线（阶段四）。** 工作量大、不加分、demo 还要录钱包弹窗。建议：评测和 demo 都用 `.env` 里按角色区分的测试网私钥服务端签名，用户在界面上点 yes 后才发送；钱包作为有余力时的加分项。

**M2. 数据库迁移与备份（阶段一第四步）过重。** 一个 `data/projects.json` 文件足够。链重置时标记旧部署失效这一条保留。

**M3. 修复上限建议两轮（第 18 节）太少。** 作为实验要看修复曲线，建议 N=3–5，三种设置相同。

**M4. 技术栈需要现在定。** 当前是 Node + Hardhat + solc-js + ethers；proposal 写的是 Foundry/Anvil/Slither + Langflow。两条路都可以，但不能并存。
- 留在 Node：Agent 用 LangChain.js 或直接 SDK tool-calling；Slither 以 CLI 子进程调用（它本身是 Python 包，`pipx install slither-analyzer` 即可）。优点：后端不重写。
- 换 Python：FastAPI + web3.py + LangGraph，Hardhat 只保留做编译和测试。优点：课程生态（Langflow、CrewAI）和 Slither 都在 Python。缺点：`backend/server.cjs` 要重写。
审查者倾向留在 Node，理由是已经能跑；最终由项目负责人决定并写进 README。

**M5. 合约 ABI 不可参数化。** `approveFirst/approveSecond` 写死两阶段，Agent 2 生成的合约无法复用同一套测试。计划第 8 节已经列了参数化合约，补充要求：先冻结接口再写合约，建议
`constructor(address client, address provider, uint256[] amounts)`、`deposit()`、`acceptMilestone(uint256 id)`、`milestoneCount()`、`milestone(uint256 id) view`。所有生成合约实现同一接口，测试用 `amounts` 参数化。

### 低

**L1. `frontend/src/api/client.ts`** 仍 import 写死的 `STAGES`、`TOTAL_ETH`，金额用浮点 + `round()`。接 Agent 1 前要改成从 project 读 `milestones[]`，金额用 wei 字符串。后端 `snapshot()` 里 `escrowBalance: Number(formatEther(wei))` 同理，保留 `escrowBalanceWei` 即可，前端用它显示。

**L2. `backend/server.cjs`** 只接受两个 demo 账户。本地阶段合理，但到 Sepolia 要换成按角色读 `.env` 的私钥。

**L3. `artifacts/TwoStageEscrow.json`** 是编译产物却被提交了。为了可复现可以留，但要在 README 说明它由 `npm run compile` 生成。

**L4. 计划第 16 节"先做模板化生成"。** 作为 baseline 是对的，但要明确：模板是 baseline，不是 Agent 2 的最终形态。如果 Agent 2 只填模板参数，"为什么要用 agent"就答不上来。

## 建议的下一步（按顺序）

1. push 当前两个 commit。
2. 定技术栈（M4），写进 README。
3. 冻结 `IMilestoneEscrow` 接口（M5），写参数化合约 + 参数化测试，用现在的 `TwoStageEscrow` 当第一个对照。
4. 前端 v0.5（L1）。
5. 再开始 Agent 2，并直接按 A/B/C 实验设计搭修复循环。

## 协作方式

分工、已定决策和每一步的记录见 `docs/WORKLOG.md`。简要：Codex 写功能代码（合约、后端、前端、三个 Agent）；Claude 写 `validation/`（clause tests、hidden tests、Slither 封装、A/B/C 评测脚本）并审查。写 Agent 2 的一方不用 hidden 结果调 prompt，评测才站得住。
