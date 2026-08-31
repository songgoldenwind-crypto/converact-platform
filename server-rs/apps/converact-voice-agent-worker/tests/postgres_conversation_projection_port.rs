use converact_postgres_store::PostgresConversationResultStore;
use converact_voice_agent_worker::{
    ConversationEvaluationDurabilityPort, ConversationEvidenceDurabilityPort,
    ConversationProjectionDurabilityPort,
};

#[test]
fn postgres_conversation_result_store_implements_worker_projection_port() {
    fn assert_port<T: ConversationProjectionDurabilityPort>() {}
    fn assert_evaluation_port<T: ConversationEvaluationDurabilityPort>() {}
    fn assert_evidence_port<T: ConversationEvidenceDurabilityPort>() {}

    assert_port::<PostgresConversationResultStore>();
    assert_evaluation_port::<PostgresConversationResultStore>();
    assert_evidence_port::<PostgresConversationResultStore>();
}
