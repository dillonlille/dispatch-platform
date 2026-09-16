use dispatch_backend::core::{
    self, Error, Result,
    config::Config,
    db::Store,
    ensure,
    operations::{self, Lock},
};
use std::{io::Read, path::Path};
#[tokio::main(worker_threads = 2)]
async fn main() {
    // All state and child-created files are private, including SQLite sidecars.
    unsafe {
        libc::umask(0o077);
    }
    if let Err(error) = run().await {
        eprintln!("dispatch: {}", error.code);
        std::process::exit(1);
    }
}
async fn run() -> Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let command = args.first().map(String::as_str).unwrap_or("serve");
    if command == "browseros-worker" {
        ensure(args.len() == 2, "invalid_browser_worker_arguments", 400)?;
        return core::browsers::browseros::worker_main(&args[1]).await;
    }
    if command == "restore" {
        ensure(args.len() == 3, "usage_restore_backup_empty_target", 400)?;
        println!(
            "{}",
            operations::restore(Path::new(&args[1]), Path::new(&args[2]))?
        );
        return Ok(());
    }
    let config = Config::load()?;
    if command == "status" {
        println!("{}", operations::status(&config)?);
        return Ok(());
    }
    let _lock = Lock::acquire(&config.root)?;
    match command {
        "serve" => {
            ensure(
                config.platform().join("accounts.sqlite").is_file(),
                "run_bootstrap_before_starting",
                503,
            )?;
            let state = core::State::new(config.clone())?;
            state.run(|db|ensure(db.platform.one("SELECT id FROM users WHERE platform_owner=1 AND status='active' LIMIT 1",[])?.is_some(),"run_bootstrap_before_starting",503)).await?;
            state
                .run(|db| {
                    db.recover_jobs(true)?;
                    operations::clean_browser_runs(&db.config)
                })
                .await?;
            let listener =
                tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, config.port)).await?;
            let (stop, receiver) = tokio::sync::watch::channel(false);
            let jobs = tokio::spawn(core::supervise(
                core::jobs::start(state.clone(), receiver.clone()),
                stop.clone(),
            ));
            let mail_state = state.clone();
            let mail = tokio::spawn(core::supervise(
                async move {
                    operations::mailer(mail_state, receiver).await;
                    Ok(())
                },
                stop.clone(),
            ));
            println!(
                "Dispatch Rust {} listening at http://127.0.0.1:{}",
                config.environment, config.port
            );
            let sender = stop.clone();
            let mut shutdown_receiver = stop.subscribe();
            let shutdown = async move {
                let mut term =
                    tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
                        .expect("SIGTERM handler");
                tokio::select! {_=tokio::signal::ctrl_c()=>{},_=term.recv()=>{},_=core::cancelled(&mut shutdown_receiver)=>{}};
                sender.send_replace(true);
            };
            let server = axum::serve(
                listener,
                core::http::router(state.clone())
                    .into_make_service_with_connect_info::<std::net::SocketAddr>(),
            )
            .with_graceful_shutdown(shutdown);
            let result = server.await;
            stop.send_replace(true);
            state.browsers.close().await;
            let jobs = jobs.await.map_err(|_| Error::new("scheduler_failed", 500));
            let mail = mail.await.map_err(|_| Error::new("mailer_failed", 500));
            jobs??;
            mail??;
            result?;
        }
        "bootstrap" => {
            ensure(args.len() == 4, "usage_bootstrap_email_first_last", 400)?;
            ensure(
                unsafe { libc::isatty(libc::STDIN_FILENO) } == 0,
                "password_required_on_stdin",
                400,
            )?;
            let mut password = String::new();
            std::io::stdin().take(1024).read_to_string(&mut password)?;
            let db = Store::initialize(config)?;
            println!(
                "{}",
                operations::bootstrap(
                    &db,
                    &args[1],
                    &args[2],
                    &args[3],
                    password.trim_end_matches(['\r', '\n'])
                )?
            );
        }
        "seed" => operations::seed(&Store::initialize(config)?)?,
        "backup" => {
            ensure(args.len() == 2, "usage_backup_destination", 400)?;
            println!("{}", operations::backup(&config, Path::new(&args[1]))?);
        }
        _ => {
            return Err(Error::new(
                "usage_serve_bootstrap_seed_status_backup_restore",
                400,
            ));
        }
    }
    Ok(())
}
