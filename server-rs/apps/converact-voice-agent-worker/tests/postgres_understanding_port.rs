use converact_postgres_store::PostgresConversationUnderstandingStore;
use converact_voice_agent_worker::UnderstandingDurabilityPort;

#[test]
fn postgres_understanding_store_implements_worker_durability_port() {
    fn assert_port<T: UnderstandingDurabilityPort>() {}

    assert_port::<PostgresConversationUnderstandingStore>();
}
