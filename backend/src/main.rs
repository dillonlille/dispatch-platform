#[tokio::main(worker_threads = 2)]
async fn main() {
    // All state and child-created files are private, including SQLite sidecars.
    unsafe {
        libc::umask(0o077);
    }
    if let Err(error) = dispatch_backend::cli::run().await {
        dispatch_backend::observability::event(
            "error",
            "core.failed",
            serde_json::json!({"error":error.code}),
        );
        std::process::exit(1);
    }
}
