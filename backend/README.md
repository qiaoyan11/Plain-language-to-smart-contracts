# Node 后端

已实现：接收网页请求、检查项目参数、部署参考合约、存款、逐阶段付款、读取链上状态。当前项目记录在内存里；本地服务重启后重置。负责人 Jiahao。

保留当前实现和 [Project API v2](../shared/PROJECT_API_V2.md)，不迁移到 Python。后续新增一个固定的 Node→Python JSON 子进程入口，见 [模块接口 v1](../shared/INTERFACES.md)。该入口尚未实现。

Node 继续负责项目记录、用户确认、版本核对、部署和交易；Python 只负责 AI 流程。第一项集成任务只接生成结果，不自动部署 AI 代码。不加入第二套项目数据库、钱包或公网服务。

运行现有版本见 [本地演示说明](../docs/FRONTEND_INTEGRATION.md)。
