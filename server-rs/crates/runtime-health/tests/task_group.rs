use std::{future::pending, time::Duration};

use converact_runtime_health::{HealthTaskGroup, TaskGroupError, TaskShutdown};

#[tokio::test]
async fn cooperative_children_exit_and_new_work_is_rejected_after_shutdown() {
    let mut tasks = HealthTaskGroup::new(2).expect("bounded task group");
    tasks
        .spawn(|mut shutdown| async move {
            let _ = shutdown.changed().await;
        })
        .expect("spawn health task");
    assert_eq!(tasks.active_tasks(), 1);

    assert_eq!(
        tasks.shutdown(Duration::from_secs(1)).await,
        TaskShutdown::Cooperative
    );
    assert_eq!(tasks.active_tasks(), 0);
    assert_eq!(tasks.spawn(|_| async {}), Err(TaskGroupError::Closed));
}

#[tokio::test]
async fn shutdown_aborts_and_drains_a_hung_child_at_the_deadline() {
    let mut tasks = HealthTaskGroup::new(1).expect("bounded task group");
    tasks
        .spawn(|_| async move { pending::<()>().await })
        .expect("spawn hung health task");

    assert_eq!(
        tasks.shutdown(Duration::from_millis(10)).await,
        TaskShutdown::Forced { aborted: 1 }
    );
    assert_eq!(tasks.active_tasks(), 0);
}

#[tokio::test]
async fn task_capacity_is_explicit_and_bounded() {
    assert!(matches!(
        HealthTaskGroup::new(0),
        Err(TaskGroupError::InvalidCapacity)
    ));

    let mut tasks = HealthTaskGroup::new(1).expect("bounded task group");
    tasks
        .spawn(|_| async move { pending::<()>().await })
        .expect("spawn first health task");
    assert_eq!(tasks.spawn(|_| async {}), Err(TaskGroupError::AtCapacity));
    assert_eq!(
        tasks.shutdown(Duration::ZERO).await,
        TaskShutdown::Forced { aborted: 1 }
    );
}
