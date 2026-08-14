use converact_kernel_ids::{CellId, Generation, OwnerEpoch, TenantId};
use converact_migration_routing::{
    AuthorityKind, AuthorityRoute, GenerationRecord, GenerationState, Implementation, LeaseToken,
    MutationScope, PartitionKey, RouteError, RouteKey, RouteRevision, SchemaRevision,
    WriterBinding, WriterClaim, authorize_mutation,
};

#[test]
fn new_objects_require_the_exact_current_generation_owner_and_lease() {
    let route = route(2);
    let generation = generation_record(2, GenerationState::AcceptingNewWork, 8, 'a');
    let current_claim = claim(2, 8, 'a');

    assert!(
        authorize_mutation(
            &route,
            &generation,
            &current_claim,
            MutationScope::NewObject
        )
        .is_ok()
    );
    assert_eq!(
        authorize_mutation(
            &route,
            &generation_record(1, GenerationState::Draining, 7, 'b'),
            &claim(1, 7, 'b'),
            MutationScope::NewObject,
        ),
        Err(RouteError::StaleGeneration)
    );
    assert_eq!(
        authorize_mutation(
            &route,
            &generation,
            &claim(2, 7, 'a'),
            MutationScope::NewObject
        ),
        Err(RouteError::StaleOwnerEpoch)
    );
    assert_eq!(
        authorize_mutation(
            &route,
            &generation,
            &claim(2, 8, 'b'),
            MutationScope::NewObject
        ),
        Err(RouteError::LeaseMismatch)
    );
}

#[test]
fn existing_objects_stay_on_their_starting_generation_while_it_drains() {
    let route = route(2);
    let legacy = generation_record(1, GenerationState::Draining, 7, 'b');

    assert!(
        authorize_mutation(
            &route,
            &legacy,
            &claim(1, 7, 'b'),
            MutationScope::ExistingObject {
                starting_generation: generation(1),
            },
        )
        .is_ok()
    );
    assert_eq!(
        authorize_mutation(
            &route,
            &legacy,
            &claim(1, 7, 'b'),
            MutationScope::ExistingObject {
                starting_generation: generation(2),
            },
        ),
        Err(RouteError::ObjectGenerationMismatch)
    );
}

#[test]
fn prepared_active_zero_and_retired_generations_are_never_writable() {
    let route = route(2);
    for state in [
        GenerationState::Prepared,
        GenerationState::ActiveZero,
        GenerationState::Retired,
    ] {
        let record = generation_record(1, state, 7, 'b');
        assert_eq!(
            authorize_mutation(
                &route,
                &record,
                &claim(1, 7, 'b'),
                MutationScope::ExistingObject {
                    starting_generation: generation(1),
                },
            ),
            Err(RouteError::GenerationNotWritable),
            "accepted {state:?}"
        );
    }
}

#[test]
fn lease_capability_is_redacted_from_direct_and_nested_debug_output() {
    let raw = "a".repeat(64);
    let lease = LeaseToken::parse(&raw).unwrap();
    let generation = GenerationRecord::new(
        key(),
        binding(2, 8),
        GenerationState::AcceptingNewWork,
        lease.clone(),
    )
    .unwrap();
    let claim = WriterClaim::new(
        key(),
        self::generation(2),
        OwnerEpoch::parse("8").unwrap(),
        lease.clone(),
    );

    for debug in [
        format!("{lease:?}"),
        format!("{generation:?}"),
        format!("{claim:?}"),
    ] {
        assert!(!debug.contains(&raw));
        assert!(debug.contains("[REDACTED]"));
    }
}

fn route(current_generation: u64) -> AuthorityRoute {
    AuthorityRoute::new(
        key(),
        binding(current_generation, 8),
        RouteRevision::new(3).unwrap(),
    )
    .unwrap()
}

fn generation_record(
    generation_value: u64,
    state: GenerationState,
    owner_epoch: u64,
    token: char,
) -> GenerationRecord {
    GenerationRecord::new(
        key(),
        binding(generation_value, owner_epoch),
        state,
        lease(token),
    )
    .unwrap()
}

fn claim(generation_value: u64, owner_epoch: u64, token: char) -> WriterClaim {
    WriterClaim::new(
        key(),
        generation(generation_value),
        OwnerEpoch::parse(&owner_epoch.to_string()).unwrap(),
        lease(token),
    )
}

fn key() -> RouteKey {
    RouteKey::new(
        TenantId::parse("tenant-a").unwrap(),
        AuthorityKind::parse("interaction").unwrap(),
        PartitionKey::parse("partition-001").unwrap(),
    )
}

fn binding(generation_value: u64, owner_epoch: u64) -> WriterBinding {
    WriterBinding::new(
        CellId::parse("cell-a").unwrap(),
        Implementation::Rust,
        OwnerEpoch::parse(&owner_epoch.to_string()).unwrap(),
        generation(generation_value),
        SchemaRevision::new(2).unwrap(),
    )
}

fn lease(value: char) -> LeaseToken {
    LeaseToken::parse(&value.to_string().repeat(64)).unwrap()
}

fn generation(value: u64) -> Generation {
    Generation::new(value).unwrap()
}
