use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs,
    io::Write,
    path::{Path, PathBuf},
};

pub fn digest(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}
pub fn private_write(path: &Path, data: &[u8]) -> Result<()> {
    let parent = path.parent().context("invalid storage path")?;
    fs::create_dir_all(parent)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(parent, fs::Permissions::from_mode(0o700))?;
    }
    let mut tmp = tempfile::NamedTempFile::new_in(parent)?;
    tmp.write_all(data)?;
    tmp.as_file().sync_all()?;
    tmp.persist(path).map_err(|e| e.error)?;
    Ok(())
}
pub fn load<T: for<'a> Deserialize<'a> + Default>(path: &Path) -> Result<T> {
    match fs::read(path) {
        Ok(b) => Ok(serde_json::from_slice(&b)
            .context("local state is invalid; preserve the file and restore a backup")?),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(T::default()),
        Err(e) => Err(e.into()),
    }
}
#[derive(Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Provider {
    pub id: String,
    pub name: String,
    pub tool: String,
    pub base_url: String,
    pub model: String,
    #[serde(default)]
    pub key_env: String,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Preferences {
    pub notifications: bool,
    pub monthly_budget: f64,
    pub quota_threshold: f64,
    pub cooldown_minutes: u32,
    pub scan_minutes: u32,
    pub spike_factor: f64,
}
impl Default for Preferences {
    fn default() -> Self {
        Self {
            notifications: false,
            monthly_budget: 0.,
            quota_threshold: 85.,
            cooldown_minutes: 60,
            scan_minutes: 5,
            spike_factor: 2.,
        }
    }
}
#[derive(Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ProjectMeta {
    pub alias: String,
    pub tags: Vec<String>,
    pub budget: f64,
}
#[derive(Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Connector {
    pub id: String,
    pub name: String,
    pub base_url: String,
    pub key_env: String,
    pub kind: String,
}
#[derive(Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub providers: Vec<Provider>,
    pub connectors: Vec<Connector>,
    pub preferences: Preferences,
    pub projects: BTreeMap<String, ProjectMeta>,
}
#[derive(Clone)]
pub struct Paths {
    pub home: PathBuf,
    pub data: PathBuf,
    pub codex: PathBuf,
    pub claude: PathBuf,
    pub isolated: bool,
}
impl Paths {
    pub fn new(home: Option<PathBuf>, data: Option<PathBuf>) -> Result<Self> {
        let isolated = home.is_some();
        let home = home.or_else(dirs::home_dir).context("cannot locate home")?;
        let codex = if isolated {
            home.join(".codex")
        } else {
            std::env::var_os("CODEX_HOME")
                .map(PathBuf::from)
                .unwrap_or_else(|| home.join(".codex"))
        };
        let claude = if isolated {
            home.join(".claude")
        } else {
            std::env::var_os("CLAUDE_CONFIG_DIR")
                .map(PathBuf::from)
                .unwrap_or_else(|| home.join(".claude"))
        };
        let data = data.unwrap_or(if isolated {
            home.join(".usagemesh-local")
        } else {
            crate::config::config_dir()?.join("local")
        });
        Ok(Self {
            home,
            data,
            codex,
            claude,
            isolated,
        })
    }
    pub fn settings(&self) -> PathBuf {
        self.data.join("settings.json")
    }
    pub fn tool(&self, tool: &str) -> Result<PathBuf> {
        match tool {
            "codex" => Ok(self.codex.join("config.toml")),
            "claude" => Ok(self.claude.join("settings.json")),
            _ => bail!("仅支持 Codex 和 Claude Code"),
        }
    }
}
pub fn validate_id(id: &str) -> Result<()> {
    if id.is_empty()
        || id.len() > 64
        || !id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    {
        bail!("无效标识符")
    };
    Ok(())
}
pub fn validate_url(value: &str) -> Result<reqwest::Url> {
    let u = reqwest::Url::parse(value).context("接口地址无效")?;
    if !u.username().is_empty()
        || u.password().is_some()
        || u.query().is_some()
        || u.fragment().is_some()
    {
        bail!("接口地址不能包含凭据、查询参数或 fragment")
    }
    let local = matches!(
        u.host_str(),
        Some("127.0.0.1" | "localhost" | "[::1]" | "::1")
    );
    if u.scheme() != "https" && !(local && u.scheme() == "http") {
        bail!("仅允许 HTTPS 或本机 HTTP 接口")
    };
    Ok(u)
}
pub fn validate_env(name: &str) -> Result<()> {
    if !name.is_empty()
        && (name.len() > 100
            || !name
                .bytes()
                .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit() || b == b'_')
            || name.as_bytes()[0].is_ascii_digit())
    {
        bail!("凭据引用必须为大写环境变量名")
    };
    Ok(())
}
pub fn secret(name: &str) -> Result<Option<String>> {
    validate_env(name)?;
    if name.is_empty() {
        return Ok(None);
    };
    Ok(Some(
        std::env::var(name)
            .ok()
            .filter(|s| !s.trim().is_empty())
            .context("凭据环境变量未设置；设置后重启本地服务")?,
    ))
}
pub fn redact(value: &mut Value) {
    match value {
        Value::Object(map) => {
            for (k, v) in map {
                let key = k.to_ascii_lowercase();
                if ["key", "token", "secret", "password", "authorization"]
                    .iter()
                    .any(|s| key.contains(s))
                    && !key.ends_with("env_key")
                {
                    *v = Value::String("••••••".into());
                } else {
                    redact(v)
                }
            }
        }
        Value::Array(a) => a.iter_mut().for_each(redact),
        _ => {}
    }
}
