mod activity;
mod alerts;
mod configure;
mod network;
mod quota;
mod store;
use anyhow::{bail, Context, Result};
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    io::Read,
    path::PathBuf,
    time::{Duration, Instant},
};
use store::*;
use tiny_http::{Header, Method, Request, Response, Server, StatusCode};
struct State {
    paths: Paths,
    settings: Settings,
    activity: Value,
    quotas: Vec<Value>,
    events: Vec<Value>,
    alerts: Vec<Value>,
    active: BTreeMap<String, i64>,
    last_scan: Instant,
    scan_error: Option<String>,
}
impl State {
    fn save(&self) -> Result<()> {
        private_write(
            &self.paths.settings(),
            &serde_json::to_vec_pretty(&self.settings)?,
        )
    }
    fn scan(&mut self) -> Result<()> {
        self.last_scan = Instant::now();
        match activity::scan(&self.paths) {
            Ok(v) => {
                private_write(
                    &self.paths.data.join("activity.json"),
                    &serde_json::to_vec(&v)?,
                )?;
                self.activity = v;
                self.scan_error = None;
                self.check();
                Ok(())
            }
            Err(e) => {
                self.scan_error = Some("扫描失败，保留上次快照；请检查本地客户端日志权限".into());
                Err(e)
            }
        }
    }
    fn check(&mut self) {
        let codex = quota::codex(&self.paths);
        if let Some(index) = self
            .quotas
            .iter()
            .position(|q| q["source"] == "local-cli-telemetry")
        {
            self.quotas[index] = codex
        } else {
            self.quotas.push(codex)
        }
        alerts::evaluate(
            &self.activity,
            &self.quotas,
            &self.settings.preferences,
            &self.settings.projects,
            &mut self.active,
            &mut self.alerts,
        );
        let _ = private_write(
            &self.paths.data.join("alerts.json"),
            &serde_json::to_vec(&json!({"history":self.alerts,"active":self.active})).unwrap(),
        );
    }
    fn api(&mut self, method: &Method, path: &str, body: Value) -> Result<Value> {
        match (method, path) {
            (&Method::Get, "/api/state") => Ok(
                json!({"version":env!("CARGO_PKG_VERSION"),"settings":self.settings,"activity":self.activity,"scanError":self.scan_error,"quotas":self.quotas,"events":self.events,"alerts":self.alerts,"tools":configure::inventory(&self.paths),"backups":configure::backups(&self.paths)?,"dataDir":self.paths.data,"platform":std::env::consts::OS}),
            ),
            (&Method::Post, "/api/scan") => {
                self.scan()?;
                Ok(json!({"message":"本机扫描已完成"}))
            }
            (&Method::Post, "/api/quota") => {
                let provider = body["provider"].as_str().context("需要供应商")?;
                let q = quota::fetch_codexbar(provider)?;
                self.quotas
                    .retain(|r| r["provider"] != provider || r["source"] == "local-cli-telemetry");
                self.quotas.push(q.clone());
                self.check();
                Ok(q)
            }
            (&Method::Post, "/api/preferences") => {
                let p: Preferences = serde_json::from_value(body)?;
                if !p.monthly_budget.is_finite()
                    || p.monthly_budget < 0.
                    || !(1.0..=100.).contains(&p.quota_threshold)
                    || !(1..=1440).contains(&p.cooldown_minutes)
                    || !(1..=60).contains(&p.scan_minutes)
                    || !(1.1..=20.).contains(&p.spike_factor)
                {
                    bail!("提醒阈值无效")
                };
                self.settings.preferences = p;
                self.save()?;
                self.check();
                Ok(json!({"message":"提醒设置已保存，服务运行期间持续检查"}))
            }
            (&Method::Post, "/api/notify-test") => Ok(
                json!({"message":if alerts::notify("本地通知已连接。"){"通知命令已发送；系统勿扰和权限设置可能影响显示"}else{"系统通知不可用，请检查系统权限；Linux 需要 notify-send"}}),
            ),
            (&Method::Post, "/api/project") => {
                let id = body["id"].as_str().context("需要项目 id")?;
                validate_id(id)?;
                let meta: ProjectMeta = serde_json::from_value(body["meta"].clone())?;
                activity::validate_project(&meta)?;
                self.settings.projects.insert(id.into(), meta);
                self.save()?;
                Ok(json!({"message":"项目别名、标签和预算已保存"}))
            }
            (&Method::Post, "/api/provider") => {
                let p: Provider = serde_json::from_value(body)?;
                validate_id(&p.id)?;
                validate_url(&p.base_url)?;
                validate_env(&p.key_env)?;
                self.paths.tool(&p.tool)?;
                if p.name.trim().is_empty()
                    || p.name.len() > 100
                    || p.model.trim().is_empty()
                    || p.model.len() > 150
                {
                    bail!("名称或模型无效")
                };
                if self.settings.providers.len() >= 50
                    && !self.settings.providers.iter().any(|v| v.id == p.id)
                {
                    bail!("最多保存 50 个供应商")
                };
                self.settings.providers.retain(|v| v.id != p.id);
                self.settings.providers.push(p);
                self.save()?;
                Ok(json!({"message":"供应商已保存，尚未修改工具配置"}))
            }
            (&Method::Post, "/api/provider/delete") => {
                let id = body["id"].as_str().context("需要 id")?;
                self.settings.providers.retain(|p| p.id != id);
                self.save()?;
                Ok(json!({"message":"已删除保存方案；工具当前配置不变"}))
            }
            (&Method::Post, "/api/provider/preview")
            | (&Method::Post, "/api/provider/apply")
            | (&Method::Post, "/api/provider/probe") => {
                let p = self
                    .settings
                    .providers
                    .iter()
                    .find(|p| body["id"] == p.id)
                    .context("供应商不存在")?
                    .clone();
                if path.ends_with("probe") {
                    let v = network::probe(&p, body["generate"] == true)?;
                    self.events.push(v.clone());
                    self.events.reverse();
                    self.events.truncate(10000);
                    self.events.reverse();
                    private_write(
                        &self.paths.data.join("events.json"),
                        &serde_json::to_vec(&self.events)?,
                    )?;
                    return Ok(v);
                }
                let plan = configure::plan(&self.paths, &p)?;
                if path.ends_with("preview") {
                    configure::preview(&plan)
                } else {
                    configure::apply(
                        &self.paths,
                        plan,
                        body["beforeHash"].as_str().context("请先预览")?,
                        body["afterHash"].as_str().context("请先预览")?,
                    )
                }
            }
            (&Method::Post, "/api/rollback") => {
                configure::rollback(&self.paths, body["id"].as_str().context("需要备份 id")?)
            }
            (&Method::Post, "/api/connector") => {
                let c: Connector = serde_json::from_value(body)?;
                validate_id(&c.id)?;
                validate_url(&c.base_url)?;
                validate_env(&c.key_env)?;
                if c.name.is_empty()
                    || c.name.len() > 100
                    || !matches!(c.kind.as_str(), "cliproxy" | "litellm" | "openai")
                {
                    bail!("连接器配置无效")
                };
                if self.settings.connectors.len() >= 20
                    && !self.settings.connectors.iter().any(|v| v.id == c.id)
                {
                    bail!("最多 20 个连接器")
                };
                self.settings.connectors.retain(|v| v.id != c.id);
                self.settings.connectors.push(c);
                self.save()?;
                Ok(json!({"message":"代理连接器已保存"}))
            }
            (&Method::Post, "/api/connector/delete") => {
                self.settings.connectors.retain(|v| body["id"] != v.id);
                self.save()?;
                Ok(json!({"message":"连接器已删除"}))
            }
            (&Method::Post, "/api/connector/inspect") => network::inspect(
                self.settings
                    .connectors
                    .iter()
                    .find(|c| body["id"] == c.id)
                    .context("连接器不存在")?,
            ),
            (&Method::Post, "/api/events") => {
                let rows = activity::validate_events(&body)?;
                let mut existing: BTreeMap<String, Value> = self
                    .events
                    .drain(..)
                    .filter_map(|v| v["id"].as_str().map(|id| (id.to_string(), v.clone())))
                    .collect();
                for row in rows {
                    existing.insert(row["id"].as_str().unwrap().into(), row);
                }
                self.events = existing.into_values().collect();
                self.events.sort_by_key(|v| {
                    v["at"]
                        .as_str()
                        .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
                        .map(|t| t.timestamp_millis())
                });
                if self.events.len() > 10000 {
                    self.events.drain(0..self.events.len() - 10000);
                }
                private_write(
                    &self.paths.data.join("events.json"),
                    &serde_json::to_vec(&self.events)?,
                )?;
                Ok(json!({"message":"结构化渠道事件已导入，按 id 去重；不导入提示词或响应内容"}))
            }
            _ => bail!("接口不存在"),
        }
    }
}
fn header<'a>(request: &'a Request, name: &'static str) -> Option<&'a str> {
    request
        .headers()
        .iter()
        .find(|h| h.field.equiv(name))
        .map(|h| h.value.as_str())
}
fn authorized(
    host: Option<&str>,
    origin: Option<&str>,
    auth: Option<&str>,
    expected_host: &str,
    token: &str,
) -> bool {
    host == Some(expected_host)
        && origin.is_none_or(|o| o == format!("http://{expected_host}"))
        && auth == Some(format!("Bearer {token}").as_str())
}
fn respond(request: Request, status: u16, body: Vec<u8>, content: &str) {
    let mut r = Response::from_data(body).with_status_code(StatusCode(status));
    for(name,value)in[("Content-Type",content),("Cache-Control","no-store"),("X-Content-Type-Options","nosniff"),("Referrer-Policy","no-referrer"),("Content-Security-Policy","default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'; form-action 'self'")]{r.add_header(Header::from_bytes(name,value).unwrap());}
    let _ = request.respond(r);
}
pub fn serve(port: u16, open: bool, home: Option<PathBuf>, data: Option<PathBuf>) -> Result<()> {
    let paths = Paths::new(home, data)?;
    let settings = load(&paths.settings())?;
    let activity = load(&paths.data.join("activity.json"))?;
    let events = load(&paths.data.join("events.json"))?;
    let prior: Value = load(&paths.data.join("alerts.json"))?;
    let mut state = State {
        paths,
        settings,
        activity,
        events,
        quotas: vec![],
        alerts: serde_json::from_value(prior["history"].clone()).unwrap_or_default(),
        active: serde_json::from_value(prior["active"].clone()).unwrap_or_default(),
        last_scan: Instant::now(),
        scan_error: None,
    };
    state.check();
    let server = Server::http((std::net::Ipv4Addr::LOCALHOST, port))
        .map_err(|e| anyhow::anyhow!("无法启动本地服务: {e}"))?;
    let addr = server.server_addr().to_ip().context("本地地址不可用")?;
    let host = addr.to_string();
    let token = hex::encode(rand::random::<[u8; 32]>());
    let url = format!("http://{host}/#token={token}");
    println!("UsageMesh local workspace: {url}\n仅本机可访问；关闭此进程会停止后台提醒。访问链接含本次启动凭据，请勿分享。");
    if open {
        open_browser(&url);
    }
    loop {
        if state.last_scan.elapsed()
            > Duration::from_secs(u64::from(state.settings.preferences.scan_minutes) * 60)
        {
            let _ = state.scan();
        }
        let Some(mut request) = server.recv_timeout(Duration::from_secs(1))? else {
            continue;
        };
        let path = request.url().split('?').next().unwrap_or("").to_string();
        if header(&request, "Host") != Some(host.as_str()) {
            respond(request, 403, b"Forbidden host".to_vec(), "text/plain");
            continue;
        }
        if request.method() == &Method::Get && path == "/favicon.ico" {
            respond(request, 204, Vec::new(), "image/x-icon");
            continue;
        }
        if request.method() == &Method::Get
            && matches!(path.as_str(), "/" | "/app.js" | "/style.css" | "/icons.js")
        {
            let (body, kind) = match path.as_str() {
                "/icons.js" => (
                    include_bytes!("../../local-web/icons.js").as_slice(),
                    "text/javascript; charset=utf-8",
                ),
                "/app.js" => (
                    include_bytes!("../../local-web/app.js").as_slice(),
                    "text/javascript; charset=utf-8",
                ),
                "/style.css" => (
                    include_bytes!("../../local-web/style.css").as_slice(),
                    "text/css; charset=utf-8",
                ),
                _ => (
                    include_bytes!("../../local-web/index.html").as_slice(),
                    "text/html; charset=utf-8",
                ),
            };
            respond(request, 200, body.to_vec(), kind);
            continue;
        }
        if !authorized(
            header(&request, "Host"),
            header(&request, "Origin"),
            header(&request, "Authorization"),
            &host,
            &token,
        ) {
            respond(
                request,
                401,
                "{\"error\":\"访问凭据无效，请使用终端显示的本次启动链接\"}"
                    .as_bytes()
                    .to_vec(),
                "application/json",
            );
            continue;
        }
        let method = request.method().clone();
        let body = if method == Method::Post {
            if request.body_length().is_none_or(|n| n > 2_000_000)
                || !header(&request, "Content-Type")
                    .is_some_and(|s| s.starts_with("application/json"))
            {
                respond(
                    request,
                    400,
                    b"{\"error\":\"JSON body required, max 2MB\"}".to_vec(),
                    "application/json",
                );
                continue;
            }
            let mut bytes = Vec::new();
            if request
                .as_reader()
                .take(2_000_001)
                .read_to_end(&mut bytes)
                .is_err()
            {
                respond(request, 400, b"Invalid body".to_vec(), "text/plain");
                continue;
            }
            match serde_json::from_slice(&bytes) {
                Ok(v) => v,
                Err(_) => {
                    respond(
                        request,
                        400,
                        b"{\"error\":\"Invalid JSON\"}".to_vec(),
                        "application/json",
                    );
                    continue;
                }
            }
        } else {
            Value::Null
        };
        match state.api(&method, &path, body) {
            Ok(v) => respond(request, 200, serde_json::to_vec(&v)?, "application/json"),
            Err(e) => respond(
                request,
                400,
                serde_json::to_vec(&json!({"error":e.to_string()}))?,
                "application/json",
            ),
        }
    }
}
fn open_browser(url: &str) {
    #[cfg(target_os = "macos")]
    let _ = std::process::Command::new("open").arg(url).spawn();
    #[cfg(target_os = "linux")]
    let _ = std::process::Command::new("xdg-open").arg(url).spawn();
    #[cfg(target_os = "windows")]
    let _ = std::process::Command::new("rundll32.exe")
        .args(["url.dll,FileProtocolHandler", url])
        .spawn();
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn reject_foreign_origins_and_missing_tokens() {
        assert!(authorized(
            Some("127.0.0.1:1"),
            Some("http://127.0.0.1:1"),
            Some("Bearer secret"),
            "127.0.0.1:1",
            "secret"
        ));
        assert!(!authorized(
            Some("127.0.0.1:1"),
            Some("https://evil.example"),
            Some("Bearer secret"),
            "127.0.0.1:1",
            "secret"
        ));
        assert!(!authorized(
            Some("evil.example:1"),
            None,
            Some("Bearer secret"),
            "127.0.0.1:1",
            "secret"
        ));
        assert!(!authorized(
            Some("127.0.0.1:1"),
            None,
            None,
            "127.0.0.1:1",
            "secret"
        ));
    }
}
