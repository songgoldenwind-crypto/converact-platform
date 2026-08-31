use converact_postgres_store::PostgresPostCallFinalizationStore;
use converact_voice_agent_worker::FinalizationQueuePort;

#[test]
fn postgres_finalization_store_implements_worker_queue_port() {
    fn assert_queue_port<T: FinalizationQueuePort>() {}

    assert_queue_port::<PostgresPostCallFinalizationStore>();
}
