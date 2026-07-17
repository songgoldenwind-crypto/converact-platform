use std::error::Error as StdError;
use std::fmt::{Display, Formatter};
use std::sync::RwLock;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Operation {
    Open,
    Mutate,
    Close,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Request {
    pub reservation_id: String,
    pub interaction_id: String,
    pub owner_epoch: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AuthorizationRequest {
    pub request: Request,
    pub operation: Operation,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Authorization {
    pub allowed: bool,
    pub component: String,
    pub node_id: String,
    pub cell_lease_epoch: u64,
    pub owner_epoch: String,
    pub state_sequence: u64,
    pub lease_expires_unix_ms: u64,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Snapshot {
    pub reservation_id: String,
    pub interaction_id: String,
    pub component: String,
    pub node_id: String,
    pub cell_lease_epoch: u64,
    pub owner_epoch: String,
    pub state_sequence: u64,
    pub lease_expires_unix_ms: u64,
    pub closed: bool,
}

pub trait Authorizer: Send + Sync {
    fn authorize(
        &self,
        request: AuthorizationRequest,
    ) -> Result<Authorization, Box<dyn StdError + Send + Sync>>;
}

pub struct Guard<A: Authorizer> {
    authorizer: A,
    state: RwLock<Option<CachedState>>,
}

#[derive(Clone)]
struct CachedState {
    request: Request,
    component: String,
    node_id: String,
    cell_lease_epoch: u64,
    state_sequence: u64,
    lease_expires_unix_ms: u64,
    closed: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum GuardError {
    AlreadyOpen,
    NotOpen,
    Closed,
    StaleOwnerEpoch,
    OwnerEpochAhead,
    LeaseExpired,
    AuthorizationMismatch,
    StateSequenceRegression,
    InvalidRequest,
    StatePoisoned,
    Authorizer(String),
}

impl Display for GuardError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{self:?}")
    }
}

impl StdError for GuardError {}

impl<A: Authorizer> Guard<A> {
    pub fn new(authorizer: A) -> Self {
        Self {
            authorizer,
            state: RwLock::new(None),
        }
    }

    pub fn open(&self, request: Request, now_unix_ms: u64) -> Result<(), GuardError> {
        validate_request(&request)?;
        if self
            .state
            .read()
            .map_err(|_| GuardError::StatePoisoned)?
            .is_some()
        {
            return Err(GuardError::AlreadyOpen);
        }
        let authorization = self
            .authorizer
            .authorize(AuthorizationRequest {
                request: request.clone(),
                operation: Operation::Open,
            })
            .map_err(authorizer_error)?;
        self.open_authorized(request, authorization, now_unix_ms)
    }

    pub fn open_authorized(
        &self,
        request: Request,
        authorization: Authorization,
        now_unix_ms: u64,
    ) -> Result<(), GuardError> {
        validate_request(&request)?;
        if self
            .state
            .read()
            .map_err(|_| GuardError::StatePoisoned)?
            .is_some()
        {
            return Err(GuardError::AlreadyOpen);
        }
        let next = state_from_authorization(request, authorization, now_unix_ms, true)?;
        let mut state = self.state.write().map_err(|_| GuardError::StatePoisoned)?;
        if state.is_some() {
            return Err(GuardError::AlreadyOpen);
        }
        *state = Some(next);
        Ok(())
    }

    pub fn refresh(&self, now_unix_ms: u64) -> Result<(), GuardError> {
        let current = self.current()?;
        if current.closed {
            return Err(GuardError::Closed);
        }
        let authorization = self
            .authorizer
            .authorize(AuthorizationRequest {
                request: current.request.clone(),
                operation: Operation::Mutate,
            })
            .map_err(authorizer_error)?;
        self.refresh_authorized(authorization, now_unix_ms)
    }

    pub fn refresh_authorized(
        &self,
        authorization: Authorization,
        now_unix_ms: u64,
    ) -> Result<(), GuardError> {
        let current = self.current()?;
        if current.closed {
            return Err(GuardError::Closed);
        }
        let next =
            state_from_authorization(current.request.clone(), authorization, now_unix_ms, true)?;
        if next.state_sequence < current.state_sequence {
            return Err(GuardError::StateSequenceRegression);
        }
        if next.component != current.component
            || next.node_id != current.node_id
            || next.cell_lease_epoch != current.cell_lease_epoch
        {
            return Err(GuardError::AuthorizationMismatch);
        }
        *self.state.write().map_err(|_| GuardError::StatePoisoned)? = Some(next);
        Ok(())
    }

    pub fn assert_mutation(&self, owner_epoch: &str, now_unix_ms: u64) -> Result<(), GuardError> {
        let current = self.current()?;
        if current.closed {
            return Err(GuardError::Closed);
        }
        let provided = parse_owner_epoch(owner_epoch)?;
        let expected = parse_owner_epoch(&current.request.owner_epoch)?;
        if provided < expected {
            return Err(GuardError::StaleOwnerEpoch);
        }
        if provided > expected {
            return Err(GuardError::OwnerEpochAhead);
        }
        if now_unix_ms >= current.lease_expires_unix_ms {
            return Err(GuardError::LeaseExpired);
        }
        Ok(())
    }

    pub fn assert_current(&self, now_unix_ms: u64) -> Result<(), GuardError> {
        let owner_epoch = self.current()?.request.owner_epoch;
        self.assert_mutation(&owner_epoch, now_unix_ms)
    }

    pub fn snapshot(&self) -> Result<Snapshot, GuardError> {
        let current = self.current()?;
        Ok(Snapshot {
            reservation_id: current.request.reservation_id,
            interaction_id: current.request.interaction_id,
            component: current.component,
            node_id: current.node_id,
            cell_lease_epoch: current.cell_lease_epoch,
            owner_epoch: current.request.owner_epoch,
            state_sequence: current.state_sequence,
            lease_expires_unix_ms: current.lease_expires_unix_ms,
            closed: current.closed,
        })
    }

    pub fn close(&self) -> Result<(), GuardError> {
        let current = self.current()?;
        if current.closed {
            return Ok(());
        }
        let authorization = self
            .authorizer
            .authorize(AuthorizationRequest {
                request: current.request.clone(),
                operation: Operation::Close,
            })
            .map_err(authorizer_error)?;
        self.close_authorized(authorization)
    }

    pub fn close_authorized(
        &self,
        authorization: Authorization,
    ) -> Result<(), GuardError> {
        let current = self.current()?;
        if current.closed {
            return Ok(());
        }
        state_from_authorization(current.request.clone(), authorization, 0, false)?;
        let mut next = current;
        next.closed = true;
        *self.state.write().map_err(|_| GuardError::StatePoisoned)? = Some(next);
        Ok(())
    }

    fn current(&self) -> Result<CachedState, GuardError> {
        self.state
            .read()
            .map_err(|_| GuardError::StatePoisoned)?
            .clone()
            .ok_or(GuardError::NotOpen)
    }
}

fn state_from_authorization(
    request: Request,
    authorization: Authorization,
    now_unix_ms: u64,
    require_fresh: bool,
) -> Result<CachedState, GuardError> {
    if !authorization.allowed
        || authorization.component.is_empty()
        || authorization.node_id.is_empty()
        || authorization.owner_epoch != request.owner_epoch
    {
        return Err(GuardError::AuthorizationMismatch);
    }
    let owner_epoch = parse_owner_epoch(&authorization.owner_epoch)?;
    if owner_epoch >> 32 != authorization.cell_lease_epoch
        || authorization.lease_expires_unix_ms == 0
    {
        return Err(GuardError::AuthorizationMismatch);
    }
    if require_fresh && now_unix_ms >= authorization.lease_expires_unix_ms {
        return Err(GuardError::LeaseExpired);
    }
    Ok(CachedState {
        request,
        component: authorization.component,
        node_id: authorization.node_id,
        cell_lease_epoch: authorization.cell_lease_epoch,
        state_sequence: authorization.state_sequence,
        lease_expires_unix_ms: authorization.lease_expires_unix_ms,
        closed: false,
    })
}

fn validate_request(request: &Request) -> Result<(), GuardError> {
    if !valid_identifier(&request.reservation_id) || !valid_identifier(&request.interaction_id) {
        return Err(GuardError::InvalidRequest);
    }
    parse_owner_epoch(&request.owner_epoch)?;
    Ok(())
}

fn parse_owner_epoch(value: &str) -> Result<u64, GuardError> {
    if value.is_empty() || (value.len() > 1 && value.starts_with('0')) {
        return Err(GuardError::InvalidRequest);
    }
    value.parse::<u64>().map_err(|_| GuardError::InvalidRequest)
}

fn valid_identifier(value: &str) -> bool {
    if value.is_empty() || value.len() > 255 {
        return false;
    }
    value.chars().enumerate().all(|(index, character)| {
        character.is_ascii_alphanumeric()
            || (index > 0 && matches!(character, '.' | '_' | ':' | '-'))
    })
}

fn authorizer_error(error: Box<dyn StdError + Send + Sync>) -> GuardError {
    GuardError::Authorizer(error.to_string().chars().take(512).collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::VecDeque;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Mutex;

    #[test]
    fn guard_never_calls_authorizer_in_mutation_hot_path() {
        let authorizer = FakeAuthorizer::new(vec![
            authorization(10_000, 1),
            authorization(11_000, 2),
            authorization(12_000, 3),
        ]);
        let guard = Guard::new(authorizer);
        let request = request();

        guard.open(request.clone(), 1_000).unwrap();
        for _ in 0..10_000 {
            guard.assert_mutation(&request.owner_epoch, 2_000).unwrap();
        }
        assert_eq!(guard.authorizer.call_count(), 1);

        guard.refresh(2_000).unwrap();
        guard.close().unwrap();
        assert_eq!(guard.authorizer.call_count(), 3);
        assert_eq!(
            guard.authorizer.operations(),
            vec![Operation::Open, Operation::Mutate, Operation::Close]
        );
    }

    #[test]
    fn guard_accepts_authorization_from_an_async_upstream_transport() {
        let guard = Guard::new(FakeAuthorizer::new(Vec::new()));
        let request = request();

        guard
            .open_authorized(request.clone(), authorization(5_000, 1), 1_000)
            .unwrap();
        guard
            .refresh_authorized(authorization(8_000, 2), 2_000)
            .unwrap();
        guard.assert_mutation(&request.owner_epoch, 3_000).unwrap();
        guard
            .close_authorized(authorization(8_000, 3))
            .unwrap();

        assert_eq!(guard.authorizer.call_count(), 0);
        assert_eq!(
            guard.assert_mutation(&request.owner_epoch, 3_000),
            Err(GuardError::Closed)
        );
    }

    #[test]
    fn guard_projects_a_read_only_owner_snapshot() {
        let guard = Guard::new(FakeAuthorizer::new(vec![authorization(10_000, 5)]));
        let request = request();
        guard.open(request.clone(), 1_000).unwrap();

        assert_eq!(
            guard.snapshot().unwrap(),
            Snapshot {
                reservation_id: request.reservation_id,
                interaction_id: request.interaction_id,
                component: "rustdesk".to_string(),
                node_id: "rustdesk-a".to_string(),
                cell_lease_epoch: 3,
                owner_epoch: request.owner_epoch,
                state_sequence: 5,
                lease_expires_unix_ms: 10_000,
                closed: false,
            }
        );
        guard.assert_current(2_000).unwrap();
        assert_eq!(guard.authorizer.call_count(), 1);
    }

    #[test]
    fn guard_fences_epoch_lease_and_sequence() {
        let guard = Guard::new(FakeAuthorizer::new(vec![
            authorization(10_000, 5),
            authorization(11_000, 4),
        ]));
        let request = request();
        guard.open(request.clone(), 1_000).unwrap();

        assert_eq!(
            guard.assert_mutation("12884901888", 2_000),
            Err(GuardError::StaleOwnerEpoch)
        );
        assert_eq!(
            guard.assert_mutation(&request.owner_epoch, 10_000),
            Err(GuardError::LeaseExpired)
        );
        assert_eq!(
            guard.refresh(2_000),
            Err(GuardError::StateSequenceRegression)
        );
    }

    #[test]
    fn guard_rejects_authorization_identity_mismatch() {
        let mut response = authorization(10_000, 1);
        response.owner_epoch = "17179869185".to_string();
        let guard = Guard::new(FakeAuthorizer::new(vec![response]));
        assert_eq!(
            guard.open(request(), 1_000),
            Err(GuardError::AuthorizationMismatch)
        );
    }

    fn request() -> Request {
        Request {
            reservation_id: "reservation-a".to_string(),
            interaction_id: "session-a".to_string(),
            owner_epoch: "12884901889".to_string(),
        }
    }

    fn authorization(expires: u64, sequence: u64) -> Authorization {
        Authorization {
            allowed: true,
            component: "rustdesk".to_string(),
            node_id: "rustdesk-a".to_string(),
            cell_lease_epoch: 3,
            owner_epoch: "12884901889".to_string(),
            state_sequence: sequence,
            lease_expires_unix_ms: expires,
        }
    }

    struct FakeAuthorizer {
        responses: Mutex<VecDeque<Authorization>>,
        operations: Mutex<Vec<Operation>>,
        calls: AtomicUsize,
    }

    impl FakeAuthorizer {
        fn new(responses: Vec<Authorization>) -> Self {
            Self {
                responses: Mutex::new(responses.into()),
                operations: Mutex::new(Vec::new()),
                calls: AtomicUsize::new(0),
            }
        }

        fn call_count(&self) -> usize {
            self.calls.load(Ordering::SeqCst)
        }

        fn operations(&self) -> Vec<Operation> {
            self.operations.lock().unwrap().clone()
        }
    }

    impl Authorizer for FakeAuthorizer {
        fn authorize(
            &self,
            request: AuthorizationRequest,
        ) -> Result<Authorization, Box<dyn StdError + Send + Sync>> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            self.operations.lock().unwrap().push(request.operation);
            self.responses
                .lock()
                .unwrap()
                .pop_front()
                .ok_or_else(|| "no fake response".into())
        }
    }
}
