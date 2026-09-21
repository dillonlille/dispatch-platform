fn main() {
    unsafe {
        libc::umask(0o077);
    }
    let args: Vec<_> = std::env::args().skip(1).collect();
    let args = if args.first().is_some_and(|a| a == "host") {
        &args[1..]
    } else {
        &args[..]
    };
    if let Err(error) = dispatch_host::run(args) {
        eprintln!("{error}");
        std::process::exit(1);
    }
}
