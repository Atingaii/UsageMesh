use std::thread;
use std::time::Duration;

use anyhow::{bail, Context, Result};
use reqwest::blocking::{Client, RequestBuilder, Response};
use reqwest::header::{ACCEPT, AUTHORIZATION, USER_AGENT};
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::crypto::device_hash;
use crate::model::{DashboardAccessEnvelope, EncryptedLedger};

const API: &str = "https://api.github.com";
const API_VERSION: &str = "2022-11-28";
pub const UPSTREAM_REPO: &str = "Atingaii/UsageMesh";
pub const DASHBOARD_BRANCH: &str = "um-dashboard";
pub const DEVICE_INDEX_BRANCH: &str = "um-index";
const LEDGER_BRANCH_PREFIX: &str = "um-ledger-";

pub struct GithubClient {
    http: Client,
    repo: String,
    token: String,
}

#[derive(Deserialize)]
struct ShaResponse {
    sha: String,
}
#[derive(Deserialize)]
struct GitObject {
    sha: String,
}
#[derive(Deserialize)]
struct RefResponse {
    object: GitObject,
}
#[derive(Deserialize)]
struct MatchingRefResponse {
    #[serde(rename = "ref")]
    reference: String,
}
#[derive(Deserialize)]
struct UserResponse {
    login: String,
}
#[derive(Deserialize)]
struct ParentResponse {
    full_name: String,
}
#[derive(Deserialize)]
struct RepositoryResponse {
    private: bool,
    full_name: String,
    #[serde(default)]
    fork: bool,
    parent: Option<ParentResponse>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DashboardDeviceIndex {
    schema_version: u32,
    kind: String,
    branches: Vec<String>,
    updated_at: String,
}

fn http_client() -> Result<Client> {
    Ok(Client::builder().timeout(Duration::from_secs(30)).build()?)
}

fn request(http: &Client, token: &str, method: reqwest::Method, url: String) -> RequestBuilder {
    http.request(method, url)
        .header(USER_AGENT, "usagemesh/2.0")
        .header(ACCEPT, "application/vnd.github+json")
        .header("X-GitHub-Api-Version", API_VERSION)
        .header(AUTHORIZATION, format!("Bearer {token}"))
}

fn checked(response: Response, action: &str) -> Result<Response> {
    if response.status().is_success() {
        return Ok(response);
    }
    let status = response.status();
    let body = response.text().unwrap_or_default();
    bail!(
        "GitHub {action} failed ({status}): {}",
        body.chars().take(500).collect::<String>()
    )
}

fn repo_is_upstream_fork(repository: &RepositoryResponse) -> bool {
    repository.full_name.eq_ignore_ascii_case(UPSTREAM_REPO)
        || (repository.fork
            && repository
                .parent
                .as_ref()
                .is_some_and(|parent| parent.full_name.eq_ignore_ascii_case(UPSTREAM_REPO)))
}

fn normalize_ledger_branches(refs: Vec<MatchingRefResponse>) -> Vec<String> {
    let mut branches = refs
        .into_iter()
        .filter_map(|item| {
            item.reference
                .strip_prefix("refs/heads/")
                .map(str::to_string)
        })
        .filter(|branch| branch.starts_with(LEDGER_BRANCH_PREFIX))
        .collect::<Vec<_>>();
    branches.sort();
    branches.dedup();
    branches
}

pub fn ensure_user_fork(token: &str) -> Result<String> {
    let http = http_client()?;
    let user: UserResponse = checked(
        request(&http, token, reqwest::Method::GET, format!("{API}/user")).send()?,
        "account discovery",
    )?
    .json()?;
    let expected = format!("{}/usagemesh", user.login);
    let repo_url = format!("{API}/repos/{expected}");
    let existing = request(&http, token, reqwest::Method::GET, repo_url.clone()).send()?;
    if existing.status().is_success() {
        let repository: RepositoryResponse = existing.json()?;
        if !repo_is_upstream_fork(&repository) {
            bail!("{expected} already exists but is not a fork of {UPSTREAM_REPO}; rerun setup with --repo OWNER/RENAMED_FORK")
        }
        if repository.private {
            bail!("{expected} is private. The zero-server dashboard needs the encrypted ledger branches to be publicly readable")
        }
        return Ok(repository.full_name);
    }
    if existing.status() != reqwest::StatusCode::NOT_FOUND {
        checked(existing, "fork discovery")?;
    }

    let create = request(
        &http,
        token,
        reqwest::Method::POST,
        format!("{API}/repos/{UPSTREAM_REPO}/forks"),
    )
    .json(&json!({ "default_branch_only": true }))
    .send()?;
    if !create.status().is_success() && create.status() != reqwest::StatusCode::ACCEPTED {
        checked(create, "automatic fork creation")?;
    }

    for _ in 0..20 {
        let response = request(&http, token, reqwest::Method::GET, repo_url.clone()).send()?;
        if response.status().is_success() {
            let repository: RepositoryResponse = response.json()?;
            if repo_is_upstream_fork(&repository) && !repository.private {
                return Ok(repository.full_name);
            }
        }
        thread::sleep(Duration::from_millis(750));
    }
    bail!("GitHub accepted the fork request but the fork is not ready yet; rerun `usagemesh setup` once GitHub finishes creating it")
}

impl GithubClient {
    pub fn new(repo: String, token: String) -> Result<Self> {
        Ok(Self {
            http: http_client()?,
            repo,
            token,
        })
    }

    fn request(&self, method: reqwest::Method, url: String) -> RequestBuilder {
        request(&self.http, &self.token, method, url)
    }

    pub fn validate(&self) -> Result<()> {
        let response = checked(
            self.request(reqwest::Method::GET, format!("{API}/repos/{}", self.repo))
                .send()?,
            "repository access",
        )?;
        let repository: RepositoryResponse = response.json()?;
        if repository.private {
            bail!("the fork must be public for the zero-server dashboard. Device snapshots are AES-GCM encrypted before upload")
        }
        if !repo_is_upstream_fork(&repository) {
            bail!(
                "{} is not a fork of {}; use the project fork itself as the ledger repository",
                repository.full_name,
                UPSTREAM_REPO
            )
        }
        Ok(())
    }

    pub fn snapshot_branch(device_id: &str) -> String {
        format!("{LEDGER_BRANCH_PREFIX}{}", device_hash(device_id))
    }

    fn replace_root_snapshot(
        &self,
        branch: &str,
        path: &str,
        serialized: String,
        message: String,
    ) -> Result<()> {
        let blob: ShaResponse = checked(
            self.request(
                reqwest::Method::POST,
                format!("{API}/repos/{}/git/blobs", self.repo),
            )
            .json(&json!({ "content": serialized, "encoding": "utf-8" }))
            .send()?,
            "blob creation",
        )?
        .json()?;
        let tree: ShaResponse = checked(
            self.request(
                reqwest::Method::POST,
                format!("{API}/repos/{}/git/trees", self.repo),
            )
            .json(&json!({
                "tree": [{ "path": path, "mode": "100644", "type": "blob", "sha": blob.sha }]
            }))
            .send()?,
            "tree creation",
        )?
        .json()?;
        let commit: ShaResponse = checked(
            self.request(
                reqwest::Method::POST,
                format!("{API}/repos/{}/git/commits", self.repo),
            )
            .json(&json!({ "message": message, "tree": tree.sha, "parents": [] }))
            .send()?,
            "snapshot commit creation",
        )?
        .json()?;

        let ref_url = format!("{API}/repos/{}/git/ref/heads/{branch}", self.repo);
        let ref_response = self.request(reqwest::Method::GET, ref_url).send()?;
        if ref_response.status() == reqwest::StatusCode::NOT_FOUND {
            checked(
                self.request(
                    reqwest::Method::POST,
                    format!("{API}/repos/{}/git/refs", self.repo),
                )
                .json(&json!({
                    "ref": format!("refs/heads/{branch}"),
                    "sha": commit.sha
                }))
                .send()?,
                "snapshot branch creation",
            )?;
        } else {
            let current: RefResponse = checked(ref_response, "snapshot branch read")?.json()?;
            if current.object.sha != commit.sha {
                checked(
                    self.request(
                        reqwest::Method::PATCH,
                        format!("{API}/repos/{}/git/refs/heads/{branch}", self.repo),
                    )
                    .json(&json!({ "sha": commit.sha, "force": true }))
                    .send()?,
                    "snapshot branch update",
                )?;
            }
        }
        Ok(())
    }

    pub fn ledger_branches(&self) -> Result<Vec<String>> {
        let refs: Vec<MatchingRefResponse> = checked(
            self.request(
                reqwest::Method::GET,
                format!(
                    "{API}/repos/{}/git/matching-refs/heads/{LEDGER_BRANCH_PREFIX}",
                    self.repo
                ),
            )
            .send()?,
            "ledger branch discovery",
        )?
        .json()?;
        Ok(normalize_ledger_branches(refs))
    }

    /// Publish the tiny plaintext index that lets static browsers discover
    /// encrypted device branches without spending the anonymous GitHub REST
    /// API rate limit. It contains branch names only; usage data remains inside
    /// the AES-GCM encrypted per-device ledgers.
    pub fn refresh_dashboard_index(&self) -> Result<String> {
        let index = DashboardDeviceIndex {
            schema_version: 1,
            kind: "usagemesh-device-index".to_string(),
            branches: self.ledger_branches()?,
            updated_at: chrono::Utc::now().to_rfc3339(),
        };
        self.replace_root_snapshot(
            DEVICE_INDEX_BRANCH,
            "index.json",
            serde_json::to_string(&index)?,
            "usagemesh device index".to_string(),
        )?;
        Ok(DEVICE_INDEX_BRANCH.to_string())
    }

    pub fn replace_snapshot(&self, device_id: &str, envelope: &EncryptedLedger) -> Result<String> {
        let branch = Self::snapshot_branch(device_id);
        self.replace_root_snapshot(
            &branch,
            "ledger.json",
            serde_json::to_string(envelope)?,
            format!("usagemesh snapshot {}", envelope.device_hash),
        )?;
        Ok(branch)
    }

    pub fn replace_dashboard_access(&self, envelope: &DashboardAccessEnvelope) -> Result<String> {
        self.replace_root_snapshot(
            DASHBOARD_BRANCH,
            "access.json",
            serde_json::to_string(envelope)?,
            "usagemesh dashboard access".to_string(),
        )?;
        Ok(DASHBOARD_BRANCH.to_string())
    }

    pub fn remove_snapshot_branch(&self, device_id: &str) -> Result<()> {
        let branch = Self::snapshot_branch(device_id);
        let response = self
            .request(
                reqwest::Method::DELETE,
                format!("{API}/repos/{}/git/refs/heads/{branch}", self.repo),
            )
            .send()
            .context("failed to contact GitHub")?;
        if response.status() == reqwest::StatusCode::NOT_FOUND {
            return Ok(());
        }
        checked(response, "snapshot branch deletion")?;
        self.refresh_dashboard_index()?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identifies_the_expected_upstream_fork() {
        let repository = RepositoryResponse {
            private: false,
            full_name: "alice/usagemesh".into(),
            fork: true,
            parent: Some(ParentResponse {
                full_name: UPSTREAM_REPO.into(),
            }),
        };
        assert!(repo_is_upstream_fork(&repository));
    }

    #[test]
    fn dashboard_branches_are_separate_from_device_ledgers() {
        assert_eq!(DASHBOARD_BRANCH, "um-dashboard");
        assert_eq!(DEVICE_INDEX_BRANCH, "um-index");
        assert_ne!(DASHBOARD_BRANCH, GithubClient::snapshot_branch("device"));
        assert_ne!(DEVICE_INDEX_BRANCH, GithubClient::snapshot_branch("device"));
    }

    #[test]
    fn matching_refs_are_normalized_and_sorted() {
        let branches = normalize_ledger_branches(vec![
            MatchingRefResponse {
                reference: "refs/heads/um-ledger-b".into(),
            },
            MatchingRefResponse {
                reference: "refs/heads/not-a-ledger".into(),
            },
            MatchingRefResponse {
                reference: "refs/heads/um-ledger-a".into(),
            },
        ]);
        assert_eq!(branches, vec!["um-ledger-a", "um-ledger-b"]);
    }
}
