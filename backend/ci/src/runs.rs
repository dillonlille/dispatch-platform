use serde_json::Value;

pub fn latest_run<'a>(
    runs: &'a Value,
    sha: &str,
    event: &str,
    branch: Option<&str>,
    skipped: bool,
) -> Option<&'a Value> {
    runs.as_array()?
        .iter()
        .filter(|r| {
            r["head_sha"] == sha
                && r["event"] == event
                && (skipped || r["conclusion"] != "skipped")
                && branch.is_none_or(|b| r["head_branch"] == b)
                && crate::ours(&r["head_repository"]["full_name"])
        })
        .max_by_key(|r| {
            (
                r["id"].as_u64().unwrap_or(0),
                r["run_attempt"].as_u64().unwrap_or(1),
            )
        })
}
pub fn passed(run: &Value) -> bool {
    run["status"] == "completed" && run["conclusion"] == "success"
}
