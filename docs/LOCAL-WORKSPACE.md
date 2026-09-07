# 本地工作台

UsageMesh 2.6.0 起内置本地 Web 页面，无需 Node、Docker 或额外 Web 部署：

```sh
usagemesh serve
```

浏览器自动打开终端中的启动链接。默认监听 `127.0.0.1:43821`，每次启动生成新的访问凭据，保存在链接 fragment 中，页面连接后清除该 fragment。页面锁定后可用本次终端链接重新连接。不要分享链接。

```sh
usagemesh serve --port 43822 --no-open
```

第一次使用点击 **扫描本机**。无需 GitHub 登录，也无需先创建云端工作区。本地页面和 GitHub Pages 面板独立：前者管理本机，后者继续展示加密同步的跨设备汇总。在云端“设置 → 本地工作台”可复制启动命令。

## 功能与数据边界

| 页面 | 可用功能 | 来源和边界 |
|---|---|---|
| 额度中心 | Codex 快照、CodexBar 读取、重置时间、失效提示 | Codex CLI 的 `token_count.rate_limits`；可选已安装/授权的 `codexbar` CLI。不会用 Token 推算订阅余额；超过 15 分钟或重置时间已过的快照不能代表当前余额。 |
| 项目与会话 | 按项目聚合、搜索、别名、标签、月预算、会话和请求下钻、CSV 导出 | Tokscale 本机记录最近 90 个自然日；未知项目明确标记；最多保留最近 20000 条请求，会话汇总覆盖整个扫描窗口。费用是兼容价卡估算，非供应商账单。 |
| 提醒 | 月预算、项目预算、额度阈值、费用突增、冷却间隔、通知测试和历史 | 本地服务运行期间执行。源数据失效不表示额度恢复。费用突增需过去 7 天日均至少 $1。Linux 系统通知需要 `notify-send`。 |
| 供应商配置 | Codex / Claude Code 方案 CRUD、脱敏预览、确认应用、自动备份、受保护回滚、连接测试 | 保留无关配置与 Codex TOML 注释；不修改 Codex `auth.json`。项目设置、环境变量和其他管理器可能覆盖全局配置，应用后重启相应 CLI。 |
| 渠道质量 | 事件量、错误率、P50/P95、429、已知重试数、JSON 导入/导出 | 模型目录探测、显式选择的生成探测、导入请求分别统计。探测耗时为收到响应头的耗时，非首 Token 或完整生成耗时。没有请求日志时不虚构生产指标。 |
| 代理连接器 | CLIProxyAPI 账号元数据、LiteLLM / OpenAI 兼容模型目录 | 只读，最多返回 500 项。不修改代理，不下载认证文件，不切换账号。 |

默认每 5 分钟扫描一次，设置可改为 1–60 分钟。关闭浏览器不会停止服务；终止 `serve` 进程会停止扫描和通知。此命令不安装新的开机后台服务。

## 密钥与配置管理

方案只保存 **环境变量名**，不保存密钥值。在启动服务的终端设置所需变量，再运行 `usagemesh serve`。例如使用终端安全输入方式设置 `OPENAI_API_KEY`，页面填 `OPENAI_API_KEY`，不要把密钥填进名称或 URL。

- Codex：配置写入 `model_providers.usagemesh_<id>` 的 `env_key`，运行 Codex 的环境也需包含该变量。
- Claude Code：应用时从服务进程环境读取值，写入 Claude 自身设置的 `ANTHROPIC_AUTH_TOKEN`，移除同一配置中的 `ANTHROPIC_API_KEY`；不填写引用时保留现有凭据。不要同时用其他工具修改此文件。
- 预览不显示常见凭据字段。备份包含原文件完整内容，可能含原有密钥，只存本机私有目录；不上传 GitHub。
- 修改前后内容哈希必须与预览匹配。外部修改、格式错误、配置文件为符号链接时拒绝应用；回滚也拒绝覆盖外部修改。
- 服务要求精确本机 Host、同源请求和随机 bearer 凭据。不提供 CORS，不允许远程绑定；连接器仅接受 HTTPS 或 loopback HTTP，拒绝含凭据/查询参数的 URL，不跟随重定向。

本地数据保存在 `usagemesh` 配置目录的 `local/` 下，实际路径在工作台展示，可通过 `--data-dir` 覆盖。包含脱离云端协议的项目汇总、方案、事件、提醒与配置备份。Unix 写入使用私有权限及原子替换；Windows 继承用户目录 ACL，建议使用本人的私有用户目录。

## 连接已有代理

- CLIProxyAPI：填写服务根地址，如 `http://127.0.0.1:8317`，读取 `/v0/management/auth-files` 的目录元数据；管理密钥填环境变量名。
- LiteLLM / OpenAI 兼容：填写 API 前缀，如 `http://127.0.0.1:4000/v1`，读取 `/models`。
- 读取失败保留已保存连接，不将失败响应当作有效数据。
- 主动生成测试需在测试对话框勾选可能计费选项；默认只请求模型目录。

## 导入渠道事件

在渠道质量页面选择 JSON 文件。数组最多 10000 条，文件不超过 2MB，按 `id` 去重。仅保存如下字段，额外字段会被丢弃：

```json
[
  {
    "id": "request-unique-id",
    "channel": "my-provider",
    "status": 200,
    "latencyMs": 430,
    "at": "2026-09-07T09:00:00Z",
    "retry": false
  }
]
```

`status` 为 100–599 HTTP 状态；`latencyMs` 为 0–3600000；`at` 为带时区 RFC3339；`retry` 可省略并保持未知。请在日志生产侧统一耗时语义。导出探测中的状态 0 表示网络失败，不符合请求日志的 HTTP 状态约束，不应当作生产请求重新导入。

## 开发与隔离验证

静态页面直接嵌入 Rust 二进制：`rust-cli/local-web/`。本地 API 和采集适配器：`rust-cli/src/local/`。

```sh
cargo test --workspace
cargo run -- serve --home /absolute/isolated-fixture --no-open --port 0
```

`--home` 使用独立客户端目录并忽略 `CODEX_HOME` / `CLAUDE_CONFIG_DIR` 等真实根目录；不修改系统 `HOME`。用于测试的配置修改只作用于 fixture。默认路径继续遵循真实客户端环境配置。
