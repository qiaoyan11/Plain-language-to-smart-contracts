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
| 2026-11-02 | 前后端项目接口升级为 v2：milestones 数组、wei 整数字符串、acceptMilestone 加 milestoneId；合约 v1 不变 | 接入已验证的 1–5 阶段合约，避免浮点金额和固定两阶段字段 |

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

### 2026-11-02 · Codex · 网页接入 1–5 阶段合约
- 做了什么：创建页可增减阶段和填写金额；确认页、付款按钮、余额及交易记录都改为读取阶段列表；后端部署 MilestoneEscrow。
- 金额处理：前后端统一用 wei 整数字符串，网页按十进制显示 ETH；总额由后端重新计算，不接受客户端伪造的总额。
- 接口：新增 shared/PROJECT_API_V2.md；旧两阶段 HTTP 字段不再兼容，重启后需新建项目；合约接口与 TwoStageEscrow 未改。
- 怎么验证：合约 26/26、接口 5/5、前端 7/7 通过，前端类型检查和构建通过。
- 页面验证：三阶段项目部署、存款、逐阶段付款、刷新均成功，18 位小数正确保留，最终余额为零。
- 范围：未改 validation/ 和 REVIEW.md；未加入钱包、数据库、RAG 或 AI；本地服务重启仍会重置测试记录。
- 下一步建议：确定 Agent 2 的规则输入和验证反馈格式，再接生成与有限次数修复；Claude 按既定分工实现验证工具。
- 需要老板决定：无。

### 2026-11-02 · Codex · 完成审查 2 的限定修复
- 做了什么：先原样提交 Claude 的审查及日志；补强制转入 0.01 ETH 后仍禁止未存款付款的测试。
- 测试改进：关键拒绝场景先用 staticCall 检查具体错误名，再保留真实 status=0 回执和状态不变断言。
- 合约改动：仅把 MilestonePaid 事件移到外部转账前；另补恶意收款方回调导致整笔回滚的测试。
- 怎么验证：npm test 26/26 通过（原 24 项加 2 项）；npm run test:api 1/1 通过；转账失败时事件也不残留。
- 范围：未改 validation/、REVIEW.md 内容、接口、旧合约、后端和前端；本轮修复完成后停止。
- 下一步建议：Claude 按既定分工做 validation/；Codex 下一步将前后端接到参数化合约，支持填写 1–5 个阶段及 wei 金额。
- 需要老板决定：无。

### 2026-11-02 · Claude · 审查 commit 5628888（参数化合约）
- 结论：通过。接口和 WORKLOG v1 逐行一致；合约规则全部正确实现。
- 怎么验证：本机运行 `npm test` 24/24、`npm run test:api` 1/1，与 Codex 报告一致；又往合约里故意注入 12 个 bug，测试抓到 11 个。
- 漏掉的 1 个：删掉"必须先存款"检查后测试仍通过，因为测试只看"失败了"、不看"为什么失败"。建议加一个强制转入 ETH 的测试（中等，不阻塞）。另有 2 个低优先级建议。详见 `REVIEW.md` 审查 2。
- 下一步：Codex 修 M-1 和 L-1；Claude 开始 `validation/`（Slither 封装 + 不依赖实现的条款测试）。
- 需要老板决定：无。

### 2026-11-02 · Codex · 参数化里程碑合约与测试
- 做了什么：原样加入 IMilestoneEscrow v1，实现 1–5 个阶段的 MilestoneEscrow，阶段从 1 开始，按顺序且每阶段只付一次。
- 范围：保留 TwoStageEscrow、后端、前端不动；未修改 validation/ 和 REVIEW.md；npm test 已包含新测试。
- 怎么验证：npm test 24/24 通过（原有 7 项、新增 17 项）；npm run test:api 1/1 通过。
- 测试覆盖：1/2/3/5 阶段流程、非法构造参数、越权、金额错误、跳阶段、重复存付和拒收回滚；失败交易核对真实 status=0 回执。
- 提交与推送：审查意见及协作日志已先提交；老板完成 GitHub 登录后，全部本地提交已推送到 origin main，合约提交为 5628888。
- 下一步建议：Claude 审查新合约并开展 validation/；本轮不继续接前后端或做 Agent。
- 需要老板决定：无。

### 2026-11-02 · Claude · 审查本地两个 commit 和计划
- 做了什么：读了合约、后端、前端接入和测试；评估了 Codex 写的计划。
- 怎么验证：在本机运行 `npm test`（7/7 通过）和 `npm run test:api`（1/1 通过）。前端测试因本机 rolldown 环境问题没跑起来，不是代码问题。
- 结论：代码质量好，前端→后端→本地链确实接通。计划偏产品化，缺少课程要求的 A/B/C 实验和日期。详见 `REVIEW.md`。
- 下一步：Codex 推送代码、实现 `IMilestoneEscrow`；Claude 之后审查并开始写 `validation/`。
- 需要老板决定：无（技术栈和接口已按上表定下）。
