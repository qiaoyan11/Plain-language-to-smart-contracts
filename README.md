# Plain Language to Smart Contracts

把日常语言描述的服务协议，变成可确认的付款规则和智能合约。例如：请开发者做一个网站，按交付阶段验收和付款。

用户可以手填 1–5 个付款阶段，确认后让 Agent 2 生成合约。编译、Slither 和条款测试通过后，点击 **Deploy generated contract locally** 部署该版本。接着可以用中英文让 Agent 3 查询余额、存款或验收。每次存款和付款都要点 **Confirm and send**。金额、收款方和支付状态来自本机 Hardhat 测试链。

运行两个 Agent 时，在仓库根目录用 `AGENT2_MODE=live AGENT3_MODE=live npm run backend` 启动后端，在 `frontend/` 用 `npm run dev` 启动网页。模型调用会产生 API 费用。Agent 1 的需求澄清目前使用示例脚本，用户负责确认付款字段。手写合约演示入口为 `/reference-demo`。[完整运行说明](frontend/README.md) · [模块验证记录](docs/WORKLOG.md)

安装 Python 模块请用 **Python 3.11 或以上（排除 3.12.0）**；锁定依赖不支持 Python 3.10。目前在 Mac 上实测的是 Python 3.14.3。建议组员统一版本，并按 `requirements.lock.txt` 安装，避免各自解析出不同依赖。

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
| AI 流程 | [flows/](flows/) | 用 LangGraph 管理生成、独立验证和有限修复 |
| 独立检查 | [validation/](validation/) | Claude 和评测负责人维护，检查生成的代码 |
| 现有应用 | [frontend/](frontend/) | 用户看到的网页 |
| 现有应用 | [backend/](backend/) | 提供确认规则、AI 生成查询及参考合约操作接口 |
| 现有应用 | [contracts/](contracts/) | 已能运行的手写参考合约 |
| 公共约定 | [shared/](shared/) | 模块输入输出格式、校验和样例，大家按同一种格式交接 |
| 开发辅助 | [tests/](tests/) · [scripts/](scripts/) | 自动测试和运行工具，通常不用改 |
| 项目说明 | [docs/](docs/) | 运行步骤、分工和工作日志 |
| GitHub 协作 | [.github/](.github/) | PR 模板和贡献说明 |

模块交接格式见 [INTERFACES.md](shared/INTERFACES.md)，现有项目接口见 [PROJECT_API_V2.md](shared/PROJECT_API_V2.md)，新增生成接口见 [GENERATION_API_V1.md](shared/GENERATION_API_V1.md)。

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

各模块的测试数量和联调范围见[工作日志](docs/WORKLOG.md)。

各人在自己的分支开发，提交 PR，由 Jiahao 集成。修改公共格式前先协调；不直接替换别人的模块。具体流程见 [协作说明](.github/CONTRIBUTING.md)。
