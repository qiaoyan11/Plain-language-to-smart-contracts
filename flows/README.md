# Python 和 LangGraph 工作流

`worker.py` 是统一 JSON 入口：stdin 收请求，stdout 返回一个响应，日志到 stderr。
默认使用模拟模块；显式 `AGENT2_MODE=live` 后，generate 调用 Agent 2 的真实单次生成。
Agent 1 和 Agent 3 仍为模拟实现。

`generation.py` 已实现 LangGraph：检查确认规则 → 模型生成 → 打包源码 → 本机编译。
单次生成，没有自动重试或修复循环。源码和编译成功不代表独立验证通过。

运行方法、模型设置、输出记录见 [Agent 2](../agent2/README.md)。现有网页未接入这个真实入口。
后续接 validate_development 后才加入通过/失败分支与有限修复；模型不能填验证报告，hidden 结果不进入图。
