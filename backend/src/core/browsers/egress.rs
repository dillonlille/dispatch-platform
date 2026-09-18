use super::browseros::NetworkPolicy;
use crate::core::{Error, Result, ensure};
use std::{net::IpAddr, os::fd::AsRawFd, os::unix::fs::PermissionsExt, path::Path, sync::Arc};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt, BufReader},
    net::{TcpStream, UnixListener, UnixStream},
    sync::Semaphore,
    task::JoinHandle,
};
pub fn allowed_host(host: &str) -> bool {
    host.bytes()
        .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'.' || b == b'-')
        && (host == "paycomonline.net"
            || host.ends_with(".paycomonline.net")
            || [
                "www.paycom.com",
                "fonts.googleapis.com",
                "fonts.gstatic.com",
                "www.google.com",
                "www.gstatic.com",
                "www.recaptcha.net",
            ]
            .contains(&host))
}
pub fn allowed_cortex_host(host: &str) -> bool {
    [
        "logistics.amazon.com",
        "amazon.com",
        "www.amazon.com",
        "unagi.amazon.com",
        "unagi-na.amazon.com",
    ]
    .contains(&host)
        || ["media-amazon.com", "ssl-images-amazon.com"]
            .iter()
            .any(|root| host == *root || host.ends_with(&format!(".{root}")))
}
pub fn public_address(address: IpAddr) -> bool {
    let IpAddr::V4(ip) = address else {
        return false;
    };
    let [a, b, _, _] = ip.octets();
    !(a == 0
        || a == 10
        || a == 127
        || a >= 224
        || (a == 169 && b == 254)
        || (a == 172 && (16..=31).contains(&b))
        || (a == 192 && b == 168)
        || (a == 100 && (64..=127).contains(&b))
        || (a == 198 && (b == 18 || b == 19)))
}
pub struct Egress {
    task: JoinHandle<()>,
    path: std::path::PathBuf,
    inode: u64,
}
impl Drop for Egress {
    fn drop(&mut self) {
        self.task.abort();
        use std::os::unix::fs::{FileTypeExt, MetadataExt};
        if std::fs::symlink_metadata(&self.path)
            .is_ok_and(|info| info.ino() == self.inode && info.file_type().is_socket())
        {
            let _ = std::fs::remove_file(&self.path);
        }
    }
}
impl Egress {
    pub fn start(run: &Path, fixture: Option<(String, u16)>) -> Result<Self> {
        let policy = match fixture {
            Some((host, port)) => {
                ensure(host == "fixture.dispatch.invalid", "egress_denied", 403)?;
                NetworkPolicy::Fixture(
                    std::num::NonZeroU16::new(port)
                        .ok_or_else(|| Error::new("egress_denied", 403))?,
                )
            }
            None => NetworkPolicy::Paycom,
        };
        Self::start_with_policy(run, policy)
    }
    pub fn start_with_policy(run: &Path, policy: NetworkPolicy) -> Result<Self> {
        crate::core::db::private_dir(run)?;
        let directory = std::fs::File::open(run)?;
        let listener = UnixListener::bind(format!(
            "/proc/self/fd/{}/egress.sock",
            directory.as_raw_fd()
        ))?;
        std::fs::set_permissions(
            run.join("egress.sock"),
            std::fs::Permissions::from_mode(0o600),
        )?;
        use std::os::unix::fs::MetadataExt;
        let path = run.join("egress.sock");
        let inode = std::fs::symlink_metadata(&path)?.ino();
        let task = tokio::spawn(async move {
            let _directory = directory;
            let slots = Arc::new(Semaphore::new(32));
            let mut tasks = tokio::task::JoinSet::new();
            loop {
                tokio::select! {
                    accepted=listener.accept()=>match accepted {
                        Ok((stream,_))=> {if let Ok(permit)=slots.clone().try_acquire_owned(){tasks.spawn(async move {let _permit=permit;let _=tokio::time::timeout(std::time::Duration::from_secs(120),proxy(stream,policy)).await;});}},
                        Err(_)=>break,
                    },
                    _=tasks.join_next(),if !tasks.is_empty()=>{},
                }
            }
        });
        Ok(Self { task, path, inode })
    }
}
async fn proxy(client: UnixStream, policy: NetworkPolicy) -> Result<()> {
    // Buffer headers instead of making one socket read per byte. Keep this
    // reader for the tunnel so prefetched request-body/TLS bytes are preserved.
    let mut client = BufReader::new(client);
    let mut header = Vec::new();
    while !header.ends_with(b"\r\n\r\n") {
        ensure(header.len() < 16384, "egress_denied", 403)?;
        match client.read_u8().await {
            Ok(byte) => header.push(byte),
            Err(error) if error.kind() == std::io::ErrorKind::UnexpectedEof => return Ok(()),
            Err(_) => return Err(Error::new("egress_closed", 503)),
        }
    }
    let text = std::str::from_utf8(&header).map_err(|_| Error::new("egress_denied", 403))?;
    let first = text.lines().next().unwrap_or("");
    let parts: Vec<_> = first.split(' ').collect();
    ensure(parts.len() == 3, "egress_denied", 403)?;
    let connect = parts[0] == "CONNECT";
    let target = if connect {
        format!("https://{}", parts[1])
    } else {
        parts[1].into()
    };
    let url = url::Url::parse(&target).map_err(|_| Error::new("egress_denied", 403))?;
    ensure(
        url.username().is_empty() && url.password().is_none() && url.fragment().is_none(),
        "egress_denied",
        403,
    )?;
    let host = url
        .host_str()
        .ok_or_else(|| Error::new("egress_denied", 403))?;
    let port = url
        .port_or_known_default()
        .ok_or_else(|| Error::new("egress_denied", 403))?;
    let address = if let NetworkPolicy::Fixture(fixture_port) = policy {
        ensure(
            host == "fixture.dispatch.invalid" && fixture_port.get() == port,
            "egress_denied",
            403,
        )?;
        std::net::SocketAddr::from(([127, 0, 0, 1], port))
    } else {
        ensure(
            connect
                && port == 443
                && match policy {
                    NetworkPolicy::Paycom => allowed_host(host),
                    NetworkPolicy::Cortex => allowed_cortex_host(host),
                    NetworkPolicy::Fixture(_) => false,
                },
            "egress_denied",
            403,
        )?;
        tokio::net::lookup_host((host, port))
            .await?
            .find(|a| a.is_ipv4())
            .filter(|a| public_address(a.ip()))
            .ok_or_else(|| Error::new("egress_denied", 403))?
    };
    let mut upstream = TcpStream::connect(address).await?;
    if connect {
        client
            .write_all(b"HTTP/1.1 200 Connection Established\r\n\r\n")
            .await?;
    } else {
        ensure(url.scheme() == "http", "egress_denied", 403)?;
        let path = format!(
            "{}{}",
            url.path(),
            url.query().map(|q| format!("?{q}")).unwrap_or_default()
        );
        let mut out = format!("{} {path} HTTP/1.1\r\n", parts[0]);
        for line in text.lines().skip(1).filter(|l| {
            !l.is_empty()
                && !l.to_lowercase().starts_with("connection:")
                && !l.to_lowercase().starts_with("proxy-connection:")
        }) {
            out.push_str(line);
            out.push_str("\r\n");
        }
        out.push_str("Connection: close\r\n\r\n");
        upstream.write_all(out.as_bytes()).await?;
    }
    tokio::io::copy_bidirectional(&mut client, &mut upstream).await?;
    Ok(())
}
