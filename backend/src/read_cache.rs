//! Bounded derived reads shared across database workers. Call only after authorization,
//! while holding State's transition read lock. Every write advances the revision.
use crate::Result;
use serde::Serialize;
use std::any::Any;
use std::{
    collections::VecDeque,
    sync::Mutex,
    time::{Duration, Instant},
};

struct Entry {
    key: String,
    revision: u64,
    at: Instant,
    value: Box<dyn Any + Send>,
    bytes: usize,
}
#[derive(Default)]
pub struct ReadCache {
    entries: Mutex<VecDeque<Entry>>,
}
impl ReadCache {
    pub fn read<T: Serialize + Clone + Send + 'static>(
        &self,
        key: String,
        revision: u64,
        load: impl FnOnce() -> Result<T>,
    ) -> Result<T> {
        // Do not serialize unrelated readers behind an expensive calculation.
        if let Ok(mut entries) = self.entries.lock() {
            entries.retain(|entry| {
                entry.revision == revision && entry.at.elapsed() < Duration::from_secs(30)
            });
            if let Some(index) = entries.iter().position(|entry| entry.key == key) {
                let entry = entries.remove(index).unwrap();
                let result = entry.value.downcast_ref::<T>().cloned();
                entries.push_back(entry);
                if let Some(result) = result {
                    return Ok(result);
                }
            }
        }
        let value = load()?;
        let bytes = serde_json::to_vec(&value)?.len().saturating_mul(2);
        const BYTES: usize = 8 * 1024 * 1024;
        if bytes <= BYTES
            && let Ok(mut entries) = self.entries.lock()
        {
            entries.retain(|entry| entry.key != key && entry.revision == revision);
            while entries.len() >= 64
                || entries.iter().map(|entry| entry.bytes).sum::<usize>() + bytes > BYTES
            {
                entries.pop_front();
            }
            entries.push_back(Entry {
                key,
                revision,
                at: Instant::now(),
                value: Box::new(value.clone()),
                bytes,
            });
        }
        Ok(value)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn reuses_matching_reads_but_not_another_revision_or_tenant() {
        let cache = ReadCache::default();
        assert_eq!(cache.read("dsp:a:day".into(), 1, || Ok(7)).unwrap(), 7);
        assert_eq!(
            cache
                .read("dsp:a:day".into(), 1, || -> Result<i32> {
                    panic!("must reuse")
                })
                .unwrap(),
            7
        );
        assert_eq!(cache.read("dsp:b:day".into(), 1, || Ok(9)).unwrap(), 9);
        assert_eq!(cache.read("dsp:a:day".into(), 2, || Ok(10)).unwrap(), 10);
    }
    #[test]
    fn oversized_results_and_errors_are_not_cached() {
        let cache = ReadCache::default();
        cache
            .read("large".into(), 1, || Ok("x".repeat(8 * 1024 * 1024)))
            .unwrap();
        assert!(cache.entries.lock().unwrap().is_empty());
        assert!(
            cache
                .read::<i32>("error".into(), 1, || Err(crate::Error::new("failed", 500)))
                .is_err()
        );
        assert!(cache.entries.lock().unwrap().is_empty());
    }
}
