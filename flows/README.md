# Python 和 LangGraph 工作流

`worker.py` 是统一 JSON 入口：stdin 收请求，stdout 返回一个响应，日志到 stderr。
默认使用模拟模块；显式 `AGENT2_MODE=live` 后，generate 调用 Agent 2 的真实工作流。
Agent 1 和 Agent 3 仍为模拟实现。

`generation.py`：检查确认规则 → 模型生成 → 打包源码 → 独立验证 → 通过或停止；
失败时按 B/C 可见反馈修复，再验证，最多 maxRepairs 次。工具错误立即停止。
A 必须零修复；B 不看条款反馈，C 可看开发条款反馈。留出评测不进入工作流。
`validationMode=none` 保留原有单次生成＋编译路径，不获得部署许可。

可信程序直接调用 `validation.validate_development`，不会让模型填写验证报告。
每轮模型输出和检查结果由 agent2/records.py 保存；sourceHash、reportId 和预算通过共享格式校验。
运行方法和边界见 [Agent 2](../agent2/README.md)。网页尚未接入这个入口。
