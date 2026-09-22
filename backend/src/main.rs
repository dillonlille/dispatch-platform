fn main() {
    // Host management runs without application configuration, data locks or Tokio.
    unsafe {
        libc::umask(0o077);
    }
    let args: Vec<_> = std::env::args().skip(1).collect();
    if args.first().is_some_and(|arg| arg == "host") {
        if let Err(error) = dispatch_host::run(&args[1..]) {
            eprintln!("{error}");
            std::process::exit(1);
        }
        return;
    }
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
        .expect("application runtime");
    if let Err(error) = runtime.block_on(dispatch_backend::cli::run()) {
        dispatch_backend::observability::event(
            "error",
            "core.failed",
            serde_json::json!({"error":error.code}),
        );
        std::process::exit(1);
    }
}
