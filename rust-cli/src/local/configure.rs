use super::store::*;
use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::fs;
use toml_edit::{value, DocumentMut, Item, Table};

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Backup {
    pub id: String,
    pub tool: String,
    pub before: Option<String>,
    pub after_hash: String,
    pub at: String,
}
pub struct Plan {
    pub path: std::path::PathBuf,
    pub before: Option<Vec<u8>>,
    pub after: Vec<u8>,
    pub tool: String,
}
fn read(path: &std::path::Path) -> Result<Option<Vec<u8>>> {
    if fs::symlink_metadata(path).is_ok_and(|m| m.file_type().is_symlink()) {
        bail!("配置是符号链接，请直接在原管理工具修改，避免覆盖链接")
    }
    match fs::read(path) {
        Ok(v) => {
            if v.len() > 2_000_000 {
                bail!("配置文件过大")
            };
            Ok(Some(v))
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.into()),
    }
}
pub fn plan(paths: &Paths, p: &Provider) -> Result<Plan> {
    validate_id(&p.id)?;
    validate_env(&p.key_env)?;
    validate_url(&p.base_url)?;
    if p.name.trim().is_empty()
        || p.name.len() > 100
        || p.model.trim().is_empty()
        || p.model.len() > 150
    {
        bail!("请填写名称和模型（长度超限或为空）")
    }
    let path = paths.tool(&p.tool)?;
    let before = read(&path)?;
    let text = String::from_utf8(before.clone().unwrap_or_default())?;
    let after = if p.tool == "codex" {
        let mut doc = if text.is_empty() {
            DocumentMut::new()
        } else {
            text.parse::<DocumentMut>()
                .context("Codex TOML 无效，未修改")?
        };
        let id = format!("usagemesh_{}", p.id);
        doc["model"] = value(&p.model);
        doc["model_provider"] = value(&id);
        if doc.get("model_providers").is_none() {
            doc["model_providers"] = Item::Table(Table::new());
        }
        let table = doc["model_providers"]
            .as_table_like_mut()
            .context("model_providers 必须为 TOML 表")?;
        let mut provider = Table::new();
        provider["name"] = value(&p.name);
        provider["base_url"] = value(p.base_url.trim_end_matches('/'));
        provider["wire_api"] = value("responses");
        if !p.key_env.is_empty() {
            provider["env_key"] = value(&p.key_env);
        }
        table.insert(&id, Item::Table(provider));
        doc.to_string().into_bytes()
    } else {
        let mut doc: Value = if text.is_empty() {
            json!({})
        } else {
            serde_json::from_str(&text).context("Claude JSON 无效，未修改")?
        };
        let obj = doc.as_object_mut().context("Claude 设置必须为对象")?;
        let env = obj
            .entry("env")
            .or_insert_with(|| json!({}))
            .as_object_mut()
            .context("env 必须为对象")?;
        env.insert(
            "ANTHROPIC_BASE_URL".into(),
            json!(p.base_url.trim_end_matches('/').trim_end_matches("/v1")),
        );
        env.insert("ANTHROPIC_MODEL".into(), json!(p.model));
        if let Some(key) = secret(&p.key_env)? {
            env.remove("ANTHROPIC_API_KEY");
            env.insert("ANTHROPIC_AUTH_TOKEN".into(), json!(key));
        }
        serde_json::to_vec_pretty(&doc)?
    };
    Ok(Plan {
        path,
        before,
        after,
        tool: p.tool.clone(),
    })
}
fn display(tool: &str, bytes: &[u8]) -> Result<Value> {
    let mut v: Value = if bytes.is_empty() {
        json!({})
    } else if tool == "codex" {
        serde_json::to_value(std::str::from_utf8(bytes)?.parse::<toml::Value>()?)?
    } else {
        serde_json::from_slice(bytes)?
    };
    redact(&mut v);
    Ok(v)
}
pub fn preview(plan: &Plan) -> Result<Value> {
    Ok(
        json!({"tool":plan.tool,"path":plan.path,"beforeHash":digest(plan.before.as_deref().unwrap_or_default()),"afterHash":digest(&plan.after),"before":display(&plan.tool,plan.before.as_deref().unwrap_or_default())?,"after":display(&plan.tool,&plan.after)?,"note":"仅修改供应商相关字段。外部环境变量、项目配置与 CC Switch 可能覆盖该配置；重启对应 CLI 后生效。"}),
    )
}
pub fn apply(paths: &Paths, plan: Plan, expected: &str, after_expected: &str) -> Result<Value> {
    if digest(plan.before.as_deref().unwrap_or_default()) != expected
        || digest(&plan.after) != after_expected
    {
        bail!("配置或凭据已变化，请重新预览")
    }
    // Re-read immediately before replacing. External managers should not write concurrently.
    if read(&plan.path)? != plan.before {
        bail!("配置被其他工具修改，请重新预览")
    }
    let id = hex::encode(rand::random::<[u8; 16]>());
    let backup = Backup {
        id: id.clone(),
        tool: plan.tool,
        before: plan
            .before
            .map(|b| base64::Engine::encode(&base64::engine::general_purpose::STANDARD, b)),
        after_hash: digest(&plan.after),
        at: chrono::Utc::now().to_rfc3339(),
    };
    private_write(
        &paths.data.join("backups").join(format!("{id}.json")),
        &serde_json::to_vec(&backup)?,
    )?;
    private_write(&plan.path, &plan.after)?;
    Ok(json!({"backupId":id,"message":"已应用并备份，请重启对应 CLI。"}))
}
pub fn backups(paths: &Paths) -> Result<Vec<Value>> {
    let mut out = Vec::new();
    if let Ok(entries) = fs::read_dir(paths.data.join("backups")) {
        for e in entries.flatten() {
            if let Ok(Some(b)) = load::<Option<Backup>>(&e.path()) {
                out.push(json!({"id":b.id,"tool":b.tool,"at":b.at}));
            }
        }
    }
    out.sort_by(|a, b| b["at"].as_str().cmp(&a["at"].as_str()));
    Ok(out)
}
pub fn rollback(paths: &Paths, id: &str) -> Result<Value> {
    validate_id(id)?;
    let backup: Option<Backup> = load(&paths.data.join("backups").join(format!("{id}.json")))?;
    let b = backup.context("备份不存在")?;
    let path = paths.tool(&b.tool)?;
    let current = read(&path)?.unwrap_or_default();
    if digest(&current) != b.after_hash {
        bail!("当前配置已有其他修改，拒绝覆盖。请先核对差异。")
    };
    if let Some(before) = b.before {
        use base64::Engine;
        private_write(
            &path,
            &base64::engine::general_purpose::STANDARD.decode(before)?,
        )?
    } else {
        fs::remove_file(path)?
    };
    Ok(json!({"message":"已恢复原配置，请重启对应 CLI。"}))
}
pub fn inventory(paths: &Paths) -> Vec<Value> {
    ["codex", "claude"]
        .iter()
        .map(|tool| {
            let path = paths.tool(tool).unwrap();
            match read(&path).and_then(|b| {
                display(tool, b.as_deref().unwrap_or_default()).map(|v| (b.is_some(), v))
            }) {
                Ok((exists, v)) => json!({"tool":tool,"path":path,"exists":exists,"config":v}),
                Err(_) => {
                    json!({"tool":tool,"path":path,"error":"配置不可解析或为符号链接，未改动"})
                }
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> (tempfile::TempDir, Paths, Provider) {
        let d = tempfile::tempdir().unwrap();
        let paths = Paths::new(Some(d.path().into()), None).unwrap();
        let p = Provider {
            id: "test".into(),
            name: "Test".into(),
            tool: "codex".into(),
            base_url: "http://127.0.0.1:9999/v1".into(),
            model: "fixture-model".into(),
            key_env: "TEST_KEY".into(),
        };
        (d, paths, p)
    }
    #[test]
    fn preview_apply_and_rollback_preserve_unrelated_config() {
        let (_d, paths, p) = fixture();
        let file = paths.tool("codex").unwrap();
        let original=b"# keep this comment\nmodel = 'original'\n[features]\nmulti_agent = true\n[mcp_servers.example]\ncommand = 'example'\n";
        private_write(&file, original).unwrap();
        let plan = plan(&paths, &p).unwrap();
        let view = preview(&plan).unwrap();
        assert_eq!(view["after"]["features"]["multi_agent"], true);
        let applied = apply(
            &paths,
            plan,
            view["beforeHash"].as_str().unwrap(),
            view["afterHash"].as_str().unwrap(),
        )
        .unwrap();
        assert!(fs::read_to_string(&file)
            .unwrap()
            .contains("# keep this comment"));
        rollback(&paths, applied["backupId"].as_str().unwrap()).unwrap();
        assert_eq!(fs::read(&file).unwrap(), original);
    }
    #[test]
    fn concurrent_changes_require_new_preview() {
        let (_d, paths, p) = fixture();
        let file = paths.tool("codex").unwrap();
        let old = plan(&paths, &p).unwrap();
        let view = preview(&old).unwrap();
        private_write(&file, b"model='external'\n").unwrap();
        assert!(apply(
            &paths,
            old,
            view["beforeHash"].as_str().unwrap(),
            view["afterHash"].as_str().unwrap()
        )
        .is_err());
        assert_eq!(fs::read_to_string(file).unwrap(), "model='external'\n");
    }
    #[test]
    fn rollback_refuses_external_modification() {
        let (_d, paths, p) = fixture();
        let plan = plan(&paths, &p).unwrap();
        let view = preview(&plan).unwrap();
        let a = apply(
            &paths,
            plan,
            view["beforeHash"].as_str().unwrap(),
            view["afterHash"].as_str().unwrap(),
        )
        .unwrap();
        private_write(&paths.tool("codex").unwrap(), b"model='external'\n").unwrap();
        assert!(rollback(&paths, a["backupId"].as_str().unwrap()).is_err());
    }
    #[test]
    fn claude_preserves_hooks_and_redacts_credentials() {
        let (_d, paths, mut p) = fixture();
        p.tool = "claude".into();
        p.key_env = String::new();
        private_write(&paths.tool("claude").unwrap(),br#"{"env":{"ANTHROPIC_AUTH_TOKEN":"fixture-secret","CUSTOM_SETTING":"keep"},"hooks":{"Stop":[]}}"#).unwrap();
        let plan = plan(&paths, &p).unwrap();
        let v = preview(&plan).unwrap();
        assert!(!v.to_string().contains("fixture-secret"));
        assert_eq!(v["after"]["env"]["CUSTOM_SETTING"], "keep");
        assert_eq!(v["after"]["hooks"], json!({"Stop":[]}));
        assert!(String::from_utf8(plan.after)
            .unwrap()
            .contains("fixture-secret"));
    }
    #[test]
    fn malformed_config_is_never_replaced() {
        let (_d, paths, p) = fixture();
        let file = paths.tool("codex").unwrap();
        private_write(&file, b"[[broken").unwrap();
        assert!(plan(&paths, &p).is_err());
        assert_eq!(fs::read(file).unwrap(), b"[[broken");
    }
    #[cfg(unix)]
    #[test]
    fn symlink_config_is_never_replaced() {
        let (d, paths, p) = fixture();
        fs::create_dir_all(&paths.codex).unwrap();
        let actual = d.path().join("original");
        fs::write(&actual, b"model='keep'").unwrap();
        std::os::unix::fs::symlink(&actual, paths.tool("codex").unwrap()).unwrap();
        assert!(plan(&paths, &p).is_err());
        assert_eq!(fs::read(actual).unwrap(), b"model='keep'");
    }
}
