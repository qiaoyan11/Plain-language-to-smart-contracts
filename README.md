# Plain Language to Smart Contracts

把日常语言描述的服务协议，变成可确认的付款规则和智能合约。例如：请开发者做一个网站，按交付阶段验收和付款。

**已经能运行：** 手动填写 1–5 个阶段 → 确认规则 → 部署手写参考合约 → 存入测试资金 → 按顺序付款。网页、后端和本地测试链已接通。

**AI 进度：** Agent 2 已接通 GPT-5.4 mini＋LangGraph 单次生成，并完成一次真实编译；[运行方法](agent2/README.md)和[首次结果](docs/AGENT2_FIRST_RUN.md)。Agent 1/3 仍为模拟模块，独立验证、修复循环和网页 AI 入口待接。

## 新组员先看这三个入口

| 你想做什么 | 看这里 |
| --- | --- |
| 把现有网页跑起来 | [本地运行说明](docs/FRONTEND_INTEGRATION.md) |
| 领取任务、交给新的 GPT 开始开发 | [接手步骤和提示词](docs/TEAM_HANDOFF.md) · [四人分工](docs/TASKS.md) |
| 了解最新进度和已经定下的规则 | [工作日志](docs/WORKLOG.md) |

## 文件夹地图

根目录里的文件夹属于同一个项目，不是每个都要学习。先看自己负责的模块即可。

| 类别 | 文件夹 | 用白话说 |
| --- | --- | --- |
| AI 模块 | [agent1/](agent1/) | 把用户描述整理成规则，追问缺失的信息 |
| AI 模块 | [agent2/](agent2/) | 根据确认规则生成合约，之后根据反馈修复 |
| AI 模块 | [agent3/](agent3/) | 把“查询余额、批准付款”变成待确认的操作 |
| AI 流程 | [flows/](flows/) | 已用 LangGraph 管理 Agent 2 单次生成，后续接验证和修复 |
| 独立检查 | [validation/](validation/) | Claude 和评测负责人维护，检查生成的代码 |
| 现有应用 | [frontend/](frontend/) | 用户看到的网页 |
| 现有应用 | [backend/](backend/) | 接收网页请求、调用 Python、执行合约操作；Python 入口尚未接网页 |
| 现有应用 | [contracts/](contracts/) | 已能运行的手写参考合约 |
| 公共约定 | [shared/](shared/) | 模块输入输出格式、校验和样例，大家按同一种格式交接 |
| 开发辅助 | [tests/](tests/) · [scripts/](scripts/) | 自动测试和运行工具，通常不用改 |
| 项目说明 | [docs/](docs/) | 运行步骤、分工和工作日志 |
| GitHub 协作 | [.github/](.github/) | PR 模板和贡献说明 |

模块的详细交接格式见 [INTERFACES.md](shared/INTERFACES.md)，现有网页接口见 [PROJECT_API_V2.md](shared/PROJECT_API_V2.md)。

## 根目录这些文件是干什么的

这些多数是工具需要读取的标准配置，不是额外的功能模块。

| 文件 | 用途 | 谁需要关心 |
| --- | --- | --- |
| `README.md` | 你正在看的项目首页 | 所有人 |
| `AGENTS.md` | 给新的 GPT / Claude 的协作规则 | AI 工具先读 |
| `REVIEW.md` | Claude 的审查记录 | 需要看审查时读；由 Claude 维护 |
| `package.json`、`package-lock.json` | Node 的运行命令、依赖和固定版本 | 安装或添加 Node 工具时 |
| `requirements.txt`、`requirements.lock.txt` | Python 的依赖和固定版本 | 安装或添加 Python 工具时 |
| `hardhat.config.cjs` | 本地测试链配置 | 合约工具维护者 |
| `.env.example` | 环境变量示例，不放真实密钥 | 配置服务时 |
| `.gitignore` | 告诉 Git 哪些本地文件不要上传 | 通常不用改 |
| `LICENSE` | MIT 开源许可证 | 使用和分发代码时 |

## 现在的演示如何工作

例如总价 0.01 测试 ETH，分三阶段支付 0.002、0.003、0.005。客户先存入全部资金，再逐阶段验收。合约检查操作人、存款金额、付款顺序和重复支付；交付质量由客户判断。

合约会真实执行，但运行在电脑里的模拟区块链上，测试资金没有实际价值。无需购买 ETH 或连接个人钱包。重启后端会清空项目和链上记录；刷新网页不会清空。当前不支持退款、取消或争议处理，不用于真实资金。

最近验证：合约 **26/26**、接口 **5/5**、模块交接 **29/29** 通过。模块交接测试使用模拟模块，不代表真实 AI 或独立验证已完成。前端上次验证为 **7/7**，类型检查和构建通过。

各人在自己的分支开发，提交 PR，由 Jiahao 集成。修改公共格式前先协调；不直接替换别人的模块。具体流程见 [协作说明](.github/CONTRIBUTING.md)。
