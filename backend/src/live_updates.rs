//! In-memory wakeups only; each subscriber reads authoritative data after waking.
use crate::Result;
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};
use tokio::sync::{Semaphore, watch};

pub struct Updates {
    epoch: String,
    tenants: Mutex<HashMap<String, watch::Sender<u64>>>,
    pub slots: Arc<Semaphore>,
}
impl Updates {
    pub fn new() -> Result<Self> {
        Ok(Self {
            epoch: super::crypto::id("live")?,
            tenants: Mutex::new(HashMap::new()),
            slots: Arc::new(Semaphore::new(128)),
        })
    }
    pub fn subscribe(&self, dsp: &str) -> watch::Receiver<u64> {
        self.tenants
            .lock()
            .unwrap()
            .entry(dsp.into())
            .or_insert_with(|| watch::channel(0).0)
            .subscribe()
    }
    pub fn notify(&self, dsp: &str) {
        if let Some(sender) = self.tenants.lock().unwrap().get(dsp) {
            sender.send_modify(|revision| *revision += 1);
        }
    }
    pub fn token(&self, receiver: &watch::Receiver<u64>) -> String {
        format!("{}:{}", self.epoch, *receiver.borrow())
    }
}
