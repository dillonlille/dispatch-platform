//! CI decisions shared by the lightweight planner and the host artifact verifier.
pub mod cache;
pub mod policy;
pub mod preflight;
pub mod process;
pub mod runs;
use std::path::Path;
pub type Result<T> = std::result::Result<T, Box<dyn std::error::Error + Send + Sync>>;
pub const REPOSITORY: &str = "dillonlille/dispatch-platform";
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
