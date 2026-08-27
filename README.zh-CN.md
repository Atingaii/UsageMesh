<p align="center">
  <img src="docs/assets/usagemesh-hero.svg" alt="UsageMesh — 跨设备 AI Coding 用量分析" width="100%" />
</p>

<p align="center">
  <strong>面向 AI Coding 工具的本地优先、无服务器、跨设备用量分析。</strong><br/>
  每台设备本地采集，使用你自己的 GitHub Fork 同步加密账本，并由你自己的 GitHub Pages 托管 Dashboard。
</p>

<p align="center"><a href="README.md">English</a> · <a href="SECURITY.md">安全模型</a> · <a href="docs/PRICING.md">费用口径</a></p>

> **主 Dashboard：** `https://atingaii.github.io/UsageMesh/`  
> UsageMesh **不预置 Dashboard 密码**。工作区所有者在首次执行 `usagemesh setup` 时于本机自行创建密码。

## UsageMesh 是什么

UsageMesh 解决的是一个具体问题：当 Codex、Claude Code 等 AI Coding 工具分散运行在多台 Mac、Windows、Linux 设备上时，如何在**不自建服务器**的情况下统一查看 Token、请求、缓存、模型、设备和费用估算。

- **跨设备**：多台机器汇总到同一个工作区。
- **本地优先**：本地扫描，不以上传 Prompt、回复、源代码或完整会话为设计目标。
- **上传前加密**：设备账本使用 AES-256-GCM 加密后才写入 GitHub。
- **零服务器**：GitHub 分支承担同步，GitHub Pages 承担网页展示。
- **Fork 即工作区**：数据进入你自己的 Fork，网页属于你自己的 Pages 地址。
- **概览与分析分工明确**：概览回答“用了多少”，分析页回答“为什么高、由谁贡献、结构是否健康”。

## 三步开始

### 1. Fork

Fork `Atingaii/UsageMesh` 到自己的 GitHub 账号并保持 **Public**。纯前端 Dashboard 需要在没有服务器代理的情况下读取密文；实际设备明细在上传前已经加密。

GitHub 对新 Fork 的 Actions 有平台级安全限制，不会自动直接执行上游工作流。因此第一次需要进入 Fork 的 **Actions** 页面启用工作流，然后手动运行一次 **Deploy Dashboard**。如果 Pages 尚未启用，则进入 **Settings → Pages → Source → GitHub Actions**，随后重新运行 **Deploy Dashboard**。

### 2. 安装

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

`setup` 会发现你的 UsageMesh Fork、创建 Dashboard 密码、完成第一次全量扫描，并安装系统原生的定时同步任务。

### 3. 打开自己的网页

```bash
usagemesh dashboard
```

地址由 Fork 自动决定，例如 `https://alice.github.io/UsageMesh/`。请优先使用 `usagemesh dashboard` 输出的地址，不要手工猜测大小写或仓库路径。

## github_pat 怎么配置

推荐优先使用：

```bash
gh auth login
gh auth status
usagemesh setup
```

如果使用 Fine-grained Personal Access Token：

1. GitHub → **Settings → Developer settings → Personal access tokens → Fine-grained tokens**。
2. `Resource owner` 选择自己的账号。
3. `Repository access` 选择 **Only select repositories**，只勾选自己的 `UsageMesh` Fork。
4. `Repository permissions` 设置 **Contents → Read and write**。UsageMesh 的设备同步不需要额外的仓库权限。
5. 设置合理的过期时间并生成 Token。
6. 运行 `usagemesh setup`，在隐藏输入提示处粘贴 `github_pat_...`。

不要把 PAT 写进命令行参数、README、Issue、截图或 Pair Code。UsageMesh 不会把 GitHub Token 上传到仓库；为了后台定时同步，手工输入的凭据会保存在本机配置中，Unix 下文件权限为 `0600`。因此应使用**最小仓库权限 + 合理有效期**并保护本机系统账号。

## 添加新设备

已有设备：

```bash
usagemesh invite
```

把输出的完整 `usagemesh join '...'` 命令复制到新设备执行。Pair Code 包含工作区加密密钥和仓库信息，但**不包含 GitHub Token**，仍应把它当作敏感信息。

完成后：

```bash
usagemesh sync --full
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

“绝对安全”无法由任何纯客户端工具保证，因此项目明确 Threat Model 和剩余风险，而不是做不现实的承诺。详见 [SECURITY.md](SECURITY.md)。

## 费用口径

Dashboard 展示的是**用量估算 / 订阅等价估算**，不是供应商发票，也不声称等于某个订阅后台的实际扣减。具体规则从主 README 中移出，统一放在 [docs/PRICING.md](docs/PRICING.md)。

## 友情链接

开源技术和开发者交流，欢迎访问 [Linux DO](https://linux.do/)。

## License

MIT，第三方来源与继承关系见 [NOTICE](NOTICE)。
