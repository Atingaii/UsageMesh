<p align="center">
  <img src="docs/assets/usagemesh-hero.svg" alt="UsageMesh — 跨设备 AI Coding 用量分析" width="100%" />
</p>

<p align="center">
  <strong>面向 AI Coding 工具的本地优先、无服务器、跨设备用量分析。</strong><br/>
  每台设备本地采集，使用你自己的 GitHub Fork 同步加密账本，并由你自己的 GitHub Pages 托管 Dashboard。
</p>

<p align="center"><a href="README.md">English</a> · <a href="SECURITY.md">安全模型</a> · <a href="docs/PRICING.md">费用口径</a></p>

## UsageMesh 是什么

UsageMesh 解决的是一个具体问题：当 Codex、Claude Code 等 AI Coding 工具分散运行在多台 Mac、Windows、Linux 设备上时，如何在**不自建服务器**的情况下统一查看 Token、请求、缓存、模型、设备和费用估算。

- **跨设备**：多台机器汇总到同一个工作区。
- **本地优先**：本地扫描，不以上传 Prompt、回复、源代码或完整会话为设计目标。
- **上传前加密**：设备账本使用 AES-256-GCM 加密后才写入 GitHub。
- **零服务器**：GitHub 分支承担同步，GitHub Pages 承担网页展示。
- **Fork 即工作区**：数据进入你自己的 Fork，网页属于你自己的 Pages 地址。
- **概览与分析分工明确**：概览回答“用了多少”，分析页回答“为什么高、由谁贡献、结构是否健康”。

## 快速开始

### 1. Fork 仓库并启用 Pages

Fork `Atingaii/UsageMesh` 到自己的 GitHub 账号并保持 **Public**。纯前端 Dashboard 需要在没有服务器代理的情况下读取密文；实际设备明细在上传前已经加密。

GitHub 对新 Fork 的 Actions 有平台级安全限制，不会自动直接执行上游工作流。因此第一次需要进入你自己 Fork 的 **Actions** 页面启用工作流，然后手动运行一次 **Deploy Dashboard**。如果 Pages 尚未启用，则进入 **Settings → Pages → Source → GitHub Actions**，随后重新运行 **Deploy Dashboard**。

### 2. 准备 GitHub 认证（不需要安装 GitHub CLI）

UsageMesh 需要对**你自己的 Fork**具有写权限，用来更新加密账本分支。推荐使用 Fine-grained Personal Access Token：

1. 打开 GitHub **Settings → Developer settings → Personal access tokens → Fine-grained tokens**，也可以直接访问 [Generate new token](https://github.com/settings/personal-access-tokens/new)。
2. `Resource owner` 选择自己的 GitHub 账号。
3. `Repository access` 选择 **Only select repositories**，只勾选自己的 `UsageMesh` Fork。
4. `Repository permissions` 设置 **Contents → Read and write**。设备同步不需要额外仓库权限。
5. 设置合理的过期时间并生成 Token；复制好 `github_pat_...`，GitHub 通常不会再次完整显示它。

**不要把 PAT 写进安装命令。** 稍后执行 `usagemesh setup` 时，如果没有检测到其他 GitHub 凭据，UsageMesh 会显示隐藏输入框：

```text
GitHub token (hidden; stored locally for scheduled sync):
```

直接粘贴 `github_pat_...` 后按 Enter 即可，终端不回显字符是正常现象。

如果你本来就安装并登录了 GitHub CLI，也可以选择使用：

```bash
gh auth login
gh auth status
```

UsageMesh 会自动尝试读取 `gh auth token`。**GitHub CLI 只是可选方式，不是安装 UsageMesh 的依赖。**

### 3. 安装并初始化 UsageMesh

macOS / Linux：

```bash
curl -fsSL https://raw.githubusercontent.com/Atingaii/UsageMesh/main/install.sh | sh
usagemesh setup
```

Windows PowerShell：

```powershell
irm https://raw.githubusercontent.com/Atingaii/UsageMesh/main/install.ps1 | iex
usagemesh setup
```

`setup` 会根据 GitHub 凭据识别你的账号，发现你自己的 `UsageMesh` Fork，询问 Dashboard 密码，完成第一次全量扫描，并安装系统原生的定时同步任务。

第一次全量同步还会先把用户 Fork 的 `main` 自动同步到当前 `Atingaii/UsageMesh` 上游版本，再上传设备数据。因此即使用户很早以前就 Fork 过，也不需要再手工点击 GitHub 的 **Sync fork**。

GitHub 凭据的读取顺序是：显式 `--token` → `USAGEMESH_GITHUB_TOKEN` / `GITHUB_TOKEN` / `GH_TOKEN` → 已登录的 `gh auth token` → **终端隐藏输入 PAT**。普通用户无需使用 `--token`，避免把 Token 留在 Shell 历史中。

### 4. 打开自己的 Dashboard

```bash
usagemesh dashboard
```

地址由实际 Fork 自动决定。例如账号为 `alice`、Fork 名仍为 `UsageMesh` 时，地址为 `https://alice.github.io/UsageMesh/`。如果 Fork 改名，使用 `usagemesh setup --repo OWNER/RENAMED_REPO` 初始化后，Dashboard 地址也会根据真实仓库名自动生成。

### Dashboard 如何保持最新

用户在 Fork 中启用 **Deploy Dashboard** 以后，每次部署都会直接使用当前 `Atingaii/UsageMesh` 上游的最新 Dashboard 源码，而不是盲目使用用户 Fork 里可能已经过期的 `web-ui` 副本。工作流还会**每天自动部署一次**，因此后续的网页修复可以自动进入用户自己的 GitHub Pages，不需要重新 Fork。

部署后的站点会额外生成 `/build-info.json`，里面记录当前工作区仓库、Dashboard 上游仓库以及本次真正使用的上游 commit SHA。以后如果出现“网页明明设置正确但行为像旧版本”的问题，可以直接判断是否为旧部署，而不会误报成密码错误。

已经安装过 UsageMesh 的设备，需要升级时重新运行安装命令，然后执行：

```bash
usagemesh sync --full
```

它会同时刷新本地历史统计、设备索引，并把 Fork 的源码同步到当前上游版本。

## 添加新设备

已有设备：

```bash
usagemesh invite
```

把输出的完整 `usagemesh join '...'` 命令复制到新设备执行。Pair Code 包含工作区加密密钥和仓库信息，但**不包含 GitHub Token**，仍应把它当作敏感信息。

新设备同样需要自己的 GitHub 写入凭据；可以使用 Fine-grained PAT，也可以使用已经登录的 GitHub CLI。`join` 成功后会完成首次全量同步，因此通常无需立刻再执行一次 `sync --full`。

验证状态：

```bash
usagemesh status
```

## GitHub Pages 打不开怎么办

先确认 Fork 的 **Actions → Deploy Dashboard** 最后一次运行是绿色 `success`，然后确认 **Settings → Pages** 的 Source 为 **GitHub Actions**。

使用 CLI 输出的准确地址：

```bash
usagemesh dashboard
```

如果仍然打不开，可以检查：

```bash
curl -I "$(usagemesh dashboard)"
nslookup github.io
```

- 返回 `200`：Pages 已在线，优先尝试无痕窗口或强制刷新。
- 返回 `404`：确认仓库名称大小写和 Pages 部署；新启用 Pages 时也可能需要短暂传播时间。
- `Could not resolve host` / DNS 失败：这是当前网络到 `github.io` 的解析或可达性问题，换网络或 DNS 后再试，与 UsageMesh 数据同步本身无关。

Dashboard 的静态资源使用相对路径，因此 Fork 改名后也不会依赖固定的 `/UsageMesh/` 资源前缀。

## 为什么分“概览”和“分析”

**概览**只保留适合第一眼判断状态的信息：总体用量、费用估算、趋势、设备与近期活动。

**分析工作台**不再重复概览数字，而是提供缓存命中率、平均 Tokens/请求、平均费用、TOP3 集中度、模型/设备/客户端/模式/路由贡献、设备 × 模型矩阵和高消耗组合，用来定位“哪里消耗最多”和“为什么”。

## 安全设计

- Ledger：AES-256-GCM，上传前加密。
- Dashboard 密码：不保存浏览器明文。
- 浏览器刷新：解锁后的 workspace key 仅放在 `sessionStorage`；刷新不会掉登录，关闭浏览器会话后重新输入密码。
- Pair Code：不含 GitHub PAT，但含 workspace key，必须保密。
- GitHub PAT：不上传，只在设备本地用于同步。
- URL：不放 workspace key、PAT 或 Dashboard 密码。

不要把 PAT 写进命令行、README、Issue、截图或 Pair Code。为了让后台定时同步无需人工输入，手工粘贴的 GitHub 凭据会保存在本机 UsageMesh 配置中；Unix 下配置文件权限为 `0600`。建议使用**最小仓库权限 + 合理有效期**，并保护本机系统账号。

“绝对安全”无法由任何纯客户端工具保证，因此项目明确 Threat Model 和剩余风险，而不是做不现实的承诺。详见 [SECURITY.md](SECURITY.md)。

## 费用口径

Dashboard 展示的是**用量估算 / 订阅等价估算**，不是供应商发票，也不声称等于某个订阅后台的实际扣减。具体规则从主 README 中移出，统一放在 [docs/PRICING.md](docs/PRICING.md)。

## 友情链接

开源技术和开发者交流，欢迎访问 [Linux DO](https://linux.do/)。

## License

MIT，第三方来源与继承关系见 [NOTICE](NOTICE)。
