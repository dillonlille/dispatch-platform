use crate::core::{Error, Result, ensure};
use serde_json::{Value, json};
use std::{collections::VecDeque, os::unix::net::UnixStream, time::Duration};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
pub(super) const MAX_FRAME: u64 = 8 * 1024 * 1024;
const TIMEOUT: Duration = Duration::from_secs(15);
fn require(ok: bool, code: &str) -> Result<()> {
    ensure(ok, code, 503)
}

/// Serialized, bounded CDP transport. The descriptor is private to one browser.
/// Only bounded Fetch request events are retained; commands never overlap.
pub(super) struct Cdp {
    socket: BufReader<tokio::net::UnixStream>,
    next: u64,
    partial: Vec<u8>,
    events: VecDeque<Value>,
}
impl Cdp {
    pub(super) fn new(socket: UnixStream) -> Result<Self> {
        socket.set_nonblocking(true)?;
        Ok(Self {
            socket: BufReader::new(tokio::net::UnixStream::from_std(socket)?),
            next: 0,
            partial: Vec::new(),
            events: VecDeque::new(),
        })
    }
    // read_until appends to persistent storage, so a poll timeout cannot lose a
    // partial event frame. Only the exact Fetch subscription is retained.
    async fn read(&mut self) -> Result<Value> {
        let remaining = MAX_FRAME.saturating_sub(self.partial.len() as u64);
        let count = (&mut self.socket)
            .take(remaining)
            .read_until(0, &mut self.partial)
            .await?;
        require(count > 0, "browser_lost")?;
        require(self.partial.last() == Some(&0), "browser_protocol_failed")?;
        let bytes = std::mem::take(&mut self.partial);
        Ok(serde_json::from_slice(&bytes[..bytes.len() - 1])?)
    }
    fn retain(&mut self, value: Value) -> Result<()> {
        require(
            self.events.len() < 16 && serde_json::to_vec(&value)?.len() <= 256 * 1024,
            "browser_event_overflow",
        )?;
        self.events.push_back(value);
        Ok(())
    }
    pub(super) async fn event(&mut self, session: &str) -> Result<Value> {
        let result = tokio::time::timeout(Duration::from_millis(250), async {
            loop {
                if let Some(index) = self.events.iter().position(|v| v["sessionId"] == session) {
                    return Ok(self.events.remove(index).unwrap()["params"].clone());
                }
                let value = self.read().await?;
                if value["method"] == "Fetch.requestPaused" {
                    self.retain(value)?;
                }
            }
        })
        .await;
        result.unwrap_or(Ok(Value::Null))
    }
    pub(super) async fn command(
        &mut self,
        method: &str,
        params: Value,
        session: Option<&str>,
    ) -> Result<Value> {
        self.next += 1;
        let id = self.next;
        let mut message = json!({"id":id,"method":method,"params":params});
        if let Some(session) = session {
            message["sessionId"] = json!(session);
        }
        let mut bytes = serde_json::to_vec(&message)?;
        require(
            bytes.len() < MAX_FRAME as usize,
            "browser_command_too_large",
        )?;
        bytes.push(0);
        tokio::time::timeout(TIMEOUT, async {
            self.socket.get_mut().write_all(&bytes).await?;
            loop {
                let value = self.read().await?;
                if value["method"] == "Fetch.requestPaused" {
                    self.retain(value)?;
                    continue;
                }
                if value["id"] != id {
                    continue;
                }
                if ["Runtime.evaluate", "Page.createIsolatedWorld"].contains(&method)
                    && value["error"]["code"] == -32000
                    && value["error"]["message"].as_str().is_some_and(|s| {
                        [
                            "Execution context was destroyed",
                            "Cannot find context",
                            "No frame for given id",
                        ]
                        .iter()
                        .any(|message| s.contains(message))
                    })
                {
                    return Ok(json!({"navigationPending":true}));
                }
                require(value.get("error").is_none(), "browser_command_failed")?;
                return Ok(value["result"].clone());
            }
        })
        .await
        .map_err(|_| Error::new("browser_command_timeout", 504))?
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn event_poll_preserves_a_fragment_across_timeout() -> Result<()> {
        let (client, server) = UnixStream::pair()?;
        server.set_nonblocking(true)?;
        let mut server = tokio::net::UnixStream::from_std(server)?;
        server
            .write_all(b"{\"method\":\"Fetch.requestPaused\",")
            .await?;
        let mut cdp = Cdp::new(client)?;
        assert_eq!(cdp.event("page-1").await?, Value::Null);
        server
            .write_all(b"\"sessionId\":\"page-1\",\"params\":{\"requestId\":\"roster\"}}\0")
            .await?;
        assert_eq!(cdp.event("page-1").await?["requestId"], "roster");
        Ok(())
    }
    #[tokio::test]
    async fn fetch_capture_is_bounded_and_scoped_to_its_page() -> Result<()> {
        let (client, _server) = UnixStream::pair()?;
        let mut cdp = Cdp::new(client)?;
        cdp.retain(json!({"sessionId":"other","params":{"requestId":"other"}}))?;
        cdp.retain(json!({"sessionId":"page-1","params":{"requestId":"roster"}}))?;
        assert_eq!(cdp.event("page-1").await?["requestId"], "roster");
        for _ in 1..16 {
            cdp.retain(json!({"sessionId":"other"}))?;
        }
        assert!(cdp.retain(json!({"sessionId":"other"})).is_err());
        Ok(())
    }
    #[tokio::test]
    async fn transport_handles_fragmented_events_and_response() -> Result<()> {
        let (client, server) = UnixStream::pair()?;
        server.set_nonblocking(true)?;
        let mut server = BufReader::new(tokio::net::UnixStream::from_std(server)?);
        let task = tokio::spawn(async move {
            let mut request = Vec::new();
            server.read_until(0, &mut request).await?;
            let value: Value = serde_json::from_slice(&request[..request.len() - 1])?;
            require(value["sessionId"] == "page-1", "Session not forwarded")?;
            server
                .get_mut()
                .write_all(b"{\"method\":\"Page.loadEventFired\"}\0{\"id\":1,")
                .await?;
            server
                .get_mut()
                .write_all(b"\"result\":{\"ok\":true}}\0")
                .await?;
            Ok::<_, Error>(())
        });
        let mut cdp = Cdp::new(client)?;
        assert_eq!(
            cdp.command("Page.enable", json!({}), Some("page-1"))
                .await?,
            json!({"ok":true})
        );
        task.await.unwrap()?;
        Ok(())
    }
    #[tokio::test]
    async fn transport_rejects_eof_and_oversized_frames() -> Result<()> {
        for bytes in [Vec::new(), vec![b' '; MAX_FRAME as usize]] {
            let (client, server) = UnixStream::pair()?;
            server.set_nonblocking(true)?;
            let mut server = BufReader::new(tokio::net::UnixStream::from_std(server)?);
            let task = tokio::spawn(async move {
                let mut request = Vec::new();
                let _ = server.read_until(0, &mut request).await;
                let _ = server.get_mut().write_all(&bytes).await;
            });
            assert!(
                Cdp::new(client)?
                    .command("Browser.getVersion", json!({}), None)
                    .await
                    .is_err()
            );
            task.await.unwrap();
        }
        Ok(())
    }
}
