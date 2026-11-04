# validation/ — 独立开发验证（负责：Claude / 组员 C）

对 Agent 2 生成的合约做独立检查，返回 `shared/INTERFACES.md` 第 6 节规定的 ValidationReport。
所有结论都来自本模块实际运行的工具；不读取、不信任 Agent 2 的 `compilation.json` 或任何模型输出。

## 调用

```python
from validation import validate_development
report = validate_development(spec, source_bundle)   # ConfirmedSpec, SourceBundle -> ValidationReport
```

命令行（在仓库根目录）：

```sh
.venv/bin/python -m validation --run-dir artifacts/agent2/<运行编号>
.venv/bin/python -m validation --spec spec.json --bundle source-bundle.json --out 输出目录
```

`--run-dir` 读取该目录的 `request.json`（规则）和 `response.json`（SourceBundle），
在同一目录写入 `validation-report.json`（标准报告）和 `validation-evidence.json`（每条测试、每条 Slither 告警、工具版本等明细）。
退出码：0 = passed，1 = failed，2 = toolError。

## 安装

```sh
npm ci                                                     # solc 0.8.28、hardhat、ethers（已有）
.venv/bin/python -m pip install -r requirements.lock.txt   # jsonschema 等（已有）
.venv/bin/python -m pip install -r validation/requirements.txt   # slither-analyzer 0.11.3
```

不需要另装 solc：Slither 通过 `node/solc-shim.cjs` 调用仓库锁定的 npm solc 0.8.28，与编译检查是同一个编译器。
需要 macOS 或 Linux（Slither 的 solc 包装用 `/bin/sh`）；Windows 未支持。

## 三项检查（suiteVersion `dev-v1;solc-js-0.8.28;clause-v1;slither-0.11.3;slither-block-high-medium-v1`）

1. **compilation**：重算 sourceHash（不一致直接失败）；核对 projectId/specVersion；用 solc-js 0.8.28 和 bundle 的编译设置重新编译，
   不允许 import 外部文件；入口合约必须有 bytecode；构造函数必须是 `(address,address,uint256[])`；
   ABI 必须完整包含冻结接口 `contracts/IMilestoneEscrow.sol` 的函数和事件；bundle 里的接口文件不能被改动。
2. **staticAnalysis**：Slither 0.11.3，版本不符即 toolError。阻断规则 `slither-block-high-medium-v1`：
   **impact 为 High 或 Medium 的告警阻止通过**；Low / Informational / Optimization 只记录。无例外清单。
3. **clauseTests**：在 Hardhat 内置本地链上部署**本模块重新编译出的** bytecode，运行 23 条条款测试（`clause-v1`）：

| 编号 | 检查内容 |
| --- | --- |
| flow-1/2/3/5、flow-spec | 1、2、3、5 阶段及确认规则里的金额：读取函数、存款、按序付款、开发者实收金额、合约余额、事件 |
| access-deposit、access-accept | 外人和开发者都不能存款或验收 |
| deposit-exact、deposit-once | 少付/多付/0 被拒；只能存一次（中途和完成后都不行） |
| unfunded-accept、unfunded-forced-eth | 未存款不能付款；用 selfdestruct 强行转入 ETH 后仍不能付款 |
| order-skip、order-repeat | 不能跳阶段；每阶段只付一次，完成后也不行 |
| recipient-reject-rollback | 收款方拒收时：回执 status=0、无事件、状态和余额全不变 |
| recipient-reentry | 重入的收款方拿不到额外付款，账目一致 |
| constructor-*（7 条） | 0 个、6 个阶段、金额为 0、零地址、双方相同时构造失败 |
| id-out-of-range | 阶段 0 和 count+1 不能验收（读取函数越界不回滚只记 warning） |

每次被拒交易都检查：真实挖出的回执 status=0、没有残留日志、合约状态与余额（发起方为开发者时除外其 gas）完全不变。
**不依赖任何自定义错误名**，所以不同写法的生成合约都能公平检查。

## 判定

- 三项都 passed → `passed`，并附 artifact（ABI、bytecode 来自本模块编译）。
- 任一项 failed → `failed`；编译失败时后两项为 skipped。
- 没有 failed、但有 toolError 或 skipped → `toolError`（无法判断，绝不当通过）。

## 自测（证明能发现错误）

```sh
.venv/bin/python -m unittest discover -s validation/tests -t .
```

- `test_mutants.py`：把已知正确的夹具合约（`tests/fixtures/KnownGoodEscrow.sol`，仅自测用）故意改坏 15 种——
  去掉权限检查、允许跳阶段、允许重复付款、去掉"已存款"检查、多付、重复存款、忽略转账失败、付错金额/付给客户、
  不置已付标记、事件写错、允许 6 阶段/金额 0/双方相同——每一种都必须被指定的条款测试抓住。
- `test_pipeline.py`：正确合约通过并带 artifact；未检查的转账和未初始化局部变量被 Slither 规则阻断；
  sourceHash 被篡改、版本过期、编译错误、接口文件被改、构造函数不对都失败；Slither 缺失、版本不符、崩溃都是 toolError。

## 边界

- `clause-v1` 是**开发**测试，可按 A/B/C 设置作为修复反馈；留出（held-out）评测是另一个入口，尚未实现，其内容不得进入生成提示词。
- 只覆盖 IMilestoneEscrow v1 付款子集；退款、取消、期限不在本版本。
- 不部署到任何公共链，不使用真实资金，不调用模型。
