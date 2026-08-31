use converact_voice_agent_contracts::{
    CallAttemptId, ExecutionGeneration, IdentityError, InteractionId,
};

#[test]
fn identifiers_accept_only_the_frozen_ascii_grammar() {
    let interaction = InteractionId::parse("interaction-001").unwrap();
    let attempt = CallAttemptId::parse("attempt:001").unwrap();
    assert_eq!(interaction.as_str(), "interaction-001");
    assert_eq!(attempt.as_str(), "attempt:001");
    assert_eq!(
        InteractionId::parse(""),
        Err(IdentityError::InvalidIdentifier)
    );
    assert_eq!(
        CallAttemptId::parse("客户-001"),
        Err(IdentityError::InvalidIdentifier)
    );
    assert_eq!(
        CallAttemptId::parse("x".repeat(256)),
        Err(IdentityError::InvalidIdentifier)
    );
}

#[test]
fn execution_generation_is_positive_and_never_wraps() {
    assert_eq!(
        ExecutionGeneration::new(0),
        Err(IdentityError::InvalidGeneration)
    );
    let first = ExecutionGeneration::new(1).unwrap();
    assert_eq!(first.get(), 1);
    assert_eq!(first.next().unwrap().get(), 2);
    assert_eq!(
        ExecutionGeneration::new(u64::MAX).unwrap().next(),
        Err(IdentityError::GenerationExhausted),
    );
}
