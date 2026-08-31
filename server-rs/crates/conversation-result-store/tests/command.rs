use converact_conversation_result_store::{
    ConversationResultStoreError, ProjectionCommand, ProjectionCommandInput, ProjectionCommandKind,
};
use converact_voice_agent_contracts::{
    ExecutionGeneration, InteractionId, ResultProjectionCommandId,
};

#[test]
fn projection_command_binds_kind_request_hash_revision_and_generation_fence() {
    let command = ProjectionCommand::try_new(ProjectionCommandInput {
        id: ResultProjectionCommandId::parse("projection-command-001").unwrap(),
        interaction_id: InteractionId::parse("interaction-001").unwrap(),
        kind: ProjectionCommandKind::PersistResult,
        payload_hash: "a".repeat(64),
        expected_result_revision: Some(1),
        expected_generation: ExecutionGeneration::new(2).unwrap(),
    })
    .unwrap();

    assert_eq!(command.kind().as_str(), "persist_result");
    assert_eq!(command.expected_result_revision(), Some(1));
    assert_eq!(command.expected_generation().get(), 2);
}

#[test]
fn projection_command_fails_closed_on_malformed_hash_or_kind_revision_pair() {
    let invalid_hash = ProjectionCommand::try_new(ProjectionCommandInput {
        id: ResultProjectionCommandId::parse("projection-command-invalid-hash").unwrap(),
        interaction_id: InteractionId::parse("interaction-001").unwrap(),
        kind: ProjectionCommandKind::PersistResult,
        payload_hash: "NOT-A-HASH".to_owned(),
        expected_result_revision: Some(1),
        expected_generation: ExecutionGeneration::new(2).unwrap(),
    });
    assert_eq!(
        invalid_hash,
        Err(ConversationResultStoreError::InvalidCommand)
    );

    let invalid_revision = ProjectionCommand::try_new(ProjectionCommandInput {
        id: ResultProjectionCommandId::parse("projection-command-invalid-revision").unwrap(),
        interaction_id: InteractionId::parse("interaction-001").unwrap(),
        kind: ProjectionCommandKind::FreezeSnapshot,
        payload_hash: "a".repeat(64),
        expected_result_revision: Some(1),
        expected_generation: ExecutionGeneration::new(2).unwrap(),
    });
    assert_eq!(
        invalid_revision,
        Err(ConversationResultStoreError::InvalidCommand)
    );
}
