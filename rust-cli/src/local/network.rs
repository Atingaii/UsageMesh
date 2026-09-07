use super::store::*;
use anyhow::{Context, Result};
use serde_json::{json, Value};
use std::{
    io::Read,
    time::{Duration, Instant},
};
pub fn client() -> Result<reqwest::blocking::Client> {
    Ok(reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(20))
        .redirect(reqwest::redirect::Policy::none())
        .build()?)
}
pub fn probe(p: &Provider, generate: bool) -> Result<Value> {
    validate_url(&p.base_url)?;
    let key = secret(&p.key_env)?;
    let raw = p.base_url.trim_end_matches('/');
    let base = if p.tool == "claude" && !raw.ends_with("/v1") {
        format!("{raw}/v1")
    } else {
        raw.to_string()
    };
    let url = if generate {
        format!(
            "{base}/{}",
            if p.tool == "claude" {
                "messages"
            } else {
                "responses"
            }
        )
    } else {
        format!("{base}/models")
    };
    let http = client()?;
    let mut req = if generate {
        http.post(&url).json(&if p.tool=="claude"{json!({"model":p.model,"max_tokens":8,"messages":[{"role":"user","content":"Reply OK"}]})}else{json!({"model":p.model,"input":"Reply OK","max_output_tokens":16})})
    } else {
        http.get(&url)
    };
    if p.tool == "claude" {
        req = req.header("anthropic-version", "2023-06-01");
    }
    if let Some(key) = key {
        req = if p.tool == "claude" {
            req.header("x-api-key", key)
                .header("anthropic-version", "2023-06-01")
        } else {
            req.bearer_auth(key)
        }
    }
    let start = Instant::now();
    let response = req.send();
    let elapsed = start.elapsed().as_millis();
    let (status, models) = match response {
        Ok(mut r) => {
            let status = r.status().as_u16();
            let mut b = Vec::new();
            r.by_ref().take(2_000_000).read_to_end(&mut b)?;
            let json: Value = serde_json::from_slice(&b).unwrap_or(Value::Null);
            let models: Vec<_> = json["data"]
                .as_array()
                .map(|a| {
                    a.iter()
                        .filter_map(|m| m["id"].as_str())
                        .take(500)
                        .collect()
                })
                .unwrap_or_default();
            (
                status,
                models.into_iter().map(String::from).collect::<Vec<_>>(),
            )
        }
        Err(_) => (0, Vec::new()),
    };
    Ok(
        json!({"id":hex::encode(rand::random::<[u8;16]>()),"channel":p.name,"providerId":p.id,"status":status,"latencyMs":elapsed,"at":chrono::Utc::now().to_rfc3339(),"kind":if generate{"generation-probe"}else{"models-probe"},"models":models,"message":match status{200..=299=>"连接成功",401|403=>"认证失败或权限不足",404=>"接口路径或模型不可用",429=>"限流或额度不足",0=>"连接失败或超时；检查地址、网络和证书",_=>"接口返回错误，请检查供应商状态"}}),
    )
}
pub fn inspect(c: &Connector) -> Result<Value> {
    validate_url(&c.base_url)?;
    let key = secret(&c.key_env)?;
    let path = match c.kind.as_str() {
        "cliproxy" => "/v0/management/auth-files",
        "openai" | "litellm" => "/models",
        _ => anyhow::bail!("未知代理类型"),
    };
    let mut req = client()?.get(format!("{}{path}", c.base_url.trim_end_matches('/')));
    if let Some(k) = key {
        req = req.bearer_auth(k)
    };
    let mut response = req.send().context("代理连接失败；检查地址与本地服务")?;
    let status = response.status().as_u16();
    if !(200..300).contains(&status) {
        anyhow::bail!("代理返回 HTTP {status}，请核对路径、管理密钥与权限")
    }
    let mut bytes = Vec::new();
    response.by_ref().take(2_000_000).read_to_end(&mut bytes)?;
    let v: Value = serde_json::from_slice(&bytes).context("代理未返回 JSON")?;
    let items = if c.kind == "cliproxy" {
        v["files"].as_array().context("代理响应中缺少 files")?.iter().take(500).map(|r|json!({"name":r["name"],"provider":r["provider"],"status":r["status"],"disabled":r["disabled"]})).collect::<Vec<_>>()
    } else {
        v["data"]
            .as_array()
            .context("模型响应中缺少 data")?
            .iter()
            .take(500)
            .map(|r| json!({"name":r["id"],"provider":r["owned_by"]}))
            .collect()
    };
    Ok(
        json!({"id":c.id,"at":chrono::Utc::now().to_rfc3339(),"items":items,"note":"只读连接：不切换账号、不下载认证文件、不修改代理配置。"}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn catalog_probe_never_generates_and_connector_discards_secrets() {
        let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let base = format!("http://{}", server.server_addr());
        let thread = std::thread::spawn(move || {
            for expected in ["/v1/models", "/v0/management/auth-files"] {
                let r = server
                    .recv_timeout(Duration::from_secs(5))
                    .unwrap()
                    .unwrap();
                assert_eq!(r.method(), &tiny_http::Method::Get);
                assert_eq!(r.url(), expected);
                let data = if expected.ends_with("models") {
                    json!({"data":[{"id":"fixture-model"}]})
                } else {
                    json!({"files":[{"name":"fixture","provider":"codex","status":"ready","token":"secret-token","content":"private"}]})
                };
                r.respond(tiny_http::Response::from_string(data.to_string()))
                    .unwrap();
            }
        });
        let p = Provider {
            id: "fixture".into(),
            name: "fixture".into(),
            tool: "codex".into(),
            base_url: format!("{base}/v1"),
            model: "fixture-model".into(),
            key_env: String::new(),
        };
        let v = probe(&p, false).unwrap();
        assert_eq!(v["status"], 200);
        assert_eq!(v["kind"], "models-probe");
        assert_eq!(v["models"][0], "fixture-model");
        let c = Connector {
            id: "fixture".into(),
            name: "fixture".into(),
            base_url: base,
            key_env: String::new(),
            kind: "cliproxy".into(),
        };
        let v = inspect(&c).unwrap();
        assert_eq!(v["items"][0]["name"], "fixture");
        assert!(!v.to_string().contains("secret-token"));
        assert!(!v.to_string().contains("private"));
        thread.join().unwrap();
    }
}
