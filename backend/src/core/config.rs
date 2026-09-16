use super::{Result, ensure};
use std::{env, path::PathBuf};
#[derive(Clone)]
pub struct Config {
    pub root: PathBuf,
    pub environment: String,
    pub development: bool,
    pub standalone: bool,
    pub origin: String,
    pub port: u16,
    pub release: String,
    pub version: Option<String>,
    pub fixture: bool,
    pub fixture_url: Option<String>,
    pub browser_capacity: usize,
    pub bundle: PathBuf,
    pub dashboard: PathBuf,
    pub node: PathBuf,
    pub browser: PathBuf,
    pub browseros: PathBuf,
    pub sandbox: PathBuf,
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
        let development = variable("NODE_ENV", "development") != "production";
        let mut c = Self {
            root: PathBuf::from(variable(
                "DISPATCH_STATE_ROOT",
                "/tmp/dispatch-rust-development",
            )),
            environment: variable("DISPATCH_ENVIRONMENT", "preview"),
            development,
            standalone: variable("DISPATCH_STANDALONE", "1") == "1",
            origin: variable("DISPATCH_ORIGIN", "http://127.0.0.1:5173"),
            port: variable("PORT", "5180")
                .parse()
                .map_err(|_| super::Error::new("invalid_port", 400))?,
            release: variable("DISPATCH_RELEASE", "development"),
            version: None,
            fixture: variable("DISPATCH_PROVIDER_MODE", "fixture") == "fixture",
            fixture_url: env::var("DISPATCH_FIXTURE_PROVIDER_URL").ok(),
            browser_capacity: 2,
            bundle: env::var_os("DISPATCH_RUNTIME_BUNDLE")
                .map(PathBuf::from)
                .unwrap_or(bundle.join("services/runtime")),
            dashboard: bundle.join("dashboard"),
            node: PathBuf::from(variable("DISPATCH_WORKER_NODE", "/usr/bin/node")),
            browser: PathBuf::from(variable(
                "DISPATCH_BROWSER_EXECUTABLE",
                "/opt/google/chrome/chrome",
            )),
            browseros: PathBuf::from(variable(
                "DISPATCH_BROWSEROS_EXECUTABLE",
                "/opt/dispatch-browseros/0.50.5/browseros",
            )),
            sandbox: PathBuf::from(variable("DISPATCH_BWRAP_EXECUTABLE", "/usr/bin/bwrap")),
            smtp_url: env::var("DISPATCH_SMTP_URL").ok(),
            mail_from: env::var("DISPATCH_MAIL_FROM").ok(),
        };
        if bundle.join("release.json").exists() {
            let manifest: serde_json::Value =
                serde_json::from_slice(&std::fs::read(bundle.join("release.json"))?)?;
            c.release = manifest["digest"].as_str().unwrap_or("unknown").into();
            c.version = manifest["version"].as_str().map(str::to_owned);
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
        ensure(c.standalone, "independent_environment_required", 400)?;
        Ok(c)
    }
    pub fn platform(&self) -> PathBuf {
        self.root.join("data/platform")
    }
    pub fn environment_root(&self) -> PathBuf {
        self.root.join("data").join(&self.environment)
    }
    pub fn mail_available(&self) -> bool {
        self.development
            || self.environment == "preview"
            || (self.smtp_url.is_some() && self.mail_from.is_some())
    }
}
