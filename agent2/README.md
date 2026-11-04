# Agent 2 — 生成、独立检查、有限修复

输入已确认的付款规则，模型生成 Solidity；程序直接调用 Claude 的独立验证器，重新编译、跑 Slither 和条款测试。检查通过才返回 validated；失败则按明确预算修复，工具故障立即停止。不会自动部署。

## 安装和运行

先确认 `python3 --version`：锁文件要求 Python 3.11 或以上（排除 3.12.0），建议用已实测的 3.14.3。
在仓库根目录，使用相同解释器创建 `.venv`（没有则先 `python3 -m venv .venv`）：

```sh
npm ci
.venv/bin/python -m pip install -r requirements.lock.txt
npm run test:validation
npm run test:agent2
```

锁文件包含 Slither 0.11.3、crytic-compile 0.3.11 及其依赖；不需要另装原生 solc。
本轮在 Mac、Python 3.14.3、Node 20 上验证。Claude 的验证工具支持 Mac/Linux。
`OPENAI_API_KEY` 只放本机 `.env` 或环境变量，不能提交。

```sh
# 原有单次生成＋编译检查，不运行独立验证
.venv/bin/python -m agent2 --live agent2/examples/generate.request.json

# 生成＋完整独立验证；B 设置，最多修复一次（最多两次收费调用）
.venv/bin/python -m agent2 --live agent2/examples/development.request.json

# C 设置：在 B 的基础上，允许失败的开发条款测试进入修复反馈
.venv/bin/python -m agent2 --live agent2/examples/development-c.request.json
```

样例确认记录是虚构测试数据，不代表网页用户点过确认。模型固定为
`gpt-5.4-mini-2026-03-17`，reasoning=medium、单次输出上限 8192 tokens。
没有网络重试；输出不完整或拒答也会停止，并保存已返回的用量。

## A/B/C 怎样区分

| 设置 | 模型能收到的修复反馈 | 修复次数 |
| --- | --- | --- |
| A | 无；仍运行完整验证并保存结果 | 必须为 0 |
| B | 失败的编译、静态检查及其 findings | 显式 maxRepairs |
| C | 同 B，另外包含失败的开发条款测试及其 findings | 与 B 使用相同预算 |

所有设置都跑同一完整开发验证器。反馈筛选只决定模型能看见什么，不改变通过标准。
B 如果只剩条款失败，会停止并返回 failed / no_eligible_feedback，不泄露条款失败详情给模型。
达到预算仍失败就返回 failed。即便报告总体写 failed，只要其中任一检查是 toolError，也停止并返回 toolError。
静态分析沿用 `slither-block-high-medium-v1`：High/Medium 阻断，无例外。

实现允许 0–5 次修复；5 是防止误配置的运行上限，不是正式实验预算。本轮样例预算为 1。
正式实验仍需固定数据集、模型、B/C 预算和留出评测；这里没有实现整套评测。
`validationMode=none` 只允许 A/baseline、零修复，结果最多为 generated。

## 保留原始结果并继续演练

```sh
.venv/bin/python -m agent2 --live \
  --resume-run artifacts/agent2/20261104T014714Z-682e1fa6 \
  agent2/examples/development.request.json
```

此命令读取旧源码，在新目录重新验证，再按新请求预算修复；要求规则和确认记录完全一致。
旧目录不修改，旧报告不作为本次验证证据。以上例子最多发一次新模型请求。
这是诊断续跑，不算从头开始的正式 B/C 样本；旧 A 结果仍保持原样。
对已有版本试用条款反馈时，可将上面的请求换成 `agent2/examples/development-c.request.json`，并把 --resume-run 指向要修复的运行目录；仍最多一次新模型调用。
历史演练仅通过 clause-v1；升级后的 clause-v2 已捕获收款合约兼容性退化，两个旧版本均 failed；随后一次 C 条款反馈修复出现接口类型编译错误，也已停止，尚未部署；详见 [验证与修复记录](../docs/AGENT2_VALIDATION_RUN.md)。

## 输出和模块入口

每次 live 调用（CLI 或 worker）分配新的 `artifacts/agent2/<时间-唯一编号>/`，不提交 Git：

- `request.json`、`response.json`：输入和最终标准交接结果。
- `run.json`：每轮源码、报告、提示词版本、实际反馈、模型用量及停止原因。
- `events.jsonl`：逐步追加模型输出、源码和验证结果；中途停止也保留已有记录。
- `validation-report.json`：最后一次可信工具报告；`compilation.json` 是编译检查结果。
- `GeneratedMilestoneEscrow.sol`、`IMilestoneEscrow.sol`：最后源码及固定接口。
- `origin.json`、`summary.json`：续跑来源、摘要与部署状态；本入口的运行均标为非正式实验。

`attempts` 记录产生源码的轮次，`modelCalls` 还记录未产出源码的失败调用，防止漏算用量。
提示词与源码都是本地记录，可能包含业务信息，不自动公开。

| 文件 | 作用 |
| --- | --- |
| prompts.py | 原始生成与修复提示词；不读取参考实现或验证测试源码 |
| model.py | 一次 Responses API 请求，模型只能返回 source |
| compiler.py | 保留旧编译 smoke 路径 |
| ../flows/generation.py | LangGraph 编排、可信验证调用、预算、反馈隔离 |
| records.py | 每轮输出保存到新目录 |
| service.py | 供 worker 调用的 generate(payload) |
| stub.py | 原来的模拟交接，供离线连接测试 |

`python -m agent2` 不带 --live 时为模拟；worker 默认也为模拟，显式 `AGENT2_MODE=live` 才接真实入口。
Node 连接等待时间：模拟 10 秒、编译 smoke 210 秒；development 每轮最多 900 秒，按 1+maxRepairs 计算，上限 6 轮。
这是外层保护时间，不代表实际耗时；同项目仍有并发锁及进程组清理。
网页尚未调用此入口。后续部署只能取通过报告的 artifact，不能用模型声称的成功或旧 smoke 编译产物。

当前只覆盖 1–5 阶段付款。退款、取消、期限、OpenZeppelin 依赖、Agent 1/3 和网页 AI 接入仍是后续工作。

## 过往项目参考

参考 [AgenticsFintekColumbia/smart-contracts](https://github.com/AgenticsFintekColumbia/smart-contracts)
的生成—检查—反馈思路，未复制其代码或提示词。沿用本项目 LangGraph、solc-js、Slither 和独立条款测试。
