//! CI decisions shared by the lightweight planner and the host artifact verifier.
pub mod cache;
pub mod policy;
pub mod preflight;
pub mod process;
pub mod runs;
use std::path::Path;
pub type Result<T> = std::result::Result<T, Box<dyn std::error::Error + Send + Sync>>;
/// Where API calls, receipts and provenance name this repository.
pub const REPOSITORY: &str = "dispatch-systems/dispatch-platform";
/// Every name this repository answers to: its organization name and the personal account
/// it moved from, whose URLs GitHub still redirects. Only their owners can create
/// repositories under these names, so identity checks accept either, and receipts,
/// provenance and installed Production updaters from before the move stay valid.
pub const REPOSITORIES: [&str; 2] = [
    "dillonlille/dispatch-platform",
    "dispatch-systems/dispatch-platform",
];
/// Whether GitHub named this repository, under any of its names.
pub fn ours(name: &serde_json::Value) -> bool {
    name.as_str()
        .is_some_and(|name| REPOSITORIES.contains(&name))
}
/// A GitHub web URL for this repository under any of its names, as the path after it.
pub fn web_path(url: &str) -> Option<&str> {
    REPOSITORIES
        .iter()
        .find_map(|name| url.strip_prefix(&format!("https://github.com/{name}/")))
}
/// Lowercase hex of a digest, as `sha256sum` prints it.
pub fn to_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
pub fn require(value: bool, message: &str) -> Result<()> {
    if value { Ok(()) } else { Err(message.into()) }
}
pub trait Runner {
    fn command(&self, args: &[&str], cwd: Option<&Path>, timeout: u64) -> Result<Vec<u8>>;
}
pub struct Native;
impl Runner for Native {
    fn command(&self, args: &[&str], cwd: Option<&Path>, timeout: u64) -> Result<Vec<u8>> {
        process::command(args, cwd, timeout, None)
    }
}
#[cfg(test)]
mod tests;
