# 新组员从这里开始

这个仓库就是共享上下文。新的 GPT 不需要知道过去的聊天，但必须先读规则，不能直接重写项目。

## 1. 先运行共同版本

先按 [网页运行说明](FRONTEND_INTEGRATION.md) 跑一次创建、部署、存款、付款。
再从仓库根目录运行下面命令（Python 3.11 或更高；现有 Node 版本要求保持不变）：

```sh
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements.lock.txt
npm ci
npm run e2e
```

Windows 的 Python 路径是 `.venv\Scripts\python.exe`。也可以通过 `PYTHON_BIN` 指定解释器。
`requirements.txt` 记录直接依赖；lock 文件固定本轮测试使用的全部 Python 依赖。

`e2e` 目前检查的是模块交接，不是完整 AI 产品，也不部署代码。它包括格式检查、Node 调用 Python、模拟输出和失败处理。网页原有演示独立保留。

## 2. 每人替换哪一块

| 负责人 | 主要编辑位置 | 替换什么 | 第一项完成标准 |
| --- | --- | --- | --- |
| A | agent1/ | stub.py 的 clarify(payload) | 接模型，完整、缺信息、超范围三种描述返回合法输出，不替用户确认 |
| B | agent2/、flows/ | stub.py 的 generate(payload)，之后替换 worker 的调度 | 先真实生成一次；再用 LangGraph 接 C 的开发验证和有限修复 |
| C + Claude | validation/ | 自己实现 validate_development(spec, sourceBundle) | 编译、静态检查、条款测试组成可信报告；工具没准备好不能报通过 |
| Jiahao | backend/、frontend/、agent3/ | python-bridge.cjs 后续网页接入；agent3/stub.py | 管用户确认、版本、集成；Agent 3 先输出意图，再由后端执行 |

模拟函数的文件名以后可改为 service.py，届时只调整 flows/worker.py 中对应 import。
业务模块不互相 import；flows 统一调用它们。shared 仅放格式和共用校验。
不要把同一套修复循环分别放在 Node 和 Python。

每个 Agent 都能独立跑（以下命令在根目录执行）：

```sh
.venv/bin/python -m agent1 shared/examples/clarify.request.json
.venv/bin/python -m agent2 shared/examples/generate.request.json
.venv/bin/python -m agent3 shared/examples/planAction.request.json
```

Agent 1 当前不理解文字，只返回待核对样例；Agent 2 返回手写参考源码；Agent 3 返回 blocked。
输出 stderr 的 STUB 提示不能删除，直到真实实现替换完成且文档同步。
LangGraph 尚未安装或实现；当前 worker 是简单分发入口，留给 B 替换为图。
C 的验证模拟实现也尚未连接，development 请求返回 toolError，无报告、无部署许可。

## 3. 接口究竟如何连接

```text
独立连接测试 / 未来 Node 页面入口
  → backend/python-bridge.cjs
  → 固定 Python 入口 flows.worker（stdin JSON）
  → shared.handoff 检查输入
  → 对应 Agent 函数
  → shared.handoff 检查输出
  → stdout JSON 返回 Node
```

- `shared/schemas/handoff.schema.json`：格式字典，包含规则、源码、报告、部署记录和操作输入输出。
- `shared/handoff.py`：补充跨字段检查，例如金额之和、连续阶段编号、确认版本、源码指纹。
- `shared/examples/`：各类交接对象的合法样例。地址、确认记录、部署记录均为虚构，不证明真的部署或确认。
- `backend/python-bridge.cjs`：固定程序入口，无 shell；输入 1 MiB 上限，输出和日志合计 1 MiB，默认 10 秒超时，同项目同时只允许一项任务。
- 调用方通过 isCurrent 回调检查运行期间规则是否已变化；当前服务尚未接这个入口，持久确认和版本管理也是集成下一步。
- worker 在返回前检查完整输出；Node 检查信封、请求 ID、项目版本及运行异常。所有金额跨语言传字符串。
- 格式合法不代表语义正确、更不代表安全。只有独立验证能给真实 passed 报告；格式校验本身不能认证报告来源。

修改接口时先协调，更新 WORKLOG 决策、schema、校验、样例和相关测试；不能只改自己模块的字段名。
当前 `ValidationReport` 中 severity 是字符串，具体告警等级和阻塞策略仍由 C 定义并版本化。

## 4. 交付方式

从最新 main 建自己的分支，例如 `feature/agent1-python`，小步提交并推送自己的分支，提交 PR。不要直接覆盖 main，也不要把各人的文件最后手工拼到一起。
PR 写清：改了什么、输入输出例子、测试结果、还没做什么。Jiahao 合并并复测。

给新 GPT 的第一条消息：

> 请先读 AGENTS.md、README.md、docs/WORKLOG.md、docs/TASKS.md、shared/INTERFACES.md 和我负责模块的 README。
> 我负责【模块】，这次只做【具体任务】。先检查现有实现，再替换对应 stub。
> 保持已有接口；需要修改公共格式或别人的模块时先说明并等我们确认。
> 不重写已有网页、后端或合约，不把模拟结果当作验证通过，不接触隐藏评测或提交密钥。
> 完成后运行模块测试和 npm run e2e，给出修改列表、结果和限制。
