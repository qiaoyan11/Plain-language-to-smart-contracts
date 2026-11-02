# Python 和 LangGraph 工作流

此目录保留，改用于 Python 工作流，不再计划存放 Langflow 导出。尚未实现。

组员 B 负责生成与修复图；Jiahao 负责 Node 调用入口，双方共同遵循 [模块接口 v1](../shared/INTERFACES.md)。

计划入口为 `flows.worker`：stdin 接收一个 JSON 请求，stdout 返回一个 JSON 响应；日志写 stderr。模块存在前不要把它当作可运行命令。

首个图：检查确认规则 → 生成 → 开发验证 → 通过则结束；失败则按预算修复，工具出错则停止。先跑一次生成，再接验证和循环。记录每次输入版本、代码标识和允许的反馈；不调用隐藏评测。

不需要 Langflow，LangChain 按实际需要使用。Python 依赖在实现时统一固定，A/B/C 含义与正式预算从 proposal 落实后写入评测配置。
