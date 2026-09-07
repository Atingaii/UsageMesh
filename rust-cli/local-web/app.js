const $ = (s, root = document) => root.querySelector(s);
const esc = (v) =>
  String(v ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const money = (v) => "$" + Number(v || 0).toFixed(2);
const num = (v) => Number(v || 0).toLocaleString("zh-CN");
const date = (v) =>
  v && Number.isFinite(new Date(v).getTime())
    ? new Date(v).toLocaleString("zh-CN", { hour12: false })
    : "未知";
const json = (v) => esc(JSON.stringify(v, null, 2));
const getSaved = (key) => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};
let token = new URLSearchParams(location.hash.slice(1)).get("token") || "";
try {
  token ||= sessionStorage.getItem("usagemesh-local-token") || "";
  if (token) sessionStorage.setItem("usagemesh-local-token", token);
} catch {}
if (location.hash) history.replaceState(null, "", location.pathname);
let state,
  section = "overview",
  busy = false;
const sections = {
  overview: ["工作台", "你的 AI 工作，由你掌握。"],
  quota: ["额度中心", "查看来源、有效时间与重置窗口。"],
  projects: ["项目与会话", "从本机记录，找到每一笔用量的去向。"],
  providers: ["供应商配置", "预览变化，再应用到本机工具。"],
  quality: ["渠道质量", "分开观察主动探测和真实请求。"],
  connectors: ["代理连接器", "连接已有代理，读取账号与模型目录。"],
  notifications: ["提醒设置", "在预算、额度与费用变化时提醒。"],
};
document.documentElement.dataset.theme = getSaved("um-local-theme") || "system";
document.documentElement.classList.toggle(
  "large",
  getSaved("um-local-large") === "true",
);
function button(text, action, id = "", extra = "") {
  return `<button type="button" data-action="${action}" data-id="${esc(id)}" ${extra}>${esc(text)}</button>`;
}
function empty(title, text = "") {
  return `<div class="empty"><strong>${esc(title)}</strong><p>${esc(text)}</p></div>`;
}
function field(label, name, value = "", type = "text", extra = "") {
  return `<label>${esc(label)}<input name="${name}" type="${type}" value="${esc(value)}" ${extra}></label>`;
}
function select(label, name, options, value) {
  return `<label>${esc(label)}<select name="${name}">${options.map(([v, l]) => `<option value="${v}" ${v === value ? "selected" : ""}>${esc(l)}</option>`).join("")}</select></label>`;
}
function note(text) {
  return `<p class="note">${esc(text)}</p>`;
}
function toast(message, error = false) {
  const el = $("#status");
  if (el) {
    el.textContent = message;
    el.classList.toggle("error", error);
  }
}
async function api(path, body) {
  const response = await fetch("/api/" + path, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      Authorization: "Bearer " + token,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(180000),
  });
  let v;
  try {
    v = await response.json();
  } catch {
    throw Error("本地服务未返回有效数据，请查看终端。");
  }
  if (!response.ok) {
    if (response.status === 401) {
      token = "";
      try {
        sessionStorage.removeItem("usagemesh-local-token");
      } catch {}
    }
    throw Error(v.error || "请求失败");
  }
  return v;
}
async function refresh() {
  state = await api("state");
  render();
}
function login() {
  $("#app").innerHTML =
    `<main class="login card"><div class="brand-mark">U</div><p class="eyebrow">YOUR LOCAL WORKSPACE</p><h1>连接本地工作台</h1><p>使用 <code>usagemesh serve</code> 启动后，打开终端显示的完整链接。也可在下方粘贴该链接。</p><form id="connect-form">${field("启动链接或访问凭据", "token", "", "password", 'required autocomplete="off" spellcheck="false"')}<button class="primary">连接工作台</button></form><p id="status" role="status" aria-live="polite"></p>${note("凭据仅在本次本地服务中有效。此页面不会上传配置或密钥。")}</main>`;
  $("#connect-form").onsubmit = async (e) => {
    e.preventDefault();
    const raw = new FormData(e.target).get("token").trim();
    try {
      token = raw.startsWith("http")
        ? new URLSearchParams(new URL(raw).hash.slice(1)).get("token")
        : raw;
      if (!token) throw Error("链接中缺少访问凭据");
      await refresh();
      try {
        sessionStorage.setItem("usagemesh-local-token", token);
      } catch {}
    } catch (err) {
      toast(err.message, true);
    }
  };
}
function render() {
  const [title, subtitle] = sections[section];
  $("#app").innerHTML =
    `<aside><a class="brand" href="#" data-action="home"><span class="brand-mark">U</span><span>UsageMesh<small>本地工作台</small></span></a><nav aria-label="工作区">${Object.entries(
      sections,
    )
      .map(
        ([id, [name]]) =>
          `<button data-action="navigate" data-id="${id}" ${section === id ? 'aria-current="page"' : ""}>${name}</button>`,
      )
      .join(
        "",
      )}</nav><div class="sidebar-foot"><span class="live">仅本机访问</span><small>v${esc(state.version)} · ${esc(state.platform)}</small>${button("锁定页面", "lock")}</div></aside><main><header><div><p class="eyebrow">YOUR USAGE. YOUR WORKSPACE.</p><h1>${title}</h1><p>${subtitle}</p></div><div class="actions">${button("刷新数据", "refresh")}${button("扫描本机", "scan", "", 'class="primary"')}</div></header><div id="status" role="status" aria-live="polite"></div>${state.scanError ? `<p class="notice error">${esc(state.scanError)}</p>` : ""}<section id="content">${views[section]()}</section><footer><span>本地数据不会同步到云端面板 · ${state.activity?.updatedAt ? "上次扫描 " + date(state.activity.updatedAt) : "尚未扫描"}</span><div class="actions">${button("切换主题", "theme")}${button(document.documentElement.classList.contains("large") ? "标准字号" : "大字号", "font")}</div></footer></main><dialog id="dialog" aria-labelledby="dialog-title"></dialog>`;
}
const sessions = () => state.activity?.sessions || [];
const projectName = (id) =>
  state.settings.projects[id]?.alias ||
  sessions().find((s) => s.projectId === id)?.project ||
  "未识别项目";
function metrics(items) {
  return `<div class="metrics">${items.map(([label, value, desc]) => `<div class="card"><span>${esc(label)}</span><strong>${esc(value)}</strong><small>${esc(desc || "")}</small></div>`).join("")}</div>`;
}
const views = {
  overview() {
    let month = new Date().toLocaleDateString("sv-SE").slice(0, 7),
      cost = Object.entries(state.activity?.daily || {})
        .filter(([d]) => d.startsWith(month))
        .reduce((s, [, v]) => s + v, 0);
    return (
      metrics([
        ["本月估算费用", money(cost), "本机兼容价卡估算"],
        [
          "项目",
          new Set(sessions().map((s) => s.projectId)).size,
          "本机最近 90 天",
        ],
        ["会话", num(sessions().length), "按来源会话 ID 汇总"],
        ["渠道事件", num(state.events.length), "探测 + 手动导入"],
      ]) +
      `<div class="grid two"><article class="card"><p class="eyebrow">START HERE</p><h2>一个入口，管理本机 AI 工具</h2><p>扫描后查看项目账本；保存供应商方案后，先检查配置差异，再应用。额度连接器可独立使用。</p><div class="actions">${button("查看项目", "navigate", "projects")}${button("管理供应商", "navigate", "providers")}</div></article><article class="card"><h2>运行状态</h2><dl><dt>后台扫描</dt><dd>每 ${state.settings.preferences.scanMinutes} 分钟</dd><dt>系统通知</dt><dd>${state.settings.preferences.notifications ? "已启用" : "未启用"}</dd><dt>数据目录</dt><dd class="path">${esc(state.dataDir)}</dd></dl>${note("关闭浏览器后服务仍继续运行；终止终端中的 serve 进程后，扫描和提醒随之停止。")}</article></div>${note(state.activity?.note || "首次使用请点击“扫描本机”。只读取本机客户端用量记录，不读取对话正文到本地工作台。")}`
    );
  },
  quota() {
    return `<div class="card"><h2>连接额度来源</h2><p>Codex 本机额度快照随扫描更新。已安装并配置 CodexBar 时，可以手动读取以下额度；未授权时会显示具体错误。</p><div class="actions">${["codex", "claude", "gemini"].map((p) => button("读取 " + p, "quota", p)).join("")}</div>${note("额度来自源记录，不能从 Token 数推算订阅余额。读取 CodexBar 最多等待 25 秒。")}</div><div class="grid two">${
      state.quotas.length
        ? state.quotas
            .map((q) => {
              let age = Date.now() - new Date(q.updatedAt).getTime();
              let stale =
                !Number.isFinite(age) || age > 900000 || age < -120000;
              return `<article class="card"><div class="card-head"><h2>${esc(q.provider)}</h2><span class="badge">${stale ? "待更新快照" : "近期快照"}</span></div><p class="small">${esc(q.source)} · ${esc(q.account || "账号身份未核实")}</p>${
                (q.windows || [])
                  .map((w) => {
                    const expired =
                      w.resetsAt && new Date(w.resetsAt).getTime() < Date.now();
                    return `<div class="quota-window"><div class="card-head"><strong>${esc(w.name)}</strong><span>${stale || expired ? "历史剩余" : "观测剩余"} ${Number(w.remainingPercent).toFixed(1)}%</span></div><progress max="100" value="${Number(w.usedPercent)}" aria-label="${esc(w.name)} 已用百分比"></progress><p class="small">重置时间：${date(w.resetsAt)}${expired ? " · 窗口已过期，请刷新" : ""}</p></div>`;
                  })
                  .join("") ||
                empty(
                  "暂时没有额度记录",
                  "先在对应 CLI 中使用一次，再扫描；或连接 CodexBar。",
                )
              }<p class="small">记录时间：${date(q.updatedAt)}</p>${note(q.note || "")}</article>`;
            })
            .join("")
        : empty("尚未读取额度", "扫描本机，或连接已配置的 CodexBar。")
    }</div>`;
  },
  projects() {
    return `<div class="card"><div class="card-head"><h2>项目账本</h2>${button("导出会话 CSV", "export-sessions")}</div><label>搜索项目、标签或客户端<input id="project-search" type="search" placeholder="搜索本机记录"></label><div id="projects-table">${projectTable("")}</div></div>${note(state.activity?.note || "请先扫描本机。")}`;
  },
  providers() {
    return `<div class="card"><div class="card-head"><h2>供应商方案</h2>${button("新增方案", "new-provider", "", 'class="primary"')}</div>${note("保存方案不会立即切换。密钥只保存环境变量名；应用到 Claude Code 时会将对应密钥写入其本机设置，页面始终脱敏显示。")}<div class="stack">${state.settings.providers.map((p) => `<article class="item"><div><strong>${esc(p.name)}</strong><p class="small">${esc(p.tool)} · ${esc(p.model)}<br>${esc(p.baseUrl)}<br>凭据：${esc(p.keyEnv || (p.tool === "claude" ? "保留已有配置凭据" : "未指定（用于无需认证的本地接口）"))}</p></div><div class="actions">${button("预览并应用", "preview", p.id)}${button("连接测试", "probe", p.id)}${button("编辑", "edit-provider", p.id)}${button("删除方案", "delete-provider", p.id)}</div></article>`).join("") || empty("还没有供应商方案", "新增后可测试连接，并预览配置差异。")}</div></div><div class="grid two">${state.tools.map((t) => `<article class="card"><h2>${esc(t.tool)} 当前设置</h2><p class="path small">${esc(t.path)}</p>${t.error ? note(t.error) : `<details><summary>${t.exists ? "查看脱敏配置" : "配置尚不存在"}</summary><pre>${json(t.config)}</pre></details>`}</article>`).join("")}</div><div class="card"><h2>配置备份与回滚</h2>${note("只在当前文件仍与该次应用结果一致时允许回滚，避免覆盖其他工具的修改。备份仅保存在本机。")}<div class="stack">${state.backups.map((b) => `<div class="item"><span>${esc(b.tool)} · ${date(b.at)}</span>${button("回滚此更改", "rollback", b.id)}</div>`).join("") || empty("暂无备份", "每次应用前自动创建。")}</div></div>`;
  },
  quality() {
    return `<div class="card"><div class="card-head"><h2>渠道观测</h2><div class="actions">${button("导入 JSON", "import-events")}${button("导出事件", "export-events")}</div></div>${note("主动探测记录响应头耗时；导入记录的 latencyMs 由日志生产者定义。两种来源分开统计。HTTP 0 表示网络失败；缺少 retry 时保持未知。")}${qualityTable()}<details><summary>导入格式与约束</summary><pre>${json([{ id: "unique-request-id", channel: "My provider", status: 200, latencyMs: 430, at: "2026-09-07T09:00:00Z", retry: false }])}</pre>${note("JSON 数组，最大 2MB、10000 条；按 id 去重，只保留这些字段。不要上传提示词、响应内容或密钥。")}</details></div>`;
  },
  connectors() {
    return `<div class="card"><div class="card-head"><h2>已有代理服务</h2>${button("添加连接器", "new-connector", "", 'class="primary"')}</div><p>连接 CLIProxyAPI 的账号元数据，或 LiteLLM / OpenAI 兼容接口的模型目录。</p>${note("只读访问。不会创建代理内核、切换账号或下载认证文件。管理密钥通过服务进程环境变量引用。")}<div class="stack">${state.settings.connectors.map((c) => `<article class="item"><div><strong>${esc(c.name)}</strong><p class="small">${esc(c.kind)} · ${esc(c.baseUrl)}</p></div><div class="actions">${button("读取目录", "inspect", c.id)}${button("编辑", "edit-connector", c.id)}${button("删除", "delete-connector", c.id)}</div></article>`).join("") || empty("尚未连接代理", "先在本机启动已有代理，再填入接口地址。")}</div></div>`;
  },
  notifications() {
    const p = state.settings.preferences;
    return `<div class="card"><h2>通知与扫描</h2><form id="preferences" class="grid two"><label class="check"><input name="notifications" type="checkbox" ${p.notifications ? "checked" : ""}> 启用系统通知</label><div></div>${field("本月预算（USD，0 为关闭）", "monthlyBudget", p.monthlyBudget, "number", 'min="0" step="0.01" required')}${field("额度使用提醒（%）", "quotaThreshold", p.quotaThreshold, "number", 'min="1" max="100" required')}${field("同一提醒冷却（分钟）", "cooldownMinutes", p.cooldownMinutes, "number", 'min="1" max="1440" required')}${field("自动扫描间隔（分钟）", "scanMinutes", p.scanMinutes, "number", 'min="1" max="60" required')}${field("费用突增倍数", "spikeFactor", p.spikeFactor, "number", 'min="1.1" max="20" step="0.1" required')}<div class="actions"><button class="primary">保存设置</button>${button("测试系统通知", "notify-test")}</div></form>${note("费用突增与前 7 天日均比较，日均至少 $1 才触发。仅新鲜且未过期的额度快照用于提醒。项目预算在项目账本内设置。系统勿扰可能阻止通知显示。")}</div><div class="card"><h2>最近提醒</h2>${
      state.alerts.length
        ? `<div class="stack">${[...state.alerts]
            .reverse()
            .map(
              (a) =>
                `<article class="item"><div><strong>${esc(a.message)}</strong><p class="small">${date(a.at)} · ${a.state === "active" ? "达到阈值" : "状态变化"} · ${a.notified ? "已发送系统通知" : "仅工作台记录"}</p></div></article>`,
            )
            .join("")}</div>`
        : empty("暂无提醒", "服务运行期间按设置检查，不满足阈值时不会打扰。")
    }</div>`;
  },
};
function projectTable(query) {
  const groups = new Map();
  for (const s of sessions()) {
    const id = s.projectId;
    let p = groups.get(id) || {
      id,
      name: projectName(id),
      cost: 0,
      month: 0,
      tokens: 0,
      count: 0,
      clients: new Set(),
      lower: false,
    };
    p.cost += s.cost;
    p.month += s.monthCost;
    p.tokens += s.tokens;
    p.count++;
    p.clients.add(s.client);
    p.lower ||= s.lowerBound;
    groups.set(id, p);
  }
  const rows = [...groups.values()].filter((p) =>
    (
      p.name +
      " " +
      [...p.clients] +
      " " +
      (state.settings.projects[p.id]?.tags || [])
    )
      .toLowerCase()
      .includes(query.toLowerCase()),
  );
  return rows.length
    ? `<div class="table-wrap"><table><thead><tr><th>项目</th><th>会话</th><th>Token</th><th>本月估算</th><th>90 天估算</th><th>操作</th></tr></thead><tbody>${rows.map((p) => `<tr><td><strong>${esc(p.name)}</strong><div class="small">${esc([...p.clients].join(" · "))}</div><div class="small">${esc((state.settings.projects[p.id]?.tags || []).join(" · "))}</div></td><td>${num(p.count)}</td><td>${num(p.tokens)}</td><td>${money(p.month)}${state.settings.projects[p.id]?.budget ? ` / ${money(state.settings.projects[p.id].budget)}` : ""}</td><td>${p.lower ? "≥ " : ""}${money(p.cost)}</td><td><div class="actions">${button("会话", "sessions", p.id)}${button("设置", "project", p.id)}</div></td></tr>`).join("")}</tbody></table></div>`
    : empty("没有匹配的项目", "扫描本机记录，或尝试其他搜索词。");
}
function qualityTable() {
  const groups = new Map();
  for (const e of state.events) {
    const source =
        e.kind === "imported"
          ? "导入请求"
          : e.kind === "generation-probe"
            ? "生成探测"
            : "模型目录探测",
      key = JSON.stringify([e.channel, source]);
    let g = groups.get(key) || { channel: e.channel, source, rows: [] };
    g.rows.push(e);
    groups.set(key, g);
  }
  return groups.size
    ? `<div class="table-wrap"><table><thead><tr><th>渠道 / 来源</th><th>事件数</th><th>错误率</th><th>P50 / P95</th><th>限流</th><th>重试</th></tr></thead><tbody>${[
        ...groups.values(),
      ]
        .map((g) => {
          const a = g.rows,
            times = a.map((r) => Number(r.latencyMs)).sort((a, b) => a - b),
            pct = (p) =>
              Math.round(times[Math.max(0, Math.ceil(times.length * p) - 1)]),
            known = a.filter((r) => typeof r.retry === "boolean");
          return `<tr><td>${esc(g.channel)}<div class="small">${g.source}</div></td><td>${a.length}</td><td>${((100 * a.filter((r) => r.status === 0 || r.status >= 400).length) / a.length).toFixed(1)}%</td><td>${pct(0.5)} / ${pct(0.95)} ms</td><td>${a.filter((r) => r.status === 429).length}</td><td>${known.length ? known.filter((r) => r.retry).length + " / " + known.length + " 已知" : "未知"}</td></tr>`;
        })
        .join("")}</tbody></table></div>`
    : empty("还没有渠道事件", "在供应商配置中测试连接，或导入结构化请求日志。");
}
function modal(title, html) {
  const d = $("#dialog");
  d.innerHTML = `<div class="card-head"><h2 id="dialog-title">${esc(title)}</h2>${button("关闭", "close")}</div>${html}`;
  d.showModal();
}
function providerForm(p = {}) {
  modal(
    p.id ? "编辑供应商" : "新增供应商",
    `<form id="provider-form"><input type="hidden" name="id" value="${esc(p.id || crypto.randomUUID())}"><div class="grid two">${field("方案名称", "name", p.name || "", "", 'required maxlength="100"')}${select(
      "工具",
      "tool",
      [
        ["codex", "Codex"],
        ["claude", "Claude Code"],
      ],
      p.tool || "codex",
    )}${field("接口地址", "baseUrl", p.baseUrl || "https://api.openai.com/v1", "url", "required")}${field("模型 ID", "model", p.model || "", "", 'required maxlength="150"')}${field("凭据环境变量名（可选）", "keyEnv", p.keyEnv || "", "", 'pattern="[A-Z_][A-Z0-9_]*" placeholder="例如 OPENAI_API_KEY" autocomplete="off"')}</div>${note("这里只填写变量名，不填写密钥。先在启动 serve 的终端设置变量。Codex CLI 也需要继承该变量；Claude 应用时会将值写入其私有本机设置。")}<button class="primary">保存方案</button><p class="form-error" role="alert"></p></form>`,
  );
}
function connectorForm(c = {}) {
  modal(
    c.id ? "编辑连接器" : "添加连接器",
    `<form id="connector-form"><input type="hidden" name="id" value="${esc(c.id || crypto.randomUUID())}"><div class="grid two">${field("名称", "name", c.name || "", "", 'required maxlength="100"')}${select(
      "代理类型",
      "kind",
      [
        ["cliproxy", "CLIProxyAPI"],
        ["litellm", "LiteLLM"],
        ["openai", "OpenAI 兼容"],
      ],
      c.kind || "cliproxy",
    )}${field("接口根地址", "baseUrl", c.baseUrl || "http://127.0.0.1:8317", "url", "required")}${field("密钥环境变量名（可选）", "keyEnv", c.keyEnv || "", "", 'pattern="[A-Z_][A-Z0-9_]*" autocomplete="off"')}</div>${note("CLIProxyAPI 填服务根地址；另外两类填模型接口前缀（如 http://127.0.0.1:4000/v1）。")}<button class="primary">保存连接器</button><p class="form-error" role="alert"></p></form>`,
  );
}
function download(name, body, type = "application/json") {
  const url = URL.createObjectURL(new Blob([body], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function csvCell(v) {
  let s = String(v ?? "");
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return '"' + s.replaceAll('"', '""') + '"';
}
let preview;
async function act(action, id) {
  if (action === "close") return $("#dialog").close();
  if (action === "home") ((action = "navigate"), (id = "overview"));
  if (action === "navigate") {
    section = id;
    render();
    window.scrollTo(0, 0);
    return;
  }
  if (action === "lock") {
    token = "";
    try {
      sessionStorage.removeItem("usagemesh-local-token");
    } catch {}
    login();
    return;
  }
  if (action === "theme") {
    const list = ["system", "light", "dark"];
    const next =
      list[(list.indexOf(document.documentElement.dataset.theme) + 1) % 3];
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem("um-local-theme", next);
    } catch {}
    toast("主题：" + { system: "跟随系统", light: "浅色", dark: "深色" }[next]);
    return;
  }
  if (action === "font") {
    document.documentElement.classList.toggle("large");
    try {
      localStorage.setItem(
        "um-local-large",
        document.documentElement.classList.contains("large"),
      );
    } catch {}
    render();
    return;
  }
  if (action === "new-provider") return providerForm();
  if (action === "edit-provider")
    return providerForm(state.settings.providers.find((p) => p.id === id));
  if (action === "new-connector") return connectorForm();
  if (action === "edit-connector")
    return connectorForm(state.settings.connectors.find((c) => c.id === id));
  if (action === "project") {
    const p = state.settings.projects[id] || {
      alias: projectName(id),
      tags: [],
      budget: 0,
    };
    return modal(
      "项目设置",
      `<form id="project-form"><input type="hidden" name="id" value="${esc(id)}">${field("显示名称", "alias", p.alias, "text", 'maxlength="120"')}${field("标签（用逗号分隔）", "tags", p.tags.join(", "))}${field("本月预算（USD，0 为关闭）", "budget", p.budget, "number", 'min="0" step="0.01" required')}<button class="primary">保存项目设置</button><p class="form-error" role="alert"></p></form>`,
    );
  }
  if (action === "sessions")
    return modal(
      projectName(id) + " · 会话",
      `<div class="stack">${sessions()
        .filter((s) => s.projectId === id)
        .map(
          (s) =>
            `<div class="item"><div><strong>${esc(s.client)} · ${date(s.lastAt)}</strong><p class="small">${s.lowerBound ? "≥ " : ""}${money(s.cost)} · ${num(s.tokens)} Token · ${num(s.requests)} 消息</p></div>${button("请求明细", "requests", s.id)}</div>`,
        )
        .join("")}</div>`,
    );
  if (action === "requests") {
    const rows = (state.activity?.requests || []).filter(
      (r) => r.sessionId === id,
    );
    return modal(
      "会话请求明细",
      `${note("只展示本次保留的请求记录；消息可能由来源聚合，耗时未知时不估算。")}<div class="table-wrap"><table><thead><tr><th>时间</th><th>模型 / 渠道</th><th>Token</th><th>估算费用</th><th>源耗时</th></tr></thead><tbody>${rows.map((r) => `<tr><td>${date(r.at)}</td><td>${esc(r.model)}<div class="small">${esc(r.provider || "未知")}</div></td><td>${num(r.tokens)}</td><td>${r.lowerBound ? "≥ " : ""}${money(r.cost)}</td><td>${r.durationMs == null ? "未知" : num(r.durationMs) + " ms"}</td></tr>`).join("")}</tbody></table></div>`,
    );
  }
  if (action === "export-sessions") {
    return download(
      "usagemesh-sessions.csv",
      "\uFEFF" +
        [
          ["项目", "客户端", "最近活动", "Token", "估算USD", "费用下界"],
          ...sessions().map((s) => [
            projectName(s.projectId),
            s.client,
            date(s.lastAt),
            s.tokens,
            s.cost,
            s.lowerBound,
          ]),
        ]
          .map((r) => r.map(csvCell).join(","))
          .join("\r\n"),
      "text/csv;charset=utf-8",
    );
  }
  if (action === "export-events")
    return download(
      "usagemesh-events.json",
      JSON.stringify(state.events, null, 2),
    );
  if (action === "import-events")
    return modal(
      "导入渠道事件",
      `<form id="events-form"><label>选择 JSON 文件<input type="file" name="file" accept=".json,application/json" required></label>${note("文件不超过 2MB。会先验证全部事件，再按 id 合并。")}<button class="primary">验证并导入</button><p class="form-error" role="alert"></p></form>`,
    );
  if (action === "probe")
    return modal(
      "连接测试",
      `<p>默认只读取模型目录。生成测试会发送“Reply OK”，可能产生少量 API 费用。</p><form id="probe-form"><input type="hidden" name="id" value="${esc(id)}"><label class="check"><input name="generate" type="checkbox"> 我选择执行一次可能计费的生成测试</label><button class="primary">执行测试</button><p class="form-error" role="alert"></p></form>`,
    );
  if (
    action === "delete-provider" ||
    action === "delete-connector" ||
    action === "rollback"
  )
    return modal(
      action === "rollback" ? "确认回滚配置" : "确认删除",
      `<p>${action === "rollback" ? "恢复这次应用之前的本机配置；如果期间有其他修改，将拒绝覆盖。" : "移除保存的方案。此操作不会修改外部工具当前配置。"}</p>${button("确认执行", "confirm-" + action, id, 'class="primary"')}`,
    );
  let result;
  if (action === "refresh") {
    await refresh();
    return toast("已刷新本地快照");
  }
  if (action === "scan") result = await api("scan", {});
  if (action === "quota") {
    result = await api("quota", { provider: id });
    result.message = "额度来源已读取";
  }
  if (action === "notify-test") result = await api("notify-test", {});
  if (action === "preview") {
    preview = await api("provider/preview", { id });
    preview.id = id;
    return modal(
      "确认配置差异",
      `<p class="path">${esc(preview.path)}</p><div class="grid two"><div><h3>当前（脱敏）</h3><pre>${json(preview.before)}</pre></div><div><h3>应用后（脱敏）</h3><pre>${json(preview.after)}</pre></div></div>${note(preview.note)}${button("备份并应用此配置", "apply", id, 'class="primary"')}`,
    );
  }
  if (action === "apply") {
    result = await api("provider/apply", {
      id,
      beforeHash: preview.beforeHash,
      afterHash: preview.afterHash,
    });
  }
  if (action === "inspect") {
    const data = await api("connector/inspect", { id });
    return modal(
      "代理目录",
      `${note(data.note)}<p class="small">${date(data.at)} · ${data.items.length} 项</p><pre>${json(data.items)}</pre>`,
    );
  }
  if (action === "confirm-delete-provider")
    result = await api("provider/delete", { id });
  if (action === "confirm-delete-connector")
    result = await api("connector/delete", { id });
  if (action === "confirm-rollback") result = await api("rollback", { id });
  if (result) {
    await refresh();
    toast(result.message || "操作已完成");
  }
}
document.addEventListener("click", async (e) => {
  const b = e.target.closest("[data-action]");
  if (!b) return;
  e.preventDefault();
  if (busy) return;
  busy = true;
  b.disabled = true;
  try {
    await act(b.dataset.action, b.dataset.id);
  } catch (err) {
    const d = $("#dialog");
    if (d?.open) {
      let el = $(".form-error", d);
      if (!el) {
        el = document.createElement("p");
        el.className = "form-error";
        el.setAttribute("role", "alert");
        d.append(el);
      }
      el.textContent = err.message;
    } else toast(err.message, true);
    if (!token) login();
  } finally {
    busy = false;
    b.disabled = false;
  }
});
document.addEventListener("input", (e) => {
  if (e.target.id === "project-search")
    $("#projects-table").innerHTML = projectTable(e.target.value);
});
document.addEventListener("submit", async (e) => {
  const form = e.target;
  if (form.getAttribute("id") === "connect-form") return;
  e.preventDefault();
  if (busy) return;
  busy = true;
  const b = $('button[type="submit"],button:not([type])', form);
  if (b) b.disabled = true;
  const error = $(".form-error", form);
  if (error) error.textContent = "";
  try {
    const d = Object.fromEntries(new FormData(form));
    let result;
    if (form.getAttribute("id") === "provider-form")
      result = await api("provider", d);
    if (form.getAttribute("id") === "connector-form")
      result = await api("connector", d);
    if (form.getAttribute("id") === "project-form")
      result = await api("project", {
        id: d.id,
        meta: {
          alias: d.alias,
          tags: d.tags
            .split(/[,，]/)
            .map((s) => s.trim())
            .filter(Boolean),
          budget: Number(d.budget),
        },
      });
    if (form.getAttribute("id") === "preferences")
      result = await api("preferences", {
        notifications: d.notifications === "on",
        monthlyBudget: Number(d.monthlyBudget),
        quotaThreshold: Number(d.quotaThreshold),
        cooldownMinutes: Number(d.cooldownMinutes),
        scanMinutes: Number(d.scanMinutes),
        spikeFactor: Number(d.spikeFactor),
      });
    if (form.getAttribute("id") === "events-form") {
      if (d.file.size > 2000000) throw Error("文件超过 2MB");
      result = await api("events", JSON.parse(await d.file.text()));
    }
    if (form.getAttribute("id") === "probe-form") {
      result = await api("provider/probe", {
        id: d.id,
        generate: d.generate === "on",
      });
      await refresh();
      return modal(
        "连接测试结果",
        `<p>${esc(result.message)} · HTTP ${result.status || "网络失败"}</p><p>响应头耗时 ${num(result.latencyMs)} ms</p>${result.models.length ? `<pre>${json(result.models)}</pre>` : ""}`,
      );
    }
    if (result) {
      await refresh();
      toast(result.message || "已保存");
    }
  } catch (err) {
    if (error) error.textContent = err.message;
    else toast(err.message, true);
  } finally {
    busy = false;
    if (b) b.disabled = false;
  }
});
if (token) {
  refresh().catch((err) => {
    login();
    toast(err.message, true);
  });
} else login();

window.addEventListener("hashchange", async () => {
  const next = new URLSearchParams(location.hash.slice(1)).get("token");
  if (!next) return;
  token = next;
  history.replaceState(null, "", location.pathname);
  try {
    await refresh();
    try {
      sessionStorage.setItem("usagemesh-local-token", token);
    } catch {}
  } catch (err) {
    login();
    toast(err.message, true);
  }
});
