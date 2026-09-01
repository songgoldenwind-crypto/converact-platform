use converact_voice_agent_worker::{
    ModelProviderPool, ModelProviderPoolConfig, ModelProviderPoolError,
};

#[tokio::test]
async fn provider_selection_is_constant_time_and_admission_is_fail_fast() {
    let pool = ModelProviderPool::try_new(
        vec!["endpoint-a", "endpoint-b"],
        ModelProviderPoolConfig::try_new(1, 0, 10).unwrap(),
    )
    .unwrap();

    let first = pool.acquire().await.unwrap();
    assert_eq!(*first.provider(), "endpoint-a");
    assert_eq!(
        pool.acquire().await.unwrap_err(),
        ModelProviderPoolError::Saturated
    );
    drop(first);

    let second = pool.acquire().await.unwrap();
    assert_eq!(*second.provider(), "endpoint-b");
    drop(second);
    let third = pool.acquire().await.unwrap();
    assert_eq!(*third.provider(), "endpoint-a");
}

#[tokio::test]
async fn bounded_waiter_expires_without_starting_background_work() {
    let pool = ModelProviderPool::try_new(
        vec!["endpoint-a"],
        ModelProviderPoolConfig::try_new(1, 1, 1).unwrap(),
    )
    .unwrap();
    let active = pool.acquire().await.unwrap();

    assert_eq!(
        pool.acquire().await.unwrap_err(),
        ModelProviderPoolError::QueueTimedOut
    );
    drop(active);
    assert!(pool.acquire().await.is_ok());
}

#[test]
fn empty_or_unbounded_pool_configuration_is_rejected() {
    let valid = ModelProviderPoolConfig::try_new(1, 0, 1).unwrap();
    assert_eq!(
        ModelProviderPool::<u8>::try_new(Vec::new(), valid).unwrap_err(),
        ModelProviderPoolError::InvalidConfiguration
    );
    assert_eq!(
        ModelProviderPoolConfig::try_new(0, 0, 1).unwrap_err(),
        ModelProviderPoolError::InvalidConfiguration
    );
    assert_eq!(
        ModelProviderPoolConfig::try_new(1, 8_193, 1).unwrap_err(),
        ModelProviderPoolError::InvalidConfiguration
    );
}
