//! Deterministic Paycom driver. Credentials, attempt limits and orchestration
//! belong to Rust; JavaScript is restricted to provider page operations.
mod collection;
mod extract;
use super::{
    attempt,
    driver::{Collected, Driver as Drives, Pending, Run},
    page::{Page, call},
};
#[cfg(test)]
mod benchmark;
use super::browseros;
use crate::{
    Error, Result,
    db::{self, s},
    ensure,
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{path::Path, time::Duration};
use tokio::time::{Instant, sleep};
// The page is between documents or still loading its scripts; ask it again.
const PAGE_NOT_READY: &[crate::Code] = &[
    crate::Code::BrowserNavigationPending,
    crate::Code::BrowserScriptFailed,
    crate::Code::ManualVerificationRequired,
];

const LANDING: &str = "/v4/cl/web.php/client-landing/arc";
const SEARCH: &str = "/v4/cl/web.php/timecardsearch/index?from=main_menu";
const AUTH: &str = include_str!("auth.js");
struct Assistance {
    loader: String,
    challenge: Value,
    fingerprint: Option<Vec<u8>>,
    resume: bool,
}
pub struct Driver {
    pub browser: browseros::Session,
    origin: String,
    fixture: bool,
    page: Page,
    attempts: attempt::Attempts,
    diagnostics: std::path::PathBuf,
    credentials: Value,
    assistance: Option<Assistance>,
}
impl Driver {
    pub async fn new(
        browser: browseros::Session,
        profile: &Path,
        fixture: Option<&str>,
    ) -> Result<Self> {
        let parent = profile
            .parent()
            .ok_or_else(|| Error::new("unsafe_storage_path", 500))?;
        let origin = fixture
            .unwrap_or("https://www.paycomonline.net")
            .trim_end_matches('/')
            .to_owned();
        Ok(Self {
            page: Page::empty(browser.clone(), origin.clone()),
            browser,
            origin,
            fixture: fixture.is_some(),
            attempts: attempt::Attempts::beside(profile, "paycom")?,
            diagnostics: parent.join("paycom-diagnostics.json"),
            credentials: Value::Null,
            assistance: None,
        })
    }
    async fn script(&self, mut input: Value) -> Result<Value> {
        input["origin"] = json!(self.origin);
        self.page.evaluate(&call(AUTH, &input)).await
    }
    async fn new_page(&mut self) -> Result<()> {
        let page = Page::open(self.browser.clone(), self.origin.clone()).await?;
        page.size_window().await?;
        self.page = page;
        self.page.front_alone().await
    }
    async fn navigate(&self, path: &str) -> Result<()> {
        self.page.navigate(path).await?;
        sleep(Duration::from_millis(150)).await;
        Ok(())
    }
    async fn observe(&self, phase: &str, previous: &str, seconds: u64) -> Result<Value> {
        let deadline = Instant::now() + Duration::from_secs(seconds);
        let mut last = Value::Null;
        while Instant::now() < deadline {
            match self.script(json!({"action":"observe","phase":phase})).await {
                Ok(value) => {
                    let state = s(&value, "state");
                    let profile_rendering = s(&value["snapshot"], "url")
                        .contains("/two-factor/react/index/preferences/campaign")
                        && value["snapshot"]["captchaPresent"] != true
                        && value["snapshot"]["otpPresent"] != true
                        && ["security_profile_layout_changed", "additional_verification"]
                            .contains(&s(&value, "reason"));
                    if state != "pending" && state != previous && !profile_rendering {
                        return Ok(value);
                    }
                    last = value;
                }
                Err(e) if e.is_any(PAGE_NOT_READY) => {
                    let frame = self.page.frame().await?;
                    if s(&frame, "url") != "about:blank" && !self.page.trusted(s(&frame, "url")) {
                        return Err(e);
                    }
                }
                Err(e) => return Err(e),
            }
            sleep(Duration::from_millis(200)).await;
        }
        if !last.is_null() {
            return Ok(json!({"state":"manual_verification_required","snapshot":last["snapshot"]}));
        }
        Err(Error::new("authentication_timeout", 504))
    }
    async fn native_click(&self, point: &Value, expected: &str) -> Result<()> {
        ensure(
            s(point, "status") == expected,
            "manual_verification_required",
            409,
        )?;
        self.page.command("Page.bringToFront", json!({})).await?;
        let x = point["x"]
            .as_f64()
            .ok_or_else(|| Error::new("manual_verification_required", 409))?;
        let y = point["y"]
            .as_f64()
            .ok_or_else(|| Error::new("manual_verification_required", 409))?;
        // BrowserOS chrome is asymmetric. Derive the content origin from a real
        // browser pointer event instead of assuming equal window borders.
        self.page.evaluate("(()=>{globalThis.dispatchPointer=null;\
                globalThis.dispatchPointerListener=e=>{if(e.isTrusted)globalThis.dispatchPointer={x:e.clientX,\
                y:e.clientY,screenX:e.screenX,screenY:e.screenY,scale:devicePixelRatio};};\
                window.addEventListener('mousemove',globalThis.dispatchPointerListener,true);return true;})()").await?;
        self.browser.native_move(510, 380).await?;
        self.browser.native_move(512, 384).await?;
        let geometry=self.page.evaluate("(()=>{window.removeEventListener('mousemove',\
                globalThis.dispatchPointerListener,true);delete globalThis.dispatchPointerListener;const \
                value=globalThis.dispatchPointer;delete globalThis.dispatchPointer;return value;})()").await?;
        ensure(
            geometry["scale"] == 1 && geometry["screenX"] == 512 && geometry["screenY"] == 384,
            "browser_interaction_required",
            409,
        )?;
        let origin_x = 512. - geometry["x"].as_f64().unwrap_or(10000.);
        let origin_y = 384. - geometry["y"].as_f64().unwrap_or(10000.);
        self.browser
            .native_click((origin_x + x).round() as i32, (origin_y + y).round() as i32)
            .await?;
        Ok(())
    }
    async fn pin_fingerprint(&self) -> Result<Option<Vec<u8>>> {
        let values=self.page.evaluate("(()=>{const \
            fields=[...document.querySelectorAll('input[name=firstSecurityQuestion],\
                input[name=secondSecurityQuestion]')];return fields.length===2&&fields.every(e=>e.value)\
                ?fields.map(e=>[e.name,e.value]):null})()").await?;
        Ok(if values.is_null() {
            None
        } else {
            Some(Sha256::digest(serde_json::to_vec(&values)?).to_vec())
        })
    }
    async fn challenge(&mut self, observation: &Value) -> Result<Value> {
        let snapshot = &observation["snapshot"];
        let fingerprint = self.pin_fingerprint().await?;
        self.assistance = Some(Assistance {
            loader: s(&self.page.frame().await?, "loaderId").into(),
            challenge: snapshot["challenge"].clone(),
            resume: fingerprint.is_none()
                && (snapshot["loginPresent"]
                    .as_array()
                    .is_some_and(|v| v.iter().all(|v| v == true))
                    || snapshot["challenge"]
                        .as_array()
                        .is_some_and(|v| v.len() == 2)),
            fingerprint,
        });
        self.attempts.failed("manual_verification_required")?;
        Ok(json!({"type":"challenge"}))
    }
    fn ready(&mut self) -> Result<Value> {
        self.attempts.succeeded()?;
        self.credentials = Value::Null;
        self.assistance = None;
        Ok(json!({"type":"ready"}))
    }
    async fn advance(
        &mut self,
        mut current: Value,
        allow_submit: bool,
        application: bool,
    ) -> Result<Value> {
        let mut primary = false;
        let mut pins = false;
        let mut confirmed = false;
        for _ in 0..8 {
            let state = s(&current, "state").to_owned();
            match state.as_str() {
                "authenticated" | "timecard_application" => {
                    if application && state != "timecard_application" {
                        self.navigate(SEARCH).await?;
                        current = self.observe("observation", "", 45).await?;
                    } else {
                        return self.ready();
                    }
                }
                "logged_out" if allow_submit && !primary && !self.credentials.is_null() => {
                    primary = true;
                    self.attempts.submitted()?;
                    let value = self
                        .script(json!({"action":"login","credentials":self.credentials}))
                        .await?;
                    ensure(
                        s(&value, "status") == "submitted",
                        "manual_verification_required",
                        409,
                    )?;
                    current = self.observe("primary_login", "logged_out", 45).await?;
                }
                "security_questions_required"
                    if allow_submit && !pins && !self.credentials.is_null() =>
                {
                    pins = true;
                    let challenge = current["snapshot"]["challenge"].clone();
                    let fields = challenge
                        .as_array()
                        .ok_or_else(|| Error::new("manual_verification_required", 409))?;
                    let mut credentials = self.credentials.clone();
                    for index in 1..=5 {
                        credentials[format!("pin{index}")] =
                            self.credentials["securityAnswers"][index - 1].clone();
                    }
                    for field in fields {
                        let index = field["index"].as_u64().unwrap_or(0) as usize;
                        let pin = s(&credentials, &format!("pin{index}"));
                        ensure(
                            !pin.is_empty()
                                && pin.len() <= 64
                                && pin.bytes().all(|b| (32..=126).contains(&b)),
                            "manual_verification_required",
                            409,
                        )?;
                    }
                    self.attempts.submitted()?;
                    for field in fields {
                        let point=self.script(json!({"action":"focus","challenge":challenge,"index":field["index"]})).await?;
                        self.native_click(&point, "native_challenge_field_ready")
                            .await?;
                        let focused = self
                            .script(json!({"action":"focus","challenge":challenge,
                            "index":field["index"],"verifyFocus":true}))
                            .await?;
                        ensure(
                            s(&focused, "status") == "native_challenge_field_focused",
                            "manual_verification_required",
                            409,
                        )?;
                        self.browser
                            .native_type(s(&credentials, &format!("pin{}", field["index"])))
                            .await?;
                    }
                    let point=self.script(json!({"action":"pins","credentials":credentials,"challenge":challenge})).await?;
                    self.native_click(&point, "native_challenge_ready").await?;
                    current = self
                        .observe("security_questions", "security_questions_required", 15)
                        .await?;
                }
                "security_profile_prompt" | "security_profile_confirmation" => {
                    let step = if state == "security_profile_confirmation" {
                        confirmed = true;
                        "confirm"
                    } else if confirmed {
                        "proceed"
                    } else {
                        "dismiss"
                    };
                    let point = self.script(json!({"action":"profile","step":step})).await?;
                    let expected = match step {
                        "confirm" => "security_profile_confirmation_ready",
                        "proceed" => "security_profile_proceed_ready",
                        _ => "security_profile_dismiss_ready",
                    };
                    self.native_click(&point, expected).await?;
                    current = self.observe("security_profile", &state, 15).await?;
                }
                "primary_credentials_rejected" | "security_answers_rejected" | "account_locked" => {
                    return Err(Error::new(&state, 409));
                }
                _ => return self.challenge(&current).await,
            }
        }
        self.challenge(&current).await
    }
    async fn authenticate(&mut self, credentials: Value, retry: bool) -> Result<Value> {
        let observe_only = self.attempts.check(retry)?;
        self.credentials = if observe_only {
            Value::Null
        } else {
            credentials
        };
        self.assistance = None;
        if self.page.id.is_empty() {
            self.new_page().await?;
        }
        self.navigate(LANDING).await?;
        let current = self.observe("observation", "", 20).await?;
        self.advance(current, !observe_only, false).await
    }
    async fn complete(&mut self) -> Result<Value> {
        let current = self.observe("observation", "", 1).await?;
        if current["snapshot"]["captchaPresent"] == true
            || current["snapshot"]["otpPresent"] == true
        {
            return Ok(json!({"type":"challenge"}));
        }
        if ["authenticated", "timecard_application"].contains(&s(&current, "state")) {
            return self.ready();
        }
        if let Some(assistance) = self.assistance.take() {
            let same = assistance.loader == s(&self.page.frame().await?, "loaderId");
            if same
                && assistance.fingerprint.is_some()
                && assistance.fingerprint == self.pin_fingerprint().await?
            {
                let point = self
                    .script(
                        json!({"action":"pins","credentials":{},"challenge":assistance.challenge,
                    "retainValues":true}),
                    )
                    .await?;
                self.attempts.submitted()?;
                self.native_click(&point, "native_challenge_ready").await?;
                let current = self
                    .observe("security_questions", "security_questions_required", 15)
                    .await?;
                return self.advance(current, false, false).await;
            }
            if same && assistance.resume {
                return self.advance(current, true, false).await;
            }
            // Keep the original document/value proof. A changed document or PIN
            // must not become eligible for replay on a second Submit click.
            self.assistance = Some(assistance);
            return Ok(json!({"type":"challenge"}));
        }
        self.advance(current, false, false).await
    }
    pub async fn request(&mut self, command: Value) -> Result<Value> {
        let result=async { match s(&command,"action") {
            "start" | "check" => self.authenticate(command["credentials"].clone(),s(&command,
                "action")=="check" || command["ownerRetry"]==true).await,
            "complete_assistance" => self.complete().await,
            "screenshot" => self.page.screenshot().await,
            "assist" => self.page.assisted(&command["input"]).await,
            "verify" => {
                let focused=self.page.evaluate("(()=>{const \
                    fields=[...document.querySelectorAll('input[autocomplete=\"one-time-code\"],\
                input[name=code],input[name=otp],input[name=verificationCode],input[name=verification_code]')\
                ].filter(e=>!e.disabled&&e.offsetParent!==null);if(fields.length!==1)return false;\
                fields[0].focus();return true})()").await?;
                ensure(focused==true,"invalid_verification_code",409)?;
                self.page.command("Input.insertText",json!({"text":command["code"]})).await?;
                self.page.assist(&json!({"kind":"key","key":"Enter"})).await?;
                sleep(Duration::from_millis(350)).await;
                self.complete().await
            },
            _ => Err(Error::new("verification_expired",409)),
        } }.await;
        if let Err(error) = &result {
            self.attempts.failed(&error.code)?;
            self.credentials = Value::Null;
        }
        // No DOM text, URLs, PINs, headers or provider errors enter diagnostics.
        let code = result
            .as_ref()
            .map(|value| s(value, "type"))
            .unwrap_or_else(|e| e.code.as_str());
        db::write_private(
            &self.diagnostics,
            &serde_json::to_vec(&json!({"state":code,"at":db::iso(),"engine":"rust-browseros"}))?,
        )?;
        result
    }
}
impl Drives for Driver {
    fn request(&mut self, command: Value) -> Pending<'_, Value> {
        Box::pin(Driver::request(self, command))
    }
    fn collect<'a>(&'a mut self, run: &'a Run<'a>) -> Pending<'a, Collected> {
        Box::pin(async move {
            if let Some(scope) = crate::workforce::sync::EmployeeSync::parse(run.request)? {
                let code = scope.employee_code.clone();
                let job = run.job.to_owned();
                let owner = run.owner.to_owned();
                let employee = run
                    .state
                    .read(move |store| {
                        let dsp = store.guard_job(&job, &owner)?;
                        store.paycom_employee(s(&dsp, "id"), &code)
                    })
                    .await?;
                let data = self
                    .collect_employee(run, &employee, &scope.period())
                    .await?;
                return Ok(Collected { data, scope: None });
            }
            let data = Driver::collect(
                self,
                run.timezone,
                crate::workforce::collection_date(run.request, run.timezone)?,
                run.metrics,
                Some(&crate::collection_checkpoint::Checkpoint::new(
                    run.state.clone(),
                    run.job,
                    run.owner,
                )),
                |progress, message| run.progress(progress, message),
                run.attempt == 1,
            )
            .await?;
            Ok(Collected { data, scope: None })
        })
    }
    fn browser(&self) -> Option<&browseros::Session> {
        Some(&self.browser)
    }
}
