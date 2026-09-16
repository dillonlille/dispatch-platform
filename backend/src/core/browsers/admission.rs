//! Admission is conservative: reserve 1 GiB per browser plus 512 MiB for the
//! platform/host. MemAvailable already includes resident browser pages, so only
//! their remaining growth allowance is reserved again. Never kill active work.
use serde::Serialize;
use std::{
    fs,
    path::{Component, Path},
};
pub const BROWSER_BYTES: u64 = 1024 * 1024 * 1024;
const HEADROOM_BYTES: u64 = 512 * 1024 * 1024;
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Admission {
    pub available_bytes: Option<u64>,
    pub required_bytes: u64,
    pub can_start: bool,
}
impl Admission {
    pub fn new(available: Option<u64>, residents: impl Iterator<Item = u64>) -> Self {
        let required = residents.fold(BROWSER_BYTES + HEADROOM_BYTES, |total, resident| {
            total.saturating_add(BROWSER_BYTES.saturating_sub(resident))
        });
        Self {
            available_bytes: available,
            required_bytes: required,
            can_start: available.is_some_and(|bytes| bytes >= required),
        }
    }
}
fn number(path: &Path) -> Option<u64> {
    fs::read_to_string(path).ok()?.trim().parse().ok()
}
fn constrained(mut available: u64, root: &Path, group: &str) -> Option<u64> {
    // cgroup v2 limits can be inherited. Check every visible ancestor; a
    // namespace-relative cgroup root is also covered by the final iteration.
    if !Path::new(group)
        .components()
        .all(|c| matches!(c, Component::RootDir | Component::Normal(_)))
    {
        return None;
    }
    let mut path = root.join(group.trim_start_matches('/'));
    loop {
        if let Some(limit) = number(&path.join("memory.max")) {
            let current = number(&path.join("memory.current"))?;
            available = available.min(limit.saturating_sub(current));
        }
        if path == root || !path.pop() {
            break;
        }
    }
    Some(available)
}
pub fn available() -> Option<u64> {
    let mem = fs::read_to_string("/proc/meminfo").ok()?;
    let available = mem
        .lines()
        .find_map(|line| line.strip_prefix("MemAvailable:"))?
        .split_whitespace()
        .next()?
        .parse::<u64>()
        .ok()?
        .checked_mul(1024)?;
    let cgroup = fs::read_to_string("/proc/self/cgroup").ok()?;
    match cgroup.lines().find_map(|line| line.strip_prefix("0::")) {
        Some(group) => constrained(available, Path::new("/sys/fs/cgroup"), group),
        None => Some(available),
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn simultaneous_starts_reserve_growth_and_resume_when_memory_returns() {
        let free = 2 * BROWSER_BYTES;
        assert!(Admission::new(Some(free), [].into_iter()).can_start);
        assert!(!Admission::new(Some(free), [0].into_iter()).can_start);
        assert!(Admission::new(Some(free), [BROWSER_BYTES].into_iter()).can_start);
        assert!(!Admission::new(None, [].into_iter()).can_start);
        assert!(!Admission::new(Some(HEADROOM_BYTES), [].into_iter()).can_start);
    }
    #[test]
    fn cgroup_ancestor_limits_and_current_usage_constrain_host_memory() {
        let temp = tempfile::tempdir().unwrap();
        let child = temp.path().join("parent/child");
        fs::create_dir_all(&child).unwrap();
        fs::write(child.join("memory.max"), "max").unwrap();
        fs::write(temp.path().join("parent/memory.max"), "1000").unwrap();
        fs::write(temp.path().join("parent/memory.current"), "600").unwrap();
        assert_eq!(constrained(5000, temp.path(), "/parent/child"), Some(400));
        assert_eq!(constrained(300, temp.path(), "/parent/child"), Some(300));
        fs::write(temp.path().join("parent/memory.current"), "1100").unwrap();
        assert_eq!(constrained(5000, temp.path(), "/parent/child"), Some(0));
        assert_eq!(constrained(5000, temp.path(), "/../escape"), None);
    }
}
