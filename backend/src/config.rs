use super::{Result, ensure};
use std::{env, path::PathBuf};
mod security;
pub use security::SecurityPolicy;
#[derive(Clone)]
pub struct Config {
    pub security: SecurityPolicy,
    pub root: PathBuf,
    pub environment: String,
    pub development: bool,
    pub trusted_proxy: super::proxy::TrustedProxy,
    pub standalone: bool,
    pub origin: String,
    pub port: u16,
    pub release: String,
    /// The source this runtime was built from: its commit, and its version when it is a published
    /// release. A server running from a checkout rather than a build knows neither.
    pub source: crate::contracts::RuntimeSource,
    pub fixture: bool,
    pub fixture_url: Option<String>,
    pub browser_capacity: usize,
    pub dashboard: PathBuf,
    pub browseros: PathBuf,
    pub sandbox: PathBuf,
    pub mail_mode: String,
    pub mail_worker_url: Option<String>,
    pub mail_worker_token: Option<String>,
    pub smtp_url: Option<String>,
    pub mail_from: Option<String>,
}
fn variable(name: &str, fallback: &str) -> String {
    env::var(name).unwrap_or_else(|_| fallback.into())
}
impl Config {
    pub fn load() -> Result<Self> {
        let bundle = env::var_os("DISPATCH_ARTIFACT_ROOT")
            .map(PathBuf::from)
            .unwrap_or(env::current_dir()?);
        let environment = variable("DISPATCH_ENVIRONMENT", "preview");
        let mode = variable(
            "NODE_ENV",
            if environment == "production" {
                "production"
            } else {
                "development"
            },
        );
        ensure(
            ["development", "test", "production"].contains(&mode.as_str()),
            "invalid_runtime_mode",
            400,
        )?;
        let development = mode != "production";
        ensure(
            environment != "production" || !development,
            "production_configuration_required",
            400,
        )?;
        if environment == "production" {
            ensure(
                ["DISPATCH_STATE_ROOT", "DISPATCH_ORIGIN"]
                    .iter()
                    .all(|key| env::var(key).is_ok_and(|v| !v.trim().is_empty())),
                "production_configuration_required",
                400,
            )?;
        }
        let provider = variable("DISPATCH_PROVIDER_MODE", "fixture");
        ensure(
            ["native", "fixture"].contains(&provider.as_str()),
            "invalid_provider_mode",
            400,
        )?;
        let mail_prefix = if environment == "preview" {
            "DISPATCH_DEV"
        } else {
            "DISPATCH_PRODUCTION"
        };
        let mail_variable = |suffix: &str| {
            env::var(format!("{mail_prefix}_{suffix}"))
                .ok()
                .filter(|v| !v.trim().is_empty())
        };
        let source = source(&bundle, environment == "production");
        let mut c = Self {
            security: SecurityPolicy::parse(&variable("DISPATCH_SECURITY_POLICY", "{}"))?,
            root: PathBuf::from(variable(
                "DISPATCH_STATE_ROOT",
                "/tmp/dispatch-rust-development",
            )),
            environment,
            development,
            trusted_proxy: super::proxy::TrustedProxy::parse(&variable(
                "DISPATCH_TRUSTED_PROXY",
                "none",
            ))?,
            standalone: variable("DISPATCH_STANDALONE", "1") == "1",
            origin: variable("DISPATCH_ORIGIN", "http://127.0.0.1:5173"),
            port: variable("PORT", "5180")
                .parse()
                .map_err(|_| super::Error::new("invalid_port", 400))?,
            release: variable("DISPATCH_RELEASE", "development"),
            source,
            fixture: provider == "fixture",
            fixture_url: env::var("DISPATCH_FIXTURE_PROVIDER_URL").ok(),
            browser_capacity: 2,
            dashboard: bundle.join("dashboard"),
            browseros: PathBuf::from(variable(
                "DISPATCH_BROWSEROS_EXECUTABLE",
                "/opt/dispatch-browseros/0.50.5/browseros",
            )),
            sandbox: PathBuf::from(variable("DISPATCH_BWRAP_EXECUTABLE", "/usr/bin/bwrap")),
            mail_mode: mail_variable("MAIL_MODE")
                .unwrap_or_else(|| if development { "capture" } else { "disabled" }.into()),
            mail_worker_url: mail_variable("MAIL_WORKER_URL"),
            mail_worker_token: mail_variable("MAIL_WORKER_TOKEN"),
            smtp_url: mail_variable("SMTP_URL"),
            mail_from: mail_variable("MAIL_FROM"),
        };
        if bundle.join("release.json").exists() {
            let manifest: serde_json::Value =
                serde_json::from_slice(&std::fs::read(bundle.join("release.json"))?)?;
            c.release = manifest["digest"].as_str().unwrap_or("unknown").into();
        }
        ensure(
            c.root.is_absolute() && c.root.parent().is_some(),
            "absolute_state_root_required",
            400,
        )?;
        ensure(
            ["preview", "production"].contains(&c.environment.as_str()),
            "invalid_environment",
            400,
        )?;
        let origin = url::Url::parse(&c.origin)
            .map_err(|_| super::Error::new("canonical_origin_required", 400))?;
        ensure(
            origin.origin().ascii_serialization() == c.origin
                && origin.username().is_empty()
                && origin.password().is_none(),
            "canonical_origin_required",
            400,
        )?;
        ensure(
            development
                || (origin.scheme() == "https"
                    && (!c.fixture || (c.standalone && c.environment == "preview"))),
            "production_configuration_required",
            400,
        )?;
        if let Some(url) = &c.fixture_url {
            let url =
                url::Url::parse(url).map_err(|_| super::Error::new("fixture_forbidden", 403))?;
            ensure(
                c.development
                    && c.fixture
                    && url.scheme() == "http"
                    && url.host_str() == Some("fixture.dispatch.invalid")
                    && url.port().is_some()
                    && url.username().is_empty()
                    && url.password().is_none()
                    && url.path() == "/"
                    && url.query().is_none()
                    && url.fragment().is_none(),
                "fixture_forbidden",
                403,
            )?;
        }
        ensure(
            ["capture", "cloudflare", "smtp", "disabled"].contains(&c.mail_mode.as_str()),
            "invalid_mail_mode",
            400,
        )?;
        ensure(
            c.mail_mode != "capture" || development,
            "mail_capture_requires_development",
            400,
        )?;
        if c.mail_mode == "cloudflare" {
            let endpoint = c
                .mail_worker_url
                .as_deref()
                .and_then(|u| url::Url::parse(u).ok())
                .ok_or_else(|| super::Error::new("mail_configuration_required", 400))?;
            ensure(
                (endpoint.scheme() == "https"
                    || (development
                        && endpoint.scheme() == "http"
                        && endpoint.host_str() == Some("127.0.0.1")))
                    && endpoint.username().is_empty()
                    && endpoint.password().is_none()
                    && endpoint.query().is_none()
                    && endpoint.fragment().is_none()
                    && c.mail_worker_token.as_ref().is_some_and(|t| t.len() >= 32),
                "mail_configuration_required",
                400,
            )?;
        }
        if c.mail_mode == "smtp" {
            ensure(
                c.smtp_url.is_some() && c.mail_from.is_some(),
                "mail_configuration_required",
                400,
            )?;
        }
        ensure(c.standalone, "independent_environment_required", 400)?;
        Ok(c)
    }
    pub fn platform(&self) -> PathBuf {
        self.root.join("data/platform")
    }
    pub fn environment_root(&self) -> PathBuf {
        self.root.join("data").join(&self.environment)
    }
    /// The validated environment. The field stays text because it also names a directory.
    pub fn env(&self) -> crate::contracts::Environment {
        use crate::contracts::Environment;
        Environment::parse(&self.environment).unwrap_or(Environment::Preview)
    }
    pub fn mail_available(&self) -> bool {
        self.mail_mode != "disabled"
    }
}
/// The commit a build was made from, and on Production its version: Production installs only
/// published releases, whose manifest names it. Any other build still carries package.json's
/// version, which no release has used.
fn source(bundle: &std::path::Path, production: bool) -> crate::contracts::RuntimeSource {
    let field = |file: &str, key: &str| {
        let value: serde_json::Value =
            serde_json::from_slice(&std::fs::read(bundle.join(file)).ok()?).ok()?;
        value[key].as_str().map(String::from)
    };
    crate::contracts::RuntimeSource {
        version: production
            .then(|| field("release.json", "version"))
            .flatten(),
        commit: field("tooling/build-info.json", "commit"),
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn only_production_names_the_release_its_source_came_from() {
        let bundle = tempfile::tempdir().unwrap();
        let unbuilt = super::source(bundle.path(), true);
        assert_eq!((unbuilt.version, unbuilt.commit), (None, None));
        std::fs::create_dir(bundle.path().join("tooling")).unwrap();
        std::fs::write(
            bundle.path().join("release.json"),
            r#"{"version":"0.0.23"}"#,
        )
        .unwrap();
        std::fs::write(
            bundle.path().join("tooling/build-info.json"),
            r#"{"commit":"c3f898be7c709f65c9d6e69a391fffbe03ecb5b6"}"#,
        )
        .unwrap();
        let commit = Some("c3f898be7c709f65c9d6e69a391fffbe03ecb5b6".to_owned());
        let dev = super::source(bundle.path(), false);
        assert_eq!((dev.version, dev.commit), (None, commit.clone()));
        let production = super::source(bundle.path(), true);
        assert_eq!(
            (production.version, production.commit),
            (Some("0.0.23".into()), commit)
        );
    }
}
