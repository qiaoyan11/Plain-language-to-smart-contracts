# Agent 2 — 单次生成已接通

当前能做：读取确认后的规则 → 调用 GPT-5.4 mini 生成 Solidity → 本机编译 → 保存源码、错误和用量。
这条顺序由真实的 LangGraph 管理。尚未接独立条款验证和自动修复，结果不能自动部署。

## 跑一次真实生成

在仓库根目录，先安装 Node 依赖与 `requirements.lock.txt` 中的 Python 依赖，
将 `OPENAI_API_KEY` 放在本机 `.env` 或环境变量中。不要提交 key。

```sh
npm ci
.venv/bin/python -m pip install -r requirements.lock.txt
.venv/bin/python -m agent2 --live agent2/examples/generate.request.json
```

每次 `--live` 发起一次收费请求，无自动重试。默认样例是虚构的已确认两阶段规则，不是网页真实用户的确认记录。
模型固定为 `gpt-5.4-mini-2026-03-17`；reasoning=medium、输出上限 8192 tokens。
当前只接受 A 或 baseline、maxRepairs=0、validationMode=none，其他组合在调用模型前拒绝。

结果保存在 `artifacts/agent2/<UTC时间-唯一编号>/`，该目录不提交 Git：

- `GeneratedMilestoneEscrow.sol`：本次模型实际生成的代码。
- `IMilestoneEscrow.sol`：程序附加的固定接口，模型不能改它。
- `request.json`、`response.json`：输入和标准交接结果。
- `compilation.json`：编译结果、诊断和编译产物；不是独立 ValidationReport。
- `run.json`：提示词版本、实际提示词、模型版本、token 用量和耗时。
- `summary.json`：便于阅读的结果摘要。

即使编译通过，标准交接状态也仅为 `generated`，validationReport 仍为 null。
编译失败为 failed；网络、配置或编译工具错误为 toolError。拒答/输出不完整会停止并保留已返回的用量。
模型没有部署、文件操作、执行命令的权限；源码只由固定本地 solc 工具编译，未配置文件或网络 import 回调。

## 各文件作用

| 文件 | 做什么 |
| --- | --- |
| prompts.py | 根据确认规则和公开接口构造提示词；不读取参考合约实现或独立测试 |
| model.py | 一次 Responses API 请求、输出解析及用量记录；不记录 key 或请求头 |
| compiler.py | 调用固定 Node 编译工具，区分编译错误与工具错误 |
| service.py | 暴露 generate(payload)，供现有 worker 调用 |
| ../flows/generation.py | LangGraph：检查输入 → 生成 → 打包 → 编译 |
| stub.py | 保留原有模拟实现，供离线连接测试 |

模型只能输出一个 source 字段。项目 ID、版本、编译设置、源码指纹和状态由程序管理。
`__main__.py` 不带 `--live` 时仍跑模拟入口。worker 默认也为 stub；只有启动进程显式设置
`AGENT2_MODE=live` 才用真实实现。不要在普通连接测试中开启 live。
Node bridge 的 live 默认超时为 210 秒（原 stub 为 10 秒）；网页尚未调用此入口。

## 测试与下一步

```sh
npm run test:agent2
npm run e2e
```

Agent 2 测试使用受控模拟回复和真实编译器，不调用收费 API。首次真实调用记录见 [结果说明](../docs/AGENT2_FIRST_RUN.md)。
下一步接验证负责人提供的 validate_development，再实现有限修复。
Proposal 的 A=不修复，B=编译器+Slither 反馈，C=再加开发条款测试反馈；B/C 用相同修复预算，留出测试不得进入反馈。
当前只有单次生成能力，不是完整 A/B/C 实验。

范围仍是现有付款子集。Proposal 的退款、取消、期限及 OpenZeppelin 支持需另行扩展规则和接口，未因本次实现而取消。

## 过往项目参考

参考了 [AgenticsFintekColumbia/smart-contracts](https://github.com/AgenticsFintekColumbia/smart-contracts)
中“生成 → 工具检查 → 反馈修复”的方法，尤其是 agents/mcp_tools.py 和 agents/agent.py。
本次没有复制其代码或提示词，也没有引入 CrewAI/MCP/eth-tester。
采用本项目确认规则和固定接口编写提示词，用 LangGraph 编排，保留现有 solc-js。
不沿用其修复后直接置 is_compilable/is_deployable=True 的做法。
