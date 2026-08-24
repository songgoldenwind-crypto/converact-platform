use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};

use converact_tenant_auth_runtime::{
    JwksResolvedAddressError, JwksResolvedAddressPolicy, MAX_JWKS_RESOLVED_ADDRESSES,
};

const ADDRESS_SOURCE: &str = include_str!("../src/resolved_addresses.rs");

fn ip(value: &str) -> IpAddr {
    value.parse().expect("valid test address")
}

#[test]
fn public_policy_accepts_only_bounded_globally_routable_results() {
    let addresses = JwksResolvedAddressPolicy::public_internet()
        .validate(
            [ip("8.8.8.8"), ip("2606:4700:4700::1111"), ip("8.8.8.8")],
            443,
        )
        .expect("public addresses are accepted");

    assert_eq!(
        addresses.as_slice(),
        [
            SocketAddr::new(ip("8.8.8.8"), 443),
            SocketAddr::new(ip("2606:4700:4700::1111"), 443),
        ]
    );
    assert_eq!(
        format!("{addresses:?}"),
        "ValidatedJwksResolvedAddresses(count=2)"
    );
}

#[test]
fn public_policy_rejects_every_special_purpose_ipv4_family() {
    for address in [
        "0.0.0.0",
        "10.0.0.1",
        "100.64.0.1",
        "127.0.0.1",
        "169.254.169.254",
        "172.16.0.1",
        "192.0.0.9",
        "192.0.2.1",
        "192.88.99.2",
        "192.168.0.1",
        "198.18.0.1",
        "198.51.100.1",
        "203.0.113.1",
        "224.0.0.1",
        "240.0.0.1",
        "255.255.255.255",
    ] {
        assert_eq!(
            JwksResolvedAddressPolicy::public_internet().validate([ip(address)], 443),
            Err(JwksResolvedAddressError::AddressRejected),
            "{address} must not be a public JWKS destination"
        );
    }
}

#[test]
fn public_policy_rejects_special_ipv6_and_validates_nat64_payloads() {
    for address in [
        "::",
        "::1",
        "::ffff:8.8.8.8",
        "64:ff9b::a9fe:a9fe",
        "64:ff9b:1::1",
        "100::1",
        "2001::1",
        "2001:db8::1",
        "2002::1",
        "3fff::1",
        "5f00::1",
        "fc00::1",
        "fe80::1",
        "ff02::1",
    ] {
        assert_eq!(
            JwksResolvedAddressPolicy::public_internet().validate([ip(address)], 443),
            Err(JwksResolvedAddressError::AddressRejected),
            "{address} must not be a public JWKS destination"
        );
    }

    assert!(
        JwksResolvedAddressPolicy::public_internet()
            .validate([ip("64:ff9b::808:808")], 443)
            .is_ok(),
        "the well-known NAT64 prefix remains usable only for a public embedded IPv4 address"
    );
}

#[test]
fn mixed_dns_answers_fail_as_one_atomic_resolution() {
    assert_eq!(
        JwksResolvedAddressPolicy::public_internet()
            .validate([ip("8.8.8.8"), ip("127.0.0.1")], 443),
        Err(JwksResolvedAddressError::AddressRejected)
    );
}

#[test]
fn explicit_development_policy_accepts_only_loopback() {
    let addresses = JwksResolvedAddressPolicy::loopback_development()
        .validate([ip("127.0.0.2"), IpAddr::V6(Ipv6Addr::LOCALHOST)], 8080)
        .expect("loopback is explicitly accepted");
    assert_eq!(addresses.len(), 2);

    for address in ["8.8.8.8", "10.0.0.1", "fe80::1"] {
        assert_eq!(
            JwksResolvedAddressPolicy::loopback_development().validate([ip(address)], 8080),
            Err(JwksResolvedAddressError::AddressRejected)
        );
    }
}

#[test]
fn empty_unbounded_and_zero_port_resolutions_fail_closed() {
    assert_eq!(
        JwksResolvedAddressPolicy::public_internet().validate([], 443),
        Err(JwksResolvedAddressError::Empty)
    );
    assert_eq!(
        JwksResolvedAddressPolicy::public_internet().validate(
            std::iter::repeat_n(IpAddr::V4(Ipv4Addr::new(8, 8, 8, 8)), 17),
            443
        ),
        Err(JwksResolvedAddressError::TooMany)
    );
    assert_eq!(MAX_JWKS_RESOLVED_ADDRESSES, 16);
    assert_eq!(
        JwksResolvedAddressPolicy::public_internet().validate([ip("8.8.8.8")], 0),
        Err(JwksResolvedAddressError::InvalidPort)
    );
}

#[test]
fn address_errors_are_closed_and_the_policy_has_no_io_authority() {
    assert_eq!(
        JwksResolvedAddressError::AddressRejected.to_string(),
        "platform_rs256_jwks_address_rejected"
    );
    for forbidden in [
        "std::env",
        "SystemTime",
        "Instant",
        "tokio::",
        "reqwest",
        "lookup_host",
        "TcpStream",
        "UdpSocket",
        "std::fs",
        "unsafe",
    ] {
        assert!(
            !ADDRESS_SOURCE.contains(forbidden),
            "resolved address policy must not contain {forbidden}"
        );
    }
}
