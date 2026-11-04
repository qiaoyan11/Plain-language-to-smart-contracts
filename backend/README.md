# Node 后端

已实现：接收网页请求、检查项目参数、部署参考合约、存款、逐阶段付款、读取链上状态。新增了确认规则、修改规则版本、异步启动 Agent 2 和查询结果的接口；新网页已接入。负责人 Jiahao。

保留 [Project API v2](../shared/PROJECT_API_V2.md)。新接口见 [Generation HTTP API v1](../shared/GENERATION_API_V1.md)，Python 输入输出仍用 [模块接口 v1](../shared/INTERFACES.md)。

文件分工：`server.cjs` 接 HTTP 和参考合约操作；`generation.cjs` 管确认、版本、运行记录及重复请求；`python-bridge.cjs` 调固定 Python worker 并检查完整输出。修复循环仍只在 Python 中。

默认 `npm run backend` 不启动收费模型。配置好 Python、验证工具和本地 key 后，显式用 `AGENT2_MODE=live npm run backend` 启用；当前服务端固定 C、最多 3 次修复。只有用户请求生成才启动任务。模型和修复预算不接受网页传入。

项目、确认及运行查询记录都在内存里，重启清空；Python 的逐轮产物另存在本地 `artifacts/agent2/`。修改规则会撤销旧确认，并标记旧结果过期。重复请求不会重启同一任务；失败后需用户主动重试。

本轮只返回生成结果，AI 合约部署未开放。原 `/actions` 的 deploy 始终部署手写参考合约，不能用作新页面的“部署 AI 合约”按钮。仅提供本地服务。

运行现有版本见 [本地演示说明](../docs/FRONTEND_INTEGRATION.md)。

验证：`npm run test:api`。新增测试使用受控 worker 输出，不调用收费模型；它们检查 HTTP 交接，不代替独立合约验证。
