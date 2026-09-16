use dispatch_backend::core::browsers::egress::Egress;
use std::{
    os::{fd::AsRawFd, unix::fs::PermissionsExt},
    sync::Arc,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, UnixStream},
};
#[tokio::test]
async fn long_socket_paths_proxy_concurrent_fixture_requests_and_close_cleanly() {
    let root = tempfile::tempdir().unwrap();
    std::fs::set_permissions(root.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
    let directory = root.path().join("long-private-platform-path-".repeat(5));
    dispatch_backend::core::db::private_dir(&directory).unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let server = tokio::spawn(async move {
        let mut tasks = tokio::task::JoinSet::new();
        for _ in 0..20 {
            let (mut socket, _) = listener.accept().await.unwrap();
            tasks.spawn(async move {
                let mut buf = [0; 4096];
                let count = socket.read(&mut buf).await.unwrap();
                assert!(
                    std::str::from_utf8(&buf[..count])
                        .unwrap()
                        .starts_with("GET /fixture HTTP/1.1")
                );
                socket
                    .write_all(
                        b"HTTP/1.1 200 OK\r\nContent-Length: 7\r\nConnection: close\r\n\r\nfixture",
                    )
                    .await
                    .unwrap();
            });
        }
        while let Some(result) = tasks.join_next().await {
            result.unwrap();
        }
    });
    let proxy = Egress::start(&directory, Some(("fixture.dispatch.invalid".into(), port))).unwrap();
    let handle = Arc::new(std::fs::File::open(&directory).unwrap());
    let mut clients = tokio::task::JoinSet::new();
    for _ in 0..20 {
        let handle = handle.clone();
        clients.spawn(async move{let mut client=UnixStream::connect(format!("/proc/self/fd/{}/egress.sock",handle.as_raw_fd())).await.unwrap();client.write_all(format!("GET http://fixture.dispatch.invalid:{port}/fixture HTTP/1.1\r\nHost: fixture.dispatch.invalid:{port}\r\n\r\n").as_bytes()).await.unwrap();let mut response=String::new();client.read_to_string(&mut response).await.unwrap();assert!(response.ends_with("fixture"));});
    }
    while let Some(result) = clients.join_next().await {
        result.unwrap();
    }
    server.await.unwrap();
    drop(proxy);
    tokio::task::yield_now().await;
    assert!(!directory.join("egress.sock").exists());
}
#[tokio::test]
async fn denied_connections_and_failed_start_never_replace_existing_files() {
    let root = tempfile::tempdir().unwrap();
    std::fs::set_permissions(root.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
    let proxy = Egress::start(root.path(), None).unwrap();
    let mut socket = UnixStream::connect(root.path().join("egress.sock"))
        .await
        .unwrap();
    socket
        .write_all(b"CONNECT 127.0.0.1:80 HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n")
        .await
        .unwrap();
    let mut bytes = Vec::new();
    let _ = socket.read_to_end(&mut bytes).await;
    assert!(bytes.is_empty());
    drop(proxy);
    std::fs::write(root.path().join("egress.sock"), "preserve").unwrap();
    assert!(Egress::start(root.path(), None).is_err());
    assert_eq!(
        std::fs::read_to_string(root.path().join("egress.sock")).unwrap(),
        "preserve"
    );
}

#[tokio::test]
async fn buffered_connect_preserves_prefetched_tunnel_bytes() {
    let root = tempfile::tempdir().unwrap();
    std::fs::set_permissions(root.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let server = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut bytes = [0; 11];
        socket.read_exact(&mut bytes).await.unwrap();
        assert_eq!(&bytes, b"clienthello");
        socket.write_all(b"serverhello").await.unwrap();
    });
    let _proxy =
        Egress::start(root.path(), Some(("fixture.dispatch.invalid".into(), port))).unwrap();
    let mut client = UnixStream::connect(root.path().join("egress.sock"))
        .await
        .unwrap();
    client.write_all(format!("CONNECT fixture.dispatch.invalid:{port} HTTP/1.1\r\nHost: fixture.dispatch.invalid:{port}\r\n\r\nclienthello").as_bytes()).await.unwrap();
    let mut response = String::new();
    tokio::time::timeout(
        std::time::Duration::from_secs(5),
        client.read_to_string(&mut response),
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(
        response,
        "HTTP/1.1 200 Connection Established\r\n\r\nserverhello"
    );
    server.await.unwrap();
}
