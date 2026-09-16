//! Cortex is Amazon Logistics Delivery Execution. Only authentication is enabled.
use super::{attempt::Attempts, browseros, page::Page};
use crate::core::{Error, Result, db::s, ensure};
use serde_json::{Value, json};
use std::{path::Path, time::Duration};
use tokio::time::{Instant, sleep};
const ORIGIN: &str = "https://logistics.amazon.com";
const ORIGINS: &[&str] = &[ORIGIN, "https://www.amazon.com", "https://amazon.com"];
const LANDING: &str = "/operations/execution";
const AUTH: &str = include_str!("auth.js");
pub(super) fn preflight(profile: &Path, retry: bool) -> Result<()> {
    Attempts::open(
        &profile
            .parent()
            .ok_or_else(|| Error::new("unsafe_storage_path", 500))?
            .join("cortex-attempt.json"),
    )?
    .check(retry)?;
    Ok(())
}
pub struct Driver {
    pub browser: browseros::Session,
    page: Page,
    origin: String,
    origins: Vec<String>,
    attempts: Attempts,
    credentials: Value,
    username_submitted: bool,
    password_submitted: bool,
}
impl Driver {
    pub async fn new(
        browser: browseros::Session,
        profile: &Path,
        fixture: Option<&str>,
    ) -> Result<Self> {
        let origin = fixture.unwrap_or(ORIGIN).trim_end_matches('/').to_owned();
        let origins = if fixture.is_some() {
            vec![origin.clone()]
        } else {
            ORIGINS.iter().map(|v| (*v).to_owned()).collect()
        };
        Ok(Self {
            page: Page::empty(browser.clone(), origin.clone()),
            browser,
            origin,
            origins,
            attempts: Attempts::open(
                &profile
                    .parent()
                    .ok_or_else(|| Error::new("unsafe_storage_path", 500))?
                    .join("cortex-attempt.json"),
            )?,
            credentials: Value::Null,
            username_submitted: false,
            password_submitted: false,
        })
    }
    async fn open(&mut self) -> Result<()> {
        self.page = Page::open(self.browser.clone(), self.origin.clone()).await?;
        self.page
            .allow_origins(&self.origins.iter().map(String::as_str).collect::<Vec<_>>());
        let window = self
            .browser
            .command(
                "Browser.getWindowForTarget",
                json!({"targetId":self.page.target}),
                None,
            )
            .await?;
        self.browser.command("Browser.setWindowBounds",json!({"windowId":window["windowId"],"bounds":{"windowState":"normal","left":0,"top":0,"width":1024,"height":768}}),None).await?;
        self.page.command("Page.bringToFront", json!({})).await?;
        let targets = self
            .browser
            .command("Target.getTargets", json!({}), None)
            .await?;
        if let Some(targets) = targets["targetInfos"].as_array() {
            for target in targets {
                if s(target, "type") == "page" && s(target, "targetId") != self.page.target {
                    self.browser
                        .command(
                            "Target.closeTarget",
                            json!({"targetId":target["targetId"]}),
                            None,
                        )
                        .await?;
                }
            }
        }
        Ok(())
    }
    async fn script(&self, mut input: Value) -> Result<Value> {
        input["origins"] = json!(self.origins);
        input["applicationOrigin"] = json!(self.origin);
        self.page
            .evaluate(&format!("({})({input})", AUTH.trim().trim_end_matches(';')))
            .await
    }
    async fn observe(&self, previous: &str, seconds: u64) -> Result<Value> {
        let deadline = Instant::now() + Duration::from_secs(seconds);
        while Instant::now() < deadline {
            match self.script(json!({"action":"observe"})).await {
                Ok(value) if s(&value, "state") != "pending" && s(&value, "state") != previous => {
                    return Ok(value);
                }
                Ok(_) => (),
                Err(error)
                    if [
                        "browser_navigation_pending",
                        "browser_script_failed",
                        "manual_verification_required",
                    ]
                    .contains(&error.code.as_str()) =>
                {
                    let frame = self.page.frame().await?;
                    ensure(
                        s(&frame, "url") == "about:blank" || self.page.trusted(s(&frame, "url")),
                        "navigation_policy_violation",
                        409,
                    )?;
                }
                Err(error) => return Err(error),
            }
            sleep(Duration::from_millis(200)).await;
        }
        Ok(json!({"state":"challenge"}))
    }
    async fn advance(&mut self, mut value: Value) -> Result<Value> {
        for _ in 0..4 {
            let state = s(&value, "state");
            match state {
                "authenticated" => {
                    self.attempts.succeeded()?;
                    self.credentials = Value::Null;
                    return Ok(json!({"type":"ready"}));
                }
                "invalid_credentials" | "account_locked" | "provider_unavailable" => {
                    return Err(Error::new(state, 409));
                }
                "username" | "password"
                    if !self.credentials.is_null()
                        && (state == "username" && !self.username_submitted
                            || state == "password" && !self.password_submitted) =>
                {
                    let previous = state.to_owned();
                    if state == "username" {
                        self.username_submitted = true;
                    } else {
                        self.password_submitted = true;
                    }
                    self.attempts.submitted()?;
                    let submitted = self
                        .script(json!({"action":"login","credentials":self.credentials}))
                        .await?;
                    if s(&submitted, "state") != "submitted" {
                        break;
                    }
                    value = self.observe(&previous, 30).await?;
                }
                _ => break,
            }
        }
        self.attempts.failed("manual_verification_required")?;
        Ok(json!({"type":"challenge"}))
    }
    pub async fn request(&mut self, command: Value) -> Result<Value> {
        let result = async {
            match s(&command, "action") {
                "start" | "check" => {
                    let observe_only = self
                        .attempts
                        .check(s(&command, "action") == "check" || command["ownerRetry"] == true)?;
                    self.credentials = if observe_only {
                        Value::Null
                    } else {
                        command["credentials"].clone()
                    };
                    self.username_submitted = false;
                    self.password_submitted = false;
                    if self.page.id.is_empty() {
                        self.open().await?;
                    }
                    self.page.navigate(LANDING).await?;
                    let value = self.observe("", 30).await?;
                    self.advance(value).await
                }
                "complete_assistance" => {
                    let value = self.observe("", 2).await?;
                    self.advance(value).await
                }
                "verify" => {
                    let code = s(&command, "code");
                    ensure(
                        (4..=8).contains(&code.len()) && code.bytes().all(|v| v.is_ascii_digit()),
                        "invalid_verification_code",
                        409,
                    )?;
                    let value = self.script(json!({"action":"verify","code":code})).await?;
                    ensure(
                        s(&value, "state") == "submitted",
                        "invalid_verification_code",
                        409,
                    )?;
                    let value = self.observe("challenge", 15).await?;
                    self.advance(value).await
                }
                "screenshot" => {
                    ensure(
                        self.page.trusted(s(&self.page.frame().await?, "url")),
                        "verification_expired",
                        409,
                    )?;
                    let value = self
                        .page
                        .command("Page.captureScreenshot", json!({"format":"png"}))
                        .await?;
                    Ok(json!({"type":"screenshot","image":value["data"]}))
                }
                "assist" => self
                    .page
                    .assist(&command["input"])
                    .await
                    .map(|_| json!({"type":"assisted"})),
                _ => Err(Error::new("verification_expired", 409)),
            }
        }
        .await;
        if let Err(error) = &result {
            self.attempts.failed(&error.code)?;
            if error.code != "invalid_verification_code" {
                self.credentials = Value::Null;
            }
        }
        // Deliberately no provider page text, URL, username, password or OTP in logs.
        result
    }
}
