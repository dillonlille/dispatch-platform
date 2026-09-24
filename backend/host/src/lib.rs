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
mod setup;
pub mod updater;

pub use cli::run;
pub use dispatch_ci::{REPOSITORIES, REPOSITORY, Result, require, web_path};
pub const MAX_BYTES: u64 = 1024 * 1024 * 1024;

/// Lowercase hex of a digest, as `sha256sum` prints it.
pub fn to_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
#[cfg(test)]
mod tests;
