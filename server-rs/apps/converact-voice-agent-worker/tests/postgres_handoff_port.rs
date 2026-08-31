use converact_postgres_store::PostgresHandoffStore;
use converact_voice_agent_worker::HandoffDurabilityPort;

#[test]
fn postgres_handoff_store_implements_worker_durability_port() {
    fn assert_port<T: HandoffDurabilityPort>() {}

    assert_port::<PostgresHandoffStore>();
}
