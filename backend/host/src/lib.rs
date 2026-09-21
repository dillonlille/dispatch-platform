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
pub use dispatch_ci::{REPOSITORY, Result, require};
pub const MAX_BYTES: u64 = 1024 * 1024 * 1024;

#[cfg(test)]
mod tests;
