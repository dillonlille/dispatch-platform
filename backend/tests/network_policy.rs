use dispatch_backend::browsers::egress;

#[test]
fn egress_rejects_private_and_lookalike_destinations() {
    for address in [
        "127.0.0.1",
        "10.0.0.1",
        "172.16.0.1",
        "192.168.1.1",
        "169.254.169.254",
        "100.64.0.1",
        "198.18.0.1",
        "::1",
        "::ffff:8.8.8.8",
    ] {
        assert!(
            !egress::public_address(address.parse().unwrap()),
            "{address}"
        );
    }
    assert!(egress::public_address("8.8.8.8".parse().unwrap()));
    assert!(egress::allowed_host("time-and-attendance.paycomonline.net"));
    for host in [
        "evilpaycomonline.net",
        "paycomonline.net.evil.test",
        "localhost",
        "127.0.0.1",
    ] {
        assert!(!egress::allowed_host(host));
    }
}

#[test]
fn cortex_network_policy_keeps_provider_hosts_separate() {
    use dispatch_backend::browsers::egress;
    for host in [
        "logistics.amazon.com",
        "www.amazon.com",
        "m.media-amazon.com",
        "images-na.ssl-images-amazon.com",
    ] {
        assert!(egress::allowed_cortex_host(host));
        assert!(!egress::allowed_host(host));
    }
    for host in [
        "www.paycomonline.net",
        "amazon.com.evil.test",
        "evilamazon.com",
        "evilmedia-amazon.com",
        "127.0.0.1",
        "metadata.google.internal",
    ] {
        assert!(!egress::allowed_cortex_host(host));
    }
}
