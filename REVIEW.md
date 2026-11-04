# REVIEW.md

最新审查在最上面。

---

## 审查 3：Agent 2 首次生成结果的独立验证（commit `d6582f1`，运行 `20261104T014714Z-682e1fa6`）· Claude · 2026-11-03

**结论：failed。** 编译 passed、条款测试 23/23 passed；静态分析按 `slither-block-high-medium-v1` 判 failed，
唯一阻断项是 Slither `uninitialized-local`（Medium）。报告：`artifacts/agent2/20261104T014714Z-682e1fa6/validation-report.json`
（reportId `val-eac2985275504647bec91587c0e99c9d`），明细在同目录 `validation-evidence.json`。

### 核实了什么

| 项 | 结果 |
| --- | --- |
| 被测对象 | 运行目录里的 `response.json` 的 SourceBundle；其 `GeneratedMilestoneEscrow.sol` 与目录中的同名文件逐字相同。未用手写合约替代 |
| sourceHash | 重算 = 声明值 `sha256:e4b5be20…a7e2` |
| 编译 | solc-js 0.8.28 / paris / optimizer 200 重新编译，无诊断；构造函数与冻结接口一致。重新编译的 bytecode 与 Agent 2 自报一致（只作记录，不参与判定） |
| Slither 0.11.3 | 2 条：`uninitialized-local` Medium（阻断，`GeneratedMilestoneEscrow.sol` 第 25 行 `uint256 sum;`）；`low-level-calls` Informational（不阻断） |
| 条款测试 | 23/23 通过，在 Hardhat 本地链部署本次重新编译的 bytecode |
| 验证器自测 | 13/13 通过；15 个注入缺陷全部被对应条款抓住；Slither 缺失、版本不符、崩溃均返回 toolError |
| 未受影响 | `npm test` 26/26、`npm run test:api` 5/5、交接 Python 18/18 |

### 需要处理

**V-1（需要老板决定）静态分析阻断规则。** 当前规则：High/Medium 全部阻断，无例外。
`uninitialized-local` 在这里其实无害（Solidity 局部变量默认是 0），但它是 Medium，按规则就阻断。
- 选项 A（建议）：保持严格。改一行 `uint256 sum = 0;` 即可通过；B/C 设置的修复循环正好能拿 Slither 反馈练手，规则也简单、好解释。
- 选项 B：把 `uninitialized-local` 列为不阻断，升级为 `slither-block-high-medium-v2`。本次生成结果会因此通过。
规则一旦用于正式实验就不能再改，否则 A/B/C 结果不可比。

**V-2（Codex，选项 A 时必做）手写参考合约在同一规则下也失败。** `contracts/MilestoneEscrow.sol` 第 31 行同样是 `uint256 sum;`，
用本验证器检查：编译 passed、条款 23/23 passed、静态分析因同一条 Medium 失败。作为 A/B/C 的基线，参考合约应当 0 阻断。
修复：改为 `uint256 sum = 0;`，重跑 `npm test`。

**V-3（Codex）Agent 2 接入。** 见下节；另请把 `validation/requirements.txt`（Slither）并入安装说明或锁文件，
并在 `package.json` 加 `"test:validation": "<python> -m unittest discover -s validation/tests -t ."`。
这两处文件不归 validation/，本轮未改。

**V-4（信息）运行环境。** 本轮在已连接的 Linux 环境（Python 3.10、Node 22.23）运行；Mac 上的 `.venv` 在该环境不可用，
建议老板在 Mac 上跑一次 README 里的安装和自测命令确认。

### Agent 2 如何调用

在 `flows/generation.py` 的编译节点之后（`validationMode == "development"` 时）：

```python
from validation import validate_development
report = validate_development(spec, source_bundle)      # 直接调用，不经模型
# result['validationReport'] = report；attempts[-1]['reportId'] = report['reportId']
# status: report passed -> 'validated'；failed -> 进入修复或 'failed'；toolError -> 'toolError'，停止，不当作代码缺陷
```

- 修复反馈按设置筛选：B = `compilation` + `staticAnalysis` 的 findings；C = 再加 `clauseTests` 的 findings。A 不修复。
- 部署只认本函数返回的 `passed` 报告，并部署报告里的 `artifact.bytecode`，不用模型或 Agent 2 自己的编译产物。
- `clause-v1` 是开发测试；留出评测另设入口，不得进入提示词。

---

## 审查 2：commit `5628888`（IMilestoneEscrow v1）· Claude · 2026-11-02

**结论：通过。** 有 1 个中等问题（测试会误判通过），建议下一步顺手修，不阻塞后续工作。

### 核实结果

| 检查项 | 结果 |
| --- | --- |
| `contracts/IMilestoneEscrow.sol` 与 WORKLOG v1 对照 | 逐行一致（事件、9 个函数、签名、注释） |
| `contracts/MilestoneEscrow.sol` 规则 | 1–5 个阶段、仅 client、精确单次存款、按顺序、不重复、转账失败整体回滚，全部正确实现。先改状态再转账；provider 无法重入（`onlyClient`） |
| `npm test` | 24/24 通过（原 7 + 新 17），与报告一致 |
| `npm run test:api` | 1/1 通过，与报告一致 |
| 失败交易是否断言真实回执 | 是。`rejectedReceipt()` 要求 `CALL_EXCEPTION`、有 receipt、`status === 0`、无残留 log；`rejected()` 还比较前后完整状态快照 |
| Mutation testing（往合约注入 12 个 bug） | 抓到 11 个，漏 1 个（见 M-1） |

注入的 bug 及结果：去掉 accept/deposit 的 onlyClient、允许多付、允许重复存款、不检查顺序、转账失败不回滚、付错金额、允许 6 个阶段、允许金额为 0、id 越界差一、允许 client==provider，全部被抓到。**去掉"必须先存款"的检查，测试仍全部通过。**

### 中

**M-1. 测试只检查"失败了"，不检查"为什么失败"，导致"必须先存款"这条规则实际上没被测到。**
- 位置：`tests/milestone.test.cjs` 第 150–160 行（funding is required…），以及第 52–63 行 `rejected()`。
- 原因：未存款时合约余额为 0，`acceptMilestone` 转账必然失败，以 `TransferFailed` revert。所以把 `MilestoneEscrow.sol` 第 69 行的 `!funded ||` 删掉，交易照样 revert，测试照样通过。正常情况下没关系，但有人用 `selfdestruct` 强行转入 ETH 后，未存款的合约就能付款。
- 影响：之后 Agent 2 生成的合约也会用同类测试检查，这种"原因不对但也失败了"的情况会被误判为符合条款。
- 修复建议（任选其一，最好都做）：
  1. 加一个强制转入 ETH 的测试（已在审查环境验证：原合约通过，删掉检查的变异体失败）：
     ```solidity
     // 测试辅助合约
     contract Force { constructor(address payable to) payable { selfdestruct(to); } }
     ```
     部署 escrow → 用 `Force` 转入 0.01 ETH → 断言 `acceptMilestone(1)` 仍然 revert（status 0）且 `isPaid(1) == false`。这种方式不依赖错误名，以后可以直接用于检查生成的合约。
  2. 对本仓库自己的合约，在发送交易前用 `staticCall` 断言错误名，例如
     `await assert.rejects(c.acceptMilestone.staticCall(1), e => e.revert?.name === 'InvalidState')`。注意：生成的合约错误名不固定，这种断言只适合参考合约。

### 低

**L-1. `MilestonePaid` 事件在外部调用之后才发出**（`contracts/MilestoneEscrow.sol` 第 73–74 行）。
功能上没问题（转账失败时事件一起回滚）。但 Slither 的 `reentrancy-events` 预计会报这一条，而 Slither 告警数是报告指标之一，参考合约最好是 0 告警。建议把 `emit` 挪到 `call` 之前。（审查环境未装 Slither，待 Claude 在 `validation/` 接入后核实。）

**L-2. 没有测试恶意收款方回调（重入）的情况。** 当前合约因为 `onlyClient` 是安全的，属于可选补充：收款合约在 `receive()` 里回调 `acceptMilestone`，断言整笔交易回滚。

### 信息（不需要修）

- 没有退款路径，client 永不验收时资金锁死。合约注释和 WORKLOG 已写明，按计划之后单独决定。
- origin/main 已在 `42266f3`，推送已完成。

---

## 审查 1：本地两个 commit 和计划 · Claude · 2026-11-02

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
