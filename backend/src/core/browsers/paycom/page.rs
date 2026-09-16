//! Per-tab state. Tabs share a bounded BrowserOS session, not execution contexts.
use super::*;
pub(super) struct Page {
    pub id: String,
    pub target: String,
    browser: browseros::Session,
    origin: String,
    world: std::sync::Mutex<Option<(String, String, i64)>>,
}
impl Page {
    pub fn empty(browser: browseros::Session, origin: String) -> Self {
        Self {
            id: String::new(),
            target: String::new(),
            browser,
            origin,
            world: std::sync::Mutex::new(None),
        }
    }
    pub async fn open(browser: browseros::Session, origin: String) -> Result<Self> {
        let target = browser
            .command(
                "Target.createTarget",
                json!({"url":"about:blank","background":true}),
                None,
            )
            .await?;
        let target = s(&target, "targetId").to_owned();
        let attached = browser
            .command(
                "Target.attachToTarget",
                json!({"targetId":target,"flatten":true}),
                None,
            )
            .await?;
        let mut page = Self::empty(browser, origin);
        page.id = s(&attached, "sessionId").to_owned();
        page.target = target;
        page.command("Page.enable", json!({})).await?;
        Ok(page)
    }
    pub(super) async fn command(&self, method: &str, params: Value) -> Result<Value> {
        self.browser.command(method, params, Some(&self.id)).await
    }
    pub(super) async fn frame(&self) -> Result<Value> {
        Ok(self.command("Page.getFrameTree", json!({})).await?["frameTree"]["frame"].clone())
    }
    pub(super) fn trusted(&self, value: &str) -> bool {
        url::Url::parse(value).is_ok_and(|url| {
            url.origin().ascii_serialization() == self.origin
                && url.username().is_empty()
                && url.password().is_none()
                && url.fragment().is_none()
        })
    }
    pub(super) async fn evaluate(&self, expression: &str) -> Result<Value> {
        let frame = self.frame().await?;
        ensure(
            self.trusted(s(&frame, "url")),
            "manual_verification_required",
            409,
        )?;
        self.evaluate_in(&frame, expression).await
    }
    async fn evaluate_in(&self, frame: &Value, expression: &str) -> Result<Value> {
        let cached = self.world.lock().expect("page world").clone();
        let context = if let Some((_, _, context)) =
            cached.filter(|(id, loader, _)| id == s(frame, "id") && loader == s(frame, "loaderId"))
        {
            context
        } else {
            let world = self
                .command(
                    "Page.createIsolatedWorld",
                    json!({"frameId":frame["id"],"worldName":"dispatch-paycom"}),
                )
                .await?;
            ensure(
                world.get("navigationPending").is_none(),
                "browser_navigation_pending",
                502,
            )?;
            let context = world["executionContextId"]
                .as_i64()
                .ok_or_else(|| Error::new("browser_navigation_pending", 502))?;
            *self.world.lock().expect("page world") =
                Some((s(frame, "id").into(), s(frame, "loaderId").into(), context));
            context
        };
        let value=self.command("Runtime.evaluate",json!({"expression":expression,"contextId":context,"returnByValue":true,"awaitPromise":true})).await?;
        if value.get("navigationPending").is_some() {
            *self.world.lock().expect("page world") = None;
        }
        ensure(
            value.get("navigationPending").is_none(),
            "browser_navigation_pending",
            502,
        )?;
        ensure(
            value.get("exceptionDetails").is_none(),
            "browser_script_failed",
            502,
        )?;
        Ok(value["result"]["value"].clone())
    }
    pub async fn navigate(&self, path: &str) -> Result<()> {
        let source = format!("{}{path}", self.origin);
        ensure(self.trusted(&source), "navigation_policy_violation", 409)?;
        let value = self.command("Page.navigate", json!({"url":source})).await?;
        ensure(
            value.get("errorText").is_none(),
            "provider_unavailable",
            502,
        )
    }
    pub async fn collect_garbage(&self) -> Result<()> {
        self.command("HeapProfiler.collectGarbage", json!({}))
            .await?;
        Ok(())
    }
    pub async fn start_navigation(&self, source: &str) -> Result<String> {
        ensure(self.trusted(source), "navigation_policy_violation", 409)?;
        let current = self.frame().await?;
        ensure(
            s(&current, "url") == "about:blank" || self.trusted(s(&current, "url")),
            "authentication_failed",
            409,
        )?;
        // Page.navigate holds the serialized CDP actor until the server responds.
        // A scripted navigation starts the request and immediately releases it,
        // allowing the other tab to load while this one waits for Paycom.
        // Replace history so completed employee pages cannot accumulate in the
        // back/forward cache while the tab is reused.
        match self
            .evaluate_in(
                &current,
                &format!("location.replace({}); true", json!(source)),
            )
            .await
        {
            Ok(_) => (),
            Err(error) if error.code == "browser_navigation_pending" => (),
            Err(error) => return Err(error),
        }
        Ok(s(&current, "loaderId").to_owned())
    }
}
