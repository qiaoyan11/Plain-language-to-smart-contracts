# Plain Language to Smart Contracts

把日常语言描述的服务协议，变成可确认的付款规则和智能合约。例如：请开发者做一个网站，按交付阶段验收和付款。

产品名 Accord，流程分四步：描述 → 确认 → 准备合约 → 存款和付款。

1. **描述**：用户用一句话描述需求，或直接上传合同（PDF、Word、文本）。Agent 1 读出总价、分几期、每期多少钱；外币按实时汇率换成测试 ETH，“验收期 N 天内不提异议视为验收”这类条款也能读出来。只有真正缺的信息才追问。
2. **确认**：确认页用几句话说明合约会怎么执行，并列出合约不执行、留在书面合同里的条款。可选择加上“客户 14 天不回应自动付款”。
3. **准备合约**：确认后自动开始。Agent 2 生成 Solidity 合约，编译、Slither 静态分析和付款条款测试都通过后，自动部署到测试链，大约一到两分钟。
4. **存款和付款**：客户存入全款，之后逐期批准付款；有验收期的合约里，服务方标记交付、客户批准或要求修改、到期无回应时服务方领取。可以点按钮，也可以用一句话交给 Agent 3。每一步都先预览、再确认，结果以链上回执为准。

网页、助手回复和测试场景使用英文；用户自己的协议原文保持原样。

**本地运行**：安装好前后端依赖后，用 Node 22.12+（建议 22.x）在仓库根目录运行 `npm run demo:live`（等同于 `AGENT1_MODE=live AGENT2_MODE=live AGENT3_MODE=live npm run demo:web`），打开 http://127.0.0.1:5173 。若后端用 Node 20，启动器会自动寻找 `~/.accord-node` 或 Homebrew 里的 Node 22；也可以设置 `DEMO_FRONTEND_NODE` 为前端 Node 的完整路径。模型调用会产生 API 费用。

**线上运行**：`npm run serve` 以线上模式启动，访问者先在封面输入访问密钥，每个密钥有独立的项目空间，每天的模型调用有上限。部署到 Railway 的步骤见 [DEPLOY.md](docs/DEPLOY.md)，上线评估见 [LAUNCH_READINESS.md](docs/LAUNCH_READINESS.md)。

[完整对话演示](docs/AGENT1_DEMO.md) · [前端运行说明](frontend/README.md) · [工作日志](docs/WORKLOG.md) · [验收期设计](docs/REVIEW_PERIOD_V2.md)

服务端保存对话和草稿版本，刷新网页时按草稿 ID 恢复。只有完整且没有待解决事项的草稿才能确认；确认后的对话封存，修改约定需新建协议。独立链下条款以用户原文单独显示，不成为链上付款条件。草稿版本与确认后项目的 `specVersion` 分别计数，来源由 `draftOrigin` 关联。

安装 Python 模块请用 **Python 3.11 或以上（排除 3.12.0）**；锁定依赖不支持 Python 3.10。目前在 Mac 上实测的是 Python 3.14.3。建议组员统一版本，并按 `requirements.lock.txt` 安装，避免各自解析出不同依赖。

## 新组员先看这三个入口

| 你想做什么 | 看这里 |
| --- | --- |
| 把现有网页跑起来 | [本地运行说明](docs/FRONTEND_INTEGRATION.md) |
| 领取任务、交给新的 GPT 开始开发 | [接手步骤和提示词](docs/TEAM_HANDOFF.md) · [四人分工](docs/TASKS.md) |
| 了解最新进度和已经定下的规则 | [工作日志](docs/WORKLOG.md) |
| 了解如何逐步支持不同合同条款 | [灵活合同架构规划](docs/FLEXIBLE_CONTRACT_ARCHITECTURE.md)；第一项“验收期”已实现，见 [REVIEW_PERIOD_V2.md](docs/REVIEW_PERIOD_V2.md) |
| 把网站部署到线上 | [部署步骤](docs/DEPLOY.md) |

## 文件夹地图

根目录里的文件夹属于同一个项目，不是每个都要学习。先看自己负责的模块即可。

| 类别 | 文件夹 | 用白话说 |
| --- | --- | --- |
| AI 模块 | [agent1/](agent1/) | 把用户描述整理成规则，追问缺失的信息 |
| AI 模块 | [agent2/](agent2/) | 根据确认规则生成合约，之后根据反馈修复 |
| AI 模块 | [agent3/](agent3/) | 把“查询余额、批准付款”变成待确认的操作 |
| AI 流程 | [flows/](flows/) | 用 LangGraph 管理生成、独立验证和有限修复 |
| 独立检查 | [validation/](validation/) · [tests/v2/](tests/v2/) | 评测负责人维护，独立检查生成的代码；验收期合约的检查在 tests/v2/ |
| 现有应用 | [frontend/](frontend/) | 用户看到的网页 |
| 现有应用 | [backend/](backend/) | 保存澄清会话、确认规则，连接合约生成、部署及付款操作；`gateway.cjs` 是线上的访问密钥入口 |
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
| `AGENTS.md` | 给 AI 编程助手的协作规则 | AI 工具先读 |
| `REVIEW.md` | 代码审查记录 | 需要看审查时读 |
| `package.json`、`package-lock.json` | Node 的运行命令、依赖和固定版本 | 安装或添加 Node 工具时 |
| `requirements.txt`、`requirements.lock.txt` | Python 的依赖和固定版本 | 安装或添加 Python 工具时 |
| `hardhat.config.cjs` | 本地测试链配置 | 合约工具维护者 |
| `.env.example` | 环境变量示例，不放真实密钥 | 配置服务时 |
| `Dockerfile`、`.dockerignore`、`railway.json` | 线上部署用的镜像和 Railway 设置 | 部署时 |
| `.gitignore` | 告诉 Git 哪些本地文件不要上传 | 通常不用改 |
| `LICENSE` | MIT 开源许可证 | 使用和分发代码时 |

## 现在能做什么

已用真实模型从头跑通：一句话需求、中文合同、上海政府采购合同（727 万元、累计付至 97%）、SEC 公开的软件开发合同（5 期各 20%、10 天验收期、2 轮修改）。每个都完成了确认、自动生成和部署、存款，以及逐期付款或到期领取，最后余额归零。

合约运行在服务器上的测试链，使用两个内置测试账户自动签名，不需要钱包，金额都是测试 ETH，不涉及真钱。草稿、确认的条款、生成结果和链上记录都会保存；链接丢了，页面顶部的 **Your projects** 能找回全部项目和未完成的对话。目前支持按期付款和验收期；退款、取消、争议处理和真实钱包仍待实现。合约只通过了自动检查，没有经过人工安全审计。

各模块的测试数量和联调范围见[工作日志](docs/WORKLOG.md)。

各人在自己的分支开发，提交 PR，由 Jiahao 集成。修改公共格式前先协调；不直接替换别人的模块。具体流程见 [协作说明](.github/CONTRIBUTING.md)。
