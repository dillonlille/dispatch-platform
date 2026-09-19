//! Bounded loading metadata. Never retain URLs, headers, bodies or credentials.
use crate::{Result, ensure};
use serde_json::{Value, json};
use std::{collections::HashMap, time::Instant};

struct Load {
    loader: String,
    pending: HashMap<String, String>,
    changed: Instant,
    failed: bool,
}
impl Default for Load {
    fn default() -> Self {
        Self {
            loader: String::new(),
            pending: HashMap::new(),
            changed: Instant::now(),
            failed: false,
        }
    }
}
#[derive(Default)]
pub(super) struct Loading(HashMap<String, Load>);
impl Loading {
    pub fn remove(&mut self, session: &str) {
        self.0.remove(session);
    }
    pub fn observe(&mut self, event: &Value) -> Result<()> {
        let Some(session) = event["sessionId"].as_str() else {
            return Ok(());
        };
        let method = event["method"].as_str().unwrap_or("");
        let params = &event["params"];
        let commit = method == "Page.frameNavigated" && params["frame"]["parentId"].is_null();
        let critical = matches!(
            params["type"].as_str(),
            Some("Document" | "Script" | "Stylesheet" | "XHR" | "Fetch")
        );
        let start = method == "Network.requestWillBeSent" && critical;
        if !(commit || start || self.0.contains_key(session)) {
            return Ok(());
        }
        ensure(
            self.0.contains_key(session) || self.0.len() < 8,
            "browser_event_overflow",
            503,
        )?;
        let load = self.0.entry(session.into()).or_default();
        if commit {
            load.loader = params["frame"]["loaderId"].as_str().unwrap_or("").into();
            load.pending
                .retain(|_, loader| loader.is_empty() || *loader == load.loader);
            load.failed = false;
            load.changed = Instant::now();
        } else if start {
            let id = params["requestId"].as_str().unwrap_or("");
            let loader = params["loaderId"].as_str().unwrap_or("");
            ensure(
                id.len() <= 128
                    && loader.len() <= 128
                    && (load.pending.contains_key(id) || load.pending.len() < 512),
                "browser_event_overflow",
                503,
            )?;
            load.pending.insert(id.into(), loader.into());
            load.changed = Instant::now();
        } else if let Some(id) = params["requestId"].as_str() {
            if method == "Network.responseReceived"
                && load.pending.contains_key(id)
                && params["response"]["status"]
                    .as_u64()
                    .is_some_and(|s| s >= 400)
            {
                load.failed = true;
            }
            if matches!(method, "Network.loadingFinished" | "Network.loadingFailed")
                && load.pending.remove(id).is_some()
            {
                load.failed |= method == "Network.loadingFailed";
                load.changed = Instant::now();
            }
        }
        Ok(())
    }
    pub fn status(&self, session: &str, loader: &str) -> Value {
        match self
            .0
            .get(session)
            .filter(|l| !loader.is_empty() && l.loader == loader)
        {
            Some(load) => {
                json!({"known":true,"pending":load.pending.len(),"failed":load.failed,"quietMs":load.changed.elapsed().as_millis() as u64})
            }
            None => json!({"known":false}),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn tracks_data_dependencies_separately_from_images_and_other_tabs() -> Result<()> {
        let mut loading = Loading::default();
        for session in ["one", "two"] {
            loading.observe(&json!({"method":"Page.frameNavigated","sessionId":session,"params":{"frame":{"loaderId":"new"}}}))?;
        }
        for (id, kind) in [("data", "XHR"), ("script", "Script"), ("image", "Image")] {
            loading.observe(&json!({"method":"Network.requestWillBeSent","sessionId":"one","params":{"requestId":id,"loaderId":"new","type":kind}}))?;
        }
        assert_eq!(loading.status("one", "new")["pending"], 2);
        assert_eq!(loading.status("two", "new")["pending"], 0);
        assert_eq!(loading.status("one", "old")["known"], false);
        loading.observe(&json!({"method":"Network.loadingFinished","sessionId":"one","params":{"requestId":"data"}}))?;
        loading.observe(&json!({"method":"Network.loadingFailed","sessionId":"one","params":{"requestId":"script"}}))?;
        assert_eq!(loading.status("one", "new")["pending"], 0);
        assert_eq!(loading.status("one", "new")["failed"], true);
        loading.observe(&json!({"method":"Page.frameNavigated","sessionId":"one","params":{"frame":{"loaderId":"next"}}}))?;
        assert_eq!(loading.status("one", "next")["failed"], false);
        loading.remove("one");
        assert_eq!(loading.status("one", "next")["known"], false);
        Ok(())
    }
}
