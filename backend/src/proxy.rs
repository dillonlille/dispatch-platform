//! Only the explicitly configured, local Cloudflare Tunnel may supply client IPs.
use super::{Error, Result};
use axum::http::HeaderMap;
use std::net::IpAddr;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TrustedProxy {
    None,
    Cloudflare,
}
impl TrustedProxy {
    pub fn parse(value: &str) -> Result<Self> {
        match value {
            "none" => Ok(Self::None),
            "cloudflare" => Ok(Self::Cloudflare),
            _ => Err(Error::new("invalid_trusted_proxy", 400)),
        }
    }
    pub fn client_ip(self, peer: IpAddr, headers: &HeaderMap) -> Result<String> {
        let peer = peer.to_canonical();
        if self != Self::Cloudflare || !peer.is_loopback() {
            return Ok(peer.to_string());
        }
        let mut values = headers.get_all("cf-connecting-ip").iter();
        // Direct local probes have no proxy header and keep their own allowance.
        let Some(value) = values.next() else {
            return Ok(peer.to_string());
        };
        let address = value.to_str().ok().and_then(|v| v.parse::<IpAddr>().ok());
        match (address, values.next()) {
            (Some(address), None) => Ok(address.to_canonical().to_string()),
            _ => Err(Error::new("invalid_client_address", 400)),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn trust_is_explicit_and_headers_are_single_addresses() {
        let mut headers = HeaderMap::new();
        headers.insert("cf-connecting-ip", "203.0.113.5".parse().unwrap());
        for (mode, peer, expected) in [
            (TrustedProxy::None, "127.0.0.1", "127.0.0.1"),
            (TrustedProxy::Cloudflare, "192.0.2.1", "192.0.2.1"),
            (TrustedProxy::Cloudflare, "127.0.0.1", "203.0.113.5"),
        ] {
            assert_eq!(
                mode.client_ip(peer.parse().unwrap(), &headers).unwrap(),
                expected
            );
        }
        let peer = "127.0.0.1".parse().unwrap();
        for value in ["", "unknown", "203.0.113.5, 203.0.113.6", "203.0.113.5:80"] {
            headers.insert("cf-connecting-ip", value.parse().unwrap());
            assert!(TrustedProxy::Cloudflare.client_ip(peer, &headers).is_err());
        }
        headers.insert("cf-connecting-ip", "::ffff:203.0.113.5".parse().unwrap());
        assert_eq!(
            TrustedProxy::Cloudflare.client_ip(peer, &headers).unwrap(),
            "203.0.113.5"
        );
        headers.append("cf-connecting-ip", "203.0.113.6".parse().unwrap());
        assert!(TrustedProxy::Cloudflare.client_ip(peer, &headers).is_err());
    }
}
