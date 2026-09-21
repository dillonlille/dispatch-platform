//! Host management is independent of application configuration, databases and Tokio.
//! The installed copy survives application/source rollback and verifies candidates
//! before any candidate executable is started.
pub mod artifact;
mod ci;
mod cli;
pub mod io;
mod management;
mod release;
mod releases;
pub mod updater;

pub use cli::run;
pub type Result<T> = std::result::Result<T, Box<dyn std::error::Error + Send + Sync>>;
pub const REPOSITORY: &str = "dillonlille/dispatch-platform";
pub const MAX_BYTES: u64 = 1024 * 1024 * 1024;
pub fn require(value: bool, message: &str) -> Result<()> {
    if value { Ok(()) } else { Err(message.into()) }
}

#[cfg(test)]
mod tests;
