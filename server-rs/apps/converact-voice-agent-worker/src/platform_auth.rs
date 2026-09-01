use std::{
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};

use axum::{
    body::Body,
    extract::{Request, State},
    http::{Response, StatusCode, header},
    middleware::Next,
};
use converact_tenant_auth::{
    AuthenticatedPlatformIdentity, Hs256PlatformTokenVerifier, PlatformIdentityRole,
    Rs256PlatformTokenVerifier,
};

use crate::{AuthenticatedTenant, CampaignAdminAccess, http::error_response};

/// Closed authentication boundary accepted by the process-facing HTTP router.
pub trait PlatformTokenAuthenticator: Send + Sync + 'static {
    fn authenticate(
        &self,
        token: &str,
        wall_now_epoch_ms: i64,
    ) -> Option<AuthenticatedPlatformIdentity>;
}

impl PlatformTokenAuthenticator for Hs256PlatformTokenVerifier {
    fn authenticate(
        &self,
        token: &str,
        wall_now_epoch_ms: i64,
    ) -> Option<AuthenticatedPlatformIdentity> {
        self.verify(token, wall_now_epoch_ms).ok()
    }
}

impl PlatformTokenAuthenticator for Rs256PlatformTokenVerifier {
    fn authenticate(
        &self,
        token: &str,
        wall_now_epoch_ms: i64,
    ) -> Option<AuthenticatedPlatformIdentity> {
        self.verify(token, wall_now_epoch_ms).ok()
    }
}

/// Wall-clock boundary kept separate from token verification for deterministic tests.
pub trait WallClock: Send + Sync + 'static {
    fn now_epoch_ms(&self) -> Option<i64>;
}

/// Production wall clock. Pre-epoch or overflowing observations fail authentication closed.
#[derive(Clone, Copy, Debug, Default)]
pub struct SystemWallClock;

impl WallClock for SystemWallClock {
    fn now_epoch_ms(&self) -> Option<i64> {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .ok()
            .and_then(|duration| i64::try_from(duration.as_millis()).ok())
    }
}

/// Deterministic wall clock for controlled composition and tests.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct FixedWallClock(i64);

impl FixedWallClock {
    #[must_use]
    pub const fn new(now_epoch_ms: i64) -> Self {
        Self(now_epoch_ms)
    }
}

impl WallClock for FixedWallClock {
    fn now_epoch_ms(&self) -> Option<i64> {
        Some(self.0)
    }
}

pub(crate) struct PlatformAuthState<A, C> {
    authenticator: Arc<A>,
    clock: C,
}

impl<A, C> PlatformAuthState<A, C> {
    pub(crate) const fn new(authenticator: Arc<A>, clock: C) -> Self {
        Self {
            authenticator,
            clock,
        }
    }
}

impl<A, C: Clone> Clone for PlatformAuthState<A, C> {
    fn clone(&self) -> Self {
        Self {
            authenticator: Arc::clone(&self.authenticator),
            clock: self.clock.clone(),
        }
    }
}

pub(crate) async fn authenticate_platform_token<A, C>(
    State(state): State<PlatformAuthState<A, C>>,
    mut request: Request,
    next: Next,
) -> Response<Body>
where
    A: PlatformTokenAuthenticator,
    C: WallClock,
{
    let Some(token) = bearer_token(request.headers()) else {
        return error_response(StatusCode::UNAUTHORIZED, "authentication_required");
    };
    let Some(now) = state.clock.now_epoch_ms() else {
        return error_response(
            StatusCode::SERVICE_UNAVAILABLE,
            "authentication_unavailable",
        );
    };
    let Some(identity) = state.authenticator.authenticate(token, now) else {
        return error_response(StatusCode::UNAUTHORIZED, "authentication_rejected");
    };
    if request.method() != axum::http::Method::GET
        && request.method() != axum::http::Method::HEAD
        && identity.role() == PlatformIdentityRole::Viewer
    {
        return error_response(StatusCode::FORBIDDEN, "authorization_denied");
    }
    let tenant = AuthenticatedTenant::from_platform_identity(&identity);
    let campaign_admin_access = CampaignAdminAccess::from_platform_identity(&identity);
    request.extensions_mut().insert(tenant);
    request.extensions_mut().insert(campaign_admin_access);
    next.run(request).await
}

fn bearer_token(headers: &axum::http::HeaderMap) -> Option<&str> {
    let mut values = headers.get_all(header::AUTHORIZATION).iter();
    let value = values.next()?.to_str().ok()?;
    if values.next().is_some() {
        return None;
    }
    let token = value.strip_prefix("Bearer ")?;
    if token.is_empty() || token.bytes().any(|byte| byte.is_ascii_whitespace()) {
        return None;
    }
    Some(token)
}
