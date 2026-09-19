//! The driver of fixture mode: no browser and no provider. Passwords choose the
//! outcome, and each collector supplies the data a collection returns.
use super::{
    Provider, browseros,
    driver::{Collected, Driver as Drives, Pending, Run},
};
use crate::{Error, db::s, ensure};
use serde_json::{Value, json};
use std::time::Duration;

pub struct Driver {
    provider: Provider,
    challenge: bool,
}
impl Driver {
    pub fn new(provider: Provider) -> Self {
        Self {
            provider,
            challenge: false,
        }
    }
}
impl Drives for Driver {
    fn request(&mut self, command: Value) -> Pending<'_, Value> {
        Box::pin(async move {
            match s(&command, "action") {
                "start" | "check" => {
                    let password = s(&command["credentials"], "password");
                    ensure(password != "invalid-password", "invalid_credentials", 409)?;
                    self.challenge = password == "require-verification";
                }
                "verify" => {
                    ensure(self.challenge, "verification_not_requested", 409)?;
                    ensure(
                        s(&command, "code") == "123456",
                        "invalid_verification_code",
                        409,
                    )?;
                    self.challenge = false;
                }
                _ => return Err(Error::new("verification_expired", 409)),
            }
            Ok(json!({"type":if self.challenge{"challenge"}else{"ready"}}))
        })
    }
    fn collect<'a>(&'a mut self, run: &'a Run<'a>) -> Pending<'a, Collected> {
        Box::pin(async move {
            tokio::time::sleep(Duration::from_millis(100)).await;
            self.provider.collector().fixture(run.timezone, run.request)
        })
    }
    fn browser(&self) -> Option<&browseros::Session> {
        None
    }
}
