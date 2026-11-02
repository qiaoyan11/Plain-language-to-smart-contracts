# 工作日志

老板（Jiahao Zhang）看这一个文件就能掌握进度。规则：
- Codex（ChatGPT）和 Claude 每完成一个大步骤，就在「日志」最上面加一条，用中文、白话、不超过 10 行。
- 「需要老板决定」那一行有内容时，先停下，等老板回复再继续。
- 审查意见写在根目录 `REVIEW.md`，这里只记结论。

## 分工

| 谁 | 负责目录 | 说明 |
| --- | --- | --- |
| Codex | `contracts/` `backend/` `frontend/` `agent1/` `agent2/` `agent3/` | 写功能代码 |
| Claude | `validation/` `REVIEW.md` | 写测试和评测（含 hidden tests、A/B/C 实验脚本），审查 Codex 的代码 |

不改对方负责的目录；需要对方改，就写进 `REVIEW.md` 或这里。共享接口（`shared/`、合约接口）改动前要在这里记一条决策。

## 已定决策

| 日期 | 决策 | 原因 |
| --- | --- | --- |
| 2026-11-02 | 技术栈留在 Node：Hardhat + solc-js + ethers；Slither 以命令行子进程调用 | 现有代码已能跑，不重写 |
| 2026-11-02 | 合约统一实现 `IMilestoneEscrow` 接口（见下），支持 1–5 个阶段 | Agent 2 生成的合约要能用同一套测试检查 |
| 2026-11-02 | 钱包签名、数据库、RAG 暂不做；先做评测需要的部分 | 课程按评测和可复现性打分 |
| 2026-11-02 | `TwoStageEscrow` 保留，作为固定对照 | 生成结果要有基线比较 |

### IMilestoneEscrow v1

```solidity
// constructor(address client, address payable provider, uint256[] memory amounts)
// 阶段编号从 1 开始；1–5 个阶段；每个金额 > 0；client 和 provider 非零且不同
interface IMilestoneEscrow {
    event Deposited(address indexed client, uint256 amount);
    event MilestonePaid(uint256 indexed id, address indexed provider, uint256 amount);
    function client() external view returns (address);
    function provider() external view returns (address);
    function totalAmount() external view returns (uint256);
    function milestoneCount() external view returns (uint256);
    function milestoneAmount(uint256 id) external view returns (uint256);
    function isPaid(uint256 id) external view returns (bool);
    function funded() external view returns (bool);
    function deposit() external payable;          // 仅 client，金额必须等于 totalAmount，只能一次
    function acceptMilestone(uint256 id) external; // 仅 client，已存款，按顺序，每个只付一次
}
```

退款规则暂不加，等基础版跑通后单独决定。

## 日志（最新在上）

### 2026-11-02 · Codex · 参数化里程碑合约与测试
- 做了什么：原样加入 IMilestoneEscrow v1，实现 1–5 个阶段的 MilestoneEscrow，阶段从 1 开始，按顺序且每阶段只付一次。
- 范围：保留 TwoStageEscrow、后端、前端不动；未修改 validation/ 和 REVIEW.md；npm test 已包含新测试。
- 怎么验证：npm test 24/24 通过（原有 7 项、新增 17 项）；npm run test:api 1/1 通过。
- 测试覆盖：1/2/3/5 阶段流程、非法构造参数、越权、金额错误、跳阶段、重复存付和拒收回滚；失败交易核对真实 status=0 回执。
- 提交与推送：审查意见及协作日志已先提交；GitHub 推送因本机未登录暂未完成，gh 已安装，等待老板完成登录。
- 下一步建议：Claude 审查新合约并开展 validation/；本轮不继续接前后端或做 Agent。
- 需要老板决定：无。

### 2026-11-02 · Claude · 审查本地两个 commit 和计划
- 做了什么：读了合约、后端、前端接入和测试；评估了 Codex 写的计划。
- 怎么验证：在本机运行 `npm test`（7/7 通过）和 `npm run test:api`（1/1 通过）。前端测试因本机 rolldown 环境问题没跑起来，不是代码问题。
- 结论：代码质量好，前端→后端→本地链确实接通。计划偏产品化，缺少课程要求的 A/B/C 实验和日期。详见 `REVIEW.md`。
- 下一步：Codex 推送代码、实现 `IMilestoneEscrow`；Claude 之后审查并开始写 `validation/`。
- 需要老板决定：无（技术栈和接口已按上表定下）。
