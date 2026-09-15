use axum::{
    Json, Router,
    extract::{DefaultBodyLimit, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::{get, post},
};
use dispatch_backend::{EmployeeRequest, Error};
use serde_json::json;
use std::{
    io::{Read, Write},
    os::unix::fs::{MetadataExt, PermissionsExt},
    path::PathBuf,
    sync::Arc,
};
use tokio::{net::UnixListener, sync::Semaphore};

#[derive(Clone)]
struct Backend {
    root: Arc<PathBuf>,
    capacity: Arc<Semaphore>,
}

async fn employee(State(state): State<Backend>, Json(request): Json<EmployeeRequest>) -> Response {
    let Ok(permit) = state.capacity.clone().try_acquire_owned() else {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({"error": "backend_busy"})),
        )
            .into_response();
    };
    // SQLite work must not block Tokio's HTTP/event-loop threads.
    let result = tokio::task::spawn_blocking(move || {
        let _permit = permit;
        dispatch_backend::employee(&state.root, request)
    })
    .await;
    match result {
        Ok(Ok(detail)) => Json(detail).into_response(),
        Ok(Err(Error::NotFound)) => (
            StatusCode::NOT_FOUND,
            Json(json!({"error": "employee_not_found"})),
        )
            .into_response(),
        Ok(Err(Error::InvalidInput)) => (
            StatusCode::BAD_REQUEST,
            Json(json!({"error": "invalid_input"})),
        )
            .into_response(),
        _ => {
            // Never log employee data, credentials, SQL, or private filesystem paths.
            eprintln!("employee_read_failed");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({"error": "operation_failed"})),
            )
                .into_response()
        }
    }
}

#[tokio::main(worker_threads = 2)]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<_> = std::env::args_os().skip(1).collect();
    if args.len() != 2 {
        return Err("expected socket and DSP root".into());
    }
    let socket = PathBuf::from(&args[0]);
    let root = PathBuf::from(&args[1]);
    if !root.is_absolute() || root.canonicalize()? != root {
        return Err("unsafe DSP root".into());
    }
    let parent = socket.parent().ok_or("missing socket directory")?;
    let permissions = std::fs::symlink_metadata(parent)?;
    if !socket.is_absolute()
        || parent.canonicalize()? != parent
        || !permissions.is_dir()
        || permissions.mode() & 0o077 != 0
        || permissions.uid() != std::fs::metadata(&root)?.uid()
    {
        return Err("private socket directory required".into());
    }
    let listener = UnixListener::bind(&socket)?;
    std::fs::set_permissions(&socket, std::fs::Permissions::from_mode(0o600))?;
    let (closed, parent_closed) = tokio::sync::oneshot::channel();
    // A dedicated thread detects the gateway disappearing, including SIGKILL.
    // It does not keep the process alive after the Tokio runtime exits.
    std::thread::spawn(move || {
        let _ = std::io::stdin().read(&mut [0u8; 1]);
        let _ = closed.send(());
    });
    let app = Router::new()
        .route(
            "/health",
            get(|| async { Json(json!({"status": "ready", "protocol": 1})) }),
        )
        .route("/employee", post(employee))
        .layer(DefaultBodyLimit::max(1024))
        .with_state(Backend {
            root: Arc::new(root),
            capacity: Arc::new(Semaphore::new(8)),
        });
    let mut terminate = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())?;
    println!("ready");
    std::io::stdout().flush()?;
    axum::serve(listener, app)
        .with_graceful_shutdown(async move {
            tokio::select! {
                _ = parent_closed => {},
                _ = terminate.recv() => {},
                _ = tokio::signal::ctrl_c() => {},
            }
        })
        .await?;
    let _ = std::fs::remove_file(socket);
    Ok(())
}
