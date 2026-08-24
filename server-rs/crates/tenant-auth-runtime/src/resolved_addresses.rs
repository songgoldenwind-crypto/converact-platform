use std::{
    error::Error,
    fmt,
    net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr},
};

/// Maximum raw addresses accepted from one DNS lookup.
pub const MAX_JWKS_RESOLVED_ADDRESSES: usize = 16;

/// Explicit destination scope selected by the runtime composition root.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum JwksResolvedAddressPolicy {
    /// Accept only conservatively classified globally reachable destinations.
    PublicInternet,
    /// Accept only loopback destinations for explicitly enabled local tests.
    LoopbackDevelopment,
}

impl JwksResolvedAddressPolicy {
    /// Constructs the production-default public destination policy.
    #[must_use]
    pub const fn public_internet() -> Self {
        Self::PublicInternet
    }

    /// Constructs an explicit local-development-only destination policy.
    #[must_use]
    pub const fn loopback_development() -> Self {
        Self::LoopbackDevelopment
    }

    /// Validates every raw answer atomically, removes duplicates and binds the
    /// accepted IPs to the endpoint port for one request generation.
    ///
    /// # Errors
    ///
    /// Rejects a zero port, an empty or oversized answer, or the complete
    /// answer set when any individual address is outside the selected scope.
    pub fn validate(
        self,
        addresses: impl IntoIterator<Item = IpAddr>,
        endpoint_port: u16,
    ) -> Result<ValidatedJwksResolvedAddresses, JwksResolvedAddressError> {
        if endpoint_port == 0 {
            return Err(JwksResolvedAddressError::InvalidPort);
        }

        let mut accepted = Vec::with_capacity(2);
        for (index, address) in addresses.into_iter().enumerate() {
            if index == MAX_JWKS_RESOLVED_ADDRESSES {
                return Err(JwksResolvedAddressError::TooMany);
            }
            if !self.accepts(address) {
                return Err(JwksResolvedAddressError::AddressRejected);
            }
            let socket = SocketAddr::new(address, endpoint_port);
            if !accepted.contains(&socket) {
                accepted.push(socket);
            }
        }
        if accepted.is_empty() {
            return Err(JwksResolvedAddressError::Empty);
        }

        Ok(ValidatedJwksResolvedAddresses(accepted.into_boxed_slice()))
    }

    fn accepts(self, address: IpAddr) -> bool {
        match self {
            Self::PublicInternet => globally_reachable(address),
            Self::LoopbackDevelopment => address.is_loopback(),
        }
    }
}

/// Stable value-free reason for refusing a DNS result.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum JwksResolvedAddressError {
    InvalidPort,
    Empty,
    TooMany,
    AddressRejected,
}

impl JwksResolvedAddressError {
    /// Returns the stable diagnostic code without destination data.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::InvalidPort => "platform_rs256_jwks_address_port_invalid",
            Self::Empty => "platform_rs256_jwks_address_empty",
            Self::TooMany => "platform_rs256_jwks_address_too_many",
            Self::AddressRejected => "platform_rs256_jwks_address_rejected",
        }
    }
}

impl fmt::Display for JwksResolvedAddressError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

impl Error for JwksResolvedAddressError {}

/// A bounded, deduplicated, policy-approved resolution pinned to one port.
#[derive(Clone, Eq, PartialEq)]
pub struct ValidatedJwksResolvedAddresses(Box<[SocketAddr]>);

impl ValidatedJwksResolvedAddresses {
    /// Returns the exact addresses approved for the request generation.
    #[must_use]
    pub fn as_slice(&self) -> &[SocketAddr] {
        &self.0
    }

    /// Returns the number of unique approved addresses.
    #[must_use]
    pub const fn len(&self) -> usize {
        self.0.len()
    }

    /// Returns whether no address was accepted. Validated values are never
    /// empty; this method is provided for collection-like API completeness.
    #[must_use]
    pub const fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
}

impl fmt::Debug for ValidatedJwksResolvedAddresses {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            formatter,
            "ValidatedJwksResolvedAddresses(count={})",
            self.0.len()
        )
    }
}

fn globally_reachable(address: IpAddr) -> bool {
    match address {
        IpAddr::V4(address) => globally_reachable_v4(address),
        IpAddr::V6(address) => globally_reachable_v6(address),
    }
}

fn globally_reachable_v4(address: Ipv4Addr) -> bool {
    ![
        (Ipv4Addr::UNSPECIFIED, 8),
        (Ipv4Addr::new(10, 0, 0, 0), 8),
        (Ipv4Addr::new(100, 64, 0, 0), 10),
        (Ipv4Addr::new(127, 0, 0, 0), 8),
        (Ipv4Addr::new(169, 254, 0, 0), 16),
        (Ipv4Addr::new(172, 16, 0, 0), 12),
        (Ipv4Addr::new(192, 0, 0, 0), 24),
        (Ipv4Addr::new(192, 0, 2, 0), 24),
        (Ipv4Addr::new(192, 88, 99, 0), 24),
        (Ipv4Addr::new(192, 168, 0, 0), 16),
        (Ipv4Addr::new(198, 18, 0, 0), 15),
        (Ipv4Addr::new(198, 51, 100, 0), 24),
        (Ipv4Addr::new(203, 0, 113, 0), 24),
        (Ipv4Addr::new(224, 0, 0, 0), 4),
        (Ipv4Addr::new(240, 0, 0, 0), 4),
    ]
    .into_iter()
    .any(|(network, prefix)| ipv4_in(address, network, prefix))
}

fn globally_reachable_v6(address: Ipv6Addr) -> bool {
    let nat64 = Ipv6Addr::new(0x64, 0xff9b, 0, 0, 0, 0, 0, 0);
    if ipv6_in(address, nat64, 96) {
        let octets = address.octets();
        return globally_reachable_v4(Ipv4Addr::new(
            octets[12], octets[13], octets[14], octets[15],
        ));
    }

    let global_unicast = Ipv6Addr::new(0x2000, 0, 0, 0, 0, 0, 0, 0);
    if !ipv6_in(address, global_unicast, 3) {
        return false;
    }

    ![
        (Ipv6Addr::new(0x2001, 0, 0, 0, 0, 0, 0, 0), 23),
        (Ipv6Addr::new(0x2001, 0x0db8, 0, 0, 0, 0, 0, 0), 32),
        (Ipv6Addr::new(0x2002, 0, 0, 0, 0, 0, 0, 0), 16),
        (Ipv6Addr::new(0x3fff, 0, 0, 0, 0, 0, 0, 0), 20),
    ]
    .into_iter()
    .any(|(network, prefix)| ipv6_in(address, network, prefix))
}

fn ipv4_in(address: Ipv4Addr, network: Ipv4Addr, prefix: u32) -> bool {
    let mask = u32::MAX.checked_shl(32 - prefix).unwrap_or(0);
    u32::from(address) & mask == u32::from(network) & mask
}

fn ipv6_in(address: Ipv6Addr, network: Ipv6Addr, prefix: u32) -> bool {
    let mask = u128::MAX.checked_shl(128 - prefix).unwrap_or(0);
    u128::from(address) & mask == u128::from(network) & mask
}
