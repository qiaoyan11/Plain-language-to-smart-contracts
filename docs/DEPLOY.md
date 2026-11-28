# 线上部署（访问密钥 + Railway）

目标：别人打开网址，先看到“输入访问密钥”的封面，输入正确密钥后才能使用；每个密钥有自己独立的项目和草稿。合约仍在服务器上的测试链运行，金额是 test ETH，不涉及真钱。

## 结构

一个容器（`Dockerfile`），启动命令 `node scripts/serve.cjs`：

- 网关 `backend/gateway.cjs`（对外端口 `PORT`）：封面、登录 Cookie、按密钥分隔数据、每个密钥每天的模型调用上限、只接受本站页面发出的修改请求。
- API `backend/server.cjs`（只监听 127.0.0.1）：三个 Agent、本地测试链、项目和草稿。
- 网页（Nitro 构建产物，只监听 127.0.0.1）。

数据放在 `/data`（挂载卷）：项目和草稿、测试链历史、Agent 2 生成记录、Agent 1 记录。重新部署不会丢。

## 环境变量

| 变量 | 必填 | 说明 |
| --- | --- | --- |
| `OPENAI_API_KEY` | 是 | 三个 Agent 用。建议在 OpenAI 后台单独建一个项目密钥，并设每月预算上限。 |
| `ACCORD_ACCESS_KEYS` | 是 | 访问密钥，逗号分隔，可带名字：`toby=xxxx,ta=yyyy`。每个至少 12 个字符。同一个密钥的人共用一个工作区。 |
| `ACCORD_SESSION_SECRET` | 建议 | 32 位以上随机字符串。不设的话，每次重启后大家需要重新输入密钥。 |
| `ACCORD_LIMIT_MESSAGES` / `ACCORD_LIMIT_GENERATIONS` / `ACCORD_LIMIT_REQUESTS` | 否 | 每个密钥每天的对话消息、合约生成、一句话操作次数，默认 150 / 15 / 150。 |
| `ACCORD_TEST_CLOCK` | 否 | 设为 `off` 关闭“跳到验收期结束”。测试链时间是全站共用的，一个人跳过会让其他人的验收倒计时一起提前。 |

生成随机密钥：`openssl rand -base64 24`（每次运行得到一个新的）。

## Railway 步骤（约 15 分钟）

1. 把分支推到 GitHub（见 `artifacts/handoff/README.md`）。
2. 登录 railway.com（可用 GitHub 账号），选 Hobby 计划。
3. New Project → Deploy from GitHub repo → 选这个仓库；在服务的 Settings → Source 把分支改成 `integration/agent1-complete-demo`。Railway 会读取仓库里的 `Dockerfile` 和 `railway.json`。
4. Variables：填上面三个必填/建议变量。
5. 右键服务 → Attach Volume，挂载路径填 `/data`，1 GB 足够。
6. Settings → Networking → Generate Domain，得到 `https://….up.railway.app`。
7. 等第一次构建完成（约 5–10 分钟），打开网址，看到封面后输入密钥。

内存：空闲约 450 MB，生成合约时再多约 300 MB。Railway 按实际用量计费，所以不需要先选机器大小。

## 暂停和恢复

- 两个月后不用了：在服务的 Deployments 里把当前部署 Remove（停止计算费用），卷里的数据保留；不再需要时再取消 Hobby 计划。
- 以后要用：Redeploy 即可，项目和密钥都还在。
- 改密钥：改 `ACCORD_ACCESS_KEYS` 后服务会自动重启；被删掉的密钥立刻失效。

## 本地试运行同一套线上模式

```
cd frontend && npm run build && cd ..
ACCORD_ACCESS_KEYS="me=local-test-key-123" PORT=8080 npm run serve
```

打开 http://127.0.0.1:8080 ，会先看到封面。注意：线上模式会调用真实模型（需要 `.env` 里的 OPENAI_API_KEY）。
