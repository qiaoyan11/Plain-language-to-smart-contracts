# Agent 2 — 合约生成和修复

计划采用 Python；LangGraph 管理生成、验证和有限修复。真实模型尚未实现；已有 stub.py 模拟函数与 __main__.py 独立运行入口。负责人为组员 B（姓名待认领），分支 feature/agent2-python；同时负责 flows/ 中的工作流。

输入确认后的规则，输出源代码包。第一步只生成一次；之后调用 C/Claude 的开发验证工具，依据允许的反馈修复。代码是否通过由验证工具判断，LLM 不自行宣布通过。

遵循 [模块接口 v1](../shared/INTERFACES.md) 和 [请求样例](../shared/examples/generate.request.json)。生成代码不得覆盖 contracts/ 的参考合约。不得修改 validation/、读取隐藏评测结果或更改确认规则。A/B/C 的含义与修复预算由评测负责人依据 proposal 固定，不能自行猜测。

交付独立运行入口、版本化依赖、样例及测试；Node 连接由 Jiahao 配合完成，暂不部署生成代码。详见 [任务分配](../docs/TASKS.md)。

安装、运行和替换步骤见 [接手说明](../docs/TEAM_HANDOFF.md)。入口和出口均调用 shared.handoff 校验；不要删除校验来绕过格式错误。
