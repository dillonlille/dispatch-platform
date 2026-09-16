//! Per-attempt diagnostics. Only timings, counts and memory totals are persisted.
use super::{
    Result,
    db::{self, Store, n, s},
};
use serde::Serialize;
use serde_json::Value;
use std::{
    collections::HashSet,
    fs,
    sync::{Arc, Mutex},
    time::Instant,
};

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Phase {
    Starting,
    Authentication,
    Verification,
    Collection,
    Publication,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Metrics {
    attempt: i64,
    started_at: String,
    finished_at: Option<String>,
    outcome: String,
    error: Option<String>,
    phase: Option<Phase>,
    queue_ms: u64,
    elapsed_ms: u64,
    authentication_ms: Option<u64>,
    verification_ms: Option<u64>,
    collection_ms: Option<u64>,
    publication_ms: Option<u64>,
    employees: Option<usize>,
    timecards: Option<usize>,
    peak_rss_bytes: Option<u64>,
    peak_pss_bytes: Option<u64>,
    peak_private_bytes: Option<u64>,
    memory_samples: u64,
    incomplete_memory_samples: u64,
}
impl Metrics {
    pub fn new(job: &Value) -> Self {
        Self {
            attempt: n(job, "attempt"),
            started_at: s(job, "started_at").into(),
            finished_at: None,
            outcome: "running".into(),
            error: None,
            phase: Some(Phase::Starting),
            queue_ms: db::now().saturating_sub(n(job, "available_at")).max(0) as u64,
            elapsed_ms: 0,
            authentication_ms: None,
            verification_ms: None,
            collection_ms: None,
            publication_ms: None,
            employees: None,
            timecards: None,
            peak_rss_bytes: None,
            peak_pss_bytes: None,
            peak_private_bytes: None,
            memory_samples: 0,
            incomplete_memory_samples: 0,
        }
    }
    fn add(&mut self, phase: Phase, ms: u64) {
        let value = match phase {
            Phase::Starting => return,
            Phase::Authentication => &mut self.authentication_ms,
            Phase::Verification => &mut self.verification_ms,
            Phase::Collection => &mut self.collection_ms,
            Phase::Publication => &mut self.publication_ms,
        };
        *value = Some(value.unwrap_or(0).saturating_add(ms));
    }
}
struct Clock {
    value: Metrics,
    started: Instant,
    changed: Instant,
}
#[derive(Clone)]
pub struct Recorder(Arc<Mutex<Clock>>);
impl Recorder {
    pub fn new(job: &Value) -> Self {
        let now = Instant::now();
        Self(Arc::new(Mutex::new(Clock {
            value: Metrics::new(job),
            started: now,
            changed: now,
        })))
    }
    pub fn phase(&self, phase: Phase) {
        let mut clock = self.0.lock().expect("job metrics");
        if let Some(previous) = clock.value.phase {
            let elapsed = clock.changed.elapsed().as_millis() as u64;
            clock.value.add(previous, elapsed);
        }
        clock.value.add(phase, 0);
        clock.value.phase = Some(phase);
        clock.changed = Instant::now();
    }
    pub fn counts(&self, data: &Value) {
        let mut clock = self.0.lock().expect("job metrics");
        clock.value.employees = data["employees"].as_array().map(Vec::len);
        clock.value.timecards = data["timecards"].as_array().map(Vec::len);
    }
    pub fn snapshot(&self) -> Metrics {
        let clock = self.0.lock().expect("job metrics");
        let mut value = clock.value.clone();
        if let Some(phase) = value.phase {
            value.add(phase, clock.changed.elapsed().as_millis() as u64);
            value.elapsed_ms = clock.started.elapsed().as_millis() as u64;
        }
        value
    }
    pub fn finish(&self, outcome: &str, error: Option<&str>) {
        let mut clock = self.0.lock().expect("job metrics");
        if let Some(phase) = clock.value.phase.take() {
            let elapsed = clock.changed.elapsed().as_millis() as u64;
            clock.value.add(phase, elapsed);
            clock.value.elapsed_ms = clock.started.elapsed().as_millis() as u64;
            clock.value.finished_at = Some(db::iso());
            clock.value.outcome = outcome.into();
            clock.value.error = error.map(str::to_owned);
        }
    }
    pub fn observe(&self, sample: Memory) {
        let mut clock = self.0.lock().expect("job metrics");
        let value = &mut clock.value;
        value.memory_samples += 1;
        value.peak_rss_bytes = Some(value.peak_rss_bytes.unwrap_or(0).max(sample.rss));
        if sample.complete {
            value.peak_pss_bytes = Some(value.peak_pss_bytes.unwrap_or(0).max(sample.pss));
            value.peak_private_bytes =
                Some(value.peak_private_bytes.unwrap_or(0).max(sample.private));
        } else {
            value.incomplete_memory_samples += 1;
        }
    }
}
impl Store {
    pub fn save_metrics(&self, job: &str, owner: &str, metrics: &Metrics) -> Result<()> {
        // An interrupted attempt is sealed by recovery. Late writes cannot replace
        // its diagnostics or those of a newer attempt, even after cancellation.
        self.jobs.exec("UPDATE job_metrics SET metrics=? WHERE job_id=? AND attempt=? AND owner=? AND json_extract(metrics,'$.outcome')='running'",rusqlite::params![serde_json::to_string(metrics)?,job,metrics.attempt,owner])?;
        Ok(())
    }
    pub fn metrics(&self, job: &str) -> Result<Vec<Value>> {
        self.jobs
            .all(
                "SELECT metrics FROM job_metrics WHERE job_id=? ORDER BY attempt",
                [job],
            )?
            .iter()
            .map(|row| Ok(serde_json::from_str(s(row, "metrics"))?))
            .collect()
    }
}

#[derive(Default)]
pub struct Memory {
    pub rss: u64,
    pub pss: u64,
    pub private: u64,
    pub complete: bool,
}
fn field(text: &str, name: &str) -> u64 {
    text.lines()
        .find_map(|line| line.strip_prefix(name))
        .and_then(|v| v.split_whitespace().next())
        .and_then(|v| v.parse().ok())
        .unwrap_or(0)
}
/// Host diagnostics for one supervisor and its descendants. Call on a blocking
/// thread; no browser commands, process arguments or provider data are read.
pub fn memory(root: u32) -> Option<Memory> {
    let mut processes = Vec::new();
    for entry in fs::read_dir("/proc").ok()?.flatten() {
        let Ok(pid) = entry.file_name().to_string_lossy().parse::<u32>() else {
            continue;
        };
        let Ok(status) = fs::read_to_string(entry.path().join("status")) else {
            continue;
        };
        processes.push((
            pid,
            field(&status, "PPid:") as u32,
            field(&status, "VmRSS:") * 1024,
        ));
    }
    if !processes.iter().any(|(pid, _, _)| *pid == root) {
        return None;
    }
    let mut ids = HashSet::from([root]);
    loop {
        let before = ids.len();
        for &(pid, parent, _) in &processes {
            if ids.contains(&parent) {
                ids.insert(pid);
            }
        }
        if ids.len() == before {
            break;
        }
    }
    let mut result = Memory {
        complete: true,
        ..Default::default()
    };
    for (pid, _, rss) in processes.iter().filter(|(pid, _, _)| ids.contains(pid)) {
        result.rss += rss;
        match fs::read_to_string(format!("/proc/{pid}/smaps_rollup")) {
            Ok(smaps) => {
                if !smaps.lines().any(|line| line.starts_with("Pss:")) {
                    result.complete = false;
                }
                result.pss += field(&smaps, "Pss:") * 1024;
                result.private += (field(&smaps, "Private_Clean:")
                    + field(&smaps, "Private_Dirty:")
                    + field(&smaps, "Private_Hugetlb:"))
                    * 1024;
            }
            Err(error)
                if error.kind() == std::io::ErrorKind::NotFound
                    || error.raw_os_error() == Some(libc::ESRCH) => {}
            Err(_) => result.complete = false,
        }
    }
    Some(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn partial_samples_do_not_claim_a_complete_shared_memory_peak() {
        let recorder =
            Recorder::new(&json!({"attempt":1,"started_at":db::iso(),"available_at":db::now()}));
        recorder.observe(Memory {
            rss: 100,
            pss: 70,
            private: 50,
            complete: true,
        });
        recorder.observe(Memory {
            rss: 200,
            pss: 150,
            private: 100,
            complete: false,
        });
        let value = recorder.snapshot();
        assert_eq!(value.peak_rss_bytes, Some(200));
        assert_eq!(value.peak_pss_bytes, Some(70));
        assert_eq!(value.peak_private_bytes, Some(50));
        assert_eq!(value.incomplete_memory_samples, 1);
        assert_eq!(value.authentication_ms, None);
        recorder.phase(Phase::Collection);
        recorder.finish("cancelled", Some("job_cancelled"));
        assert_eq!(recorder.snapshot().outcome, "cancelled");
        assert!(recorder.snapshot().collection_ms.is_some());
        assert!(recorder.snapshot().publication_ms.is_none());
    }
}
