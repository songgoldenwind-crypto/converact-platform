use std::{
    sync::{
        Arc,
        atomic::{AtomicI32, Ordering},
    },
    time::Duration,
};

use converact_kernel_ids::TenantId;
use tokio::sync::Notify;
use tokio_postgres::{Client as PgClient, NoTls};

use crate::{PostgresRuntime, PostgresRuntimeLimits, PostgresRuntimeSettings, TransactionError};

#[tokio::test]
#[ignore = "requires an isolated PostgreSQL database"]
async fn tenant_transaction_installs_local_scope_and_rolls_back_work_errors() {
    let runtime = runtime(2, Duration::from_millis(200));
    let tenant = TenantId::parse("tenant-a").expect("tenant");
    let observed = runtime
        .with_tenant_transaction(&tenant, |transaction| {
            Box::pin(async move {
                let row = transaction
                    .query_one(
                        "SELECT current_setting('app.current_tenant', true), current_setting('statement_timeout'), current_setting('lock_timeout'), current_setting('search_path')",
                        &[],
                    )
                    .await
                    .map_err(|_| ())?;
                Ok::<_, ()>((
                    row.get::<_, String>(0),
                    row.get::<_, String>(1),
                    row.get::<_, String>(2),
                    row.get::<_, String>(3),
                ))
            })
        })
        .await
        .expect("tenant transaction");
    assert_eq!(observed.0, "tenant-a");
    assert_eq!(observed.1, "40ms");
    assert_eq!(observed.2, "10ms");
    assert_eq!(observed.3, "pg_catalog, public, pg_temp");

    let result = runtime
        .with_tenant_transaction(&tenant, |transaction| {
            Box::pin(async move {
                transaction
                    .batch_execute("CREATE TABLE public.rm01_rollback_probe(id integer)")
                    .await
                    .map_err(|_| "query_failed")?;
                Err::<(), _>("work_failed")
            })
        })
        .await;
    assert_eq!(result, Err(TransactionError::Work("work_failed")));

    let table_exists = runtime
        .with_tenant_transaction(&tenant, |transaction| {
            Box::pin(async move {
                transaction
                    .query_one(
                        "SELECT pg_catalog.to_regclass('public.rm01_rollback_probe') IS NOT NULL",
                        &[],
                    )
                    .await
                    .map(|row| row.get::<_, bool>(0))
                    .map_err(|_| ())
            })
        })
        .await
        .expect("rollback check");
    assert!(!table_exists);
}

#[tokio::test]
#[ignore = "requires an isolated PostgreSQL database"]
async fn monotonic_transaction_deadline_rolls_back_and_releases_the_connection() {
    let runtime = runtime(1, Duration::from_millis(80));
    let tenant = TenantId::parse("tenant-a").expect("tenant");
    let result = runtime
        .with_tenant_transaction(&tenant, |_transaction| {
            Box::pin(async move {
                tokio::time::sleep(Duration::from_millis(200)).await;
                Ok::<_, ()>(())
            })
        })
        .await;
    assert_eq!(result, Err(TransactionError::DeadlineExceeded));

    let recovered = runtime
        .with_tenant_transaction(&tenant, |transaction| {
            Box::pin(async move {
                transaction
                    .query_one("SELECT 1::int", &[])
                    .await
                    .map(|row| row.get::<_, i32>(0))
                    .map_err(|_| ())
            })
        })
        .await
        .expect("pool recovered");
    assert_eq!(recovered, 1);
}

#[tokio::test]
#[ignore = "requires an isolated PostgreSQL database"]
async fn database_statement_timeout_cancels_work_and_the_pool_recovers() {
    let runtime = runtime(1, Duration::from_millis(200));
    let tenant = TenantId::parse("tenant-a").expect("tenant");
    let result = runtime
        .with_tenant_transaction(&tenant, |transaction| {
            Box::pin(async move {
                transaction
                    .query_one("SELECT pg_catalog.pg_sleep(0.2)", &[])
                    .await
                    .map(|_| ())
                    .map_err(|error| error.code().map(|code| code.code().to_owned()))
            })
        })
        .await;
    assert_eq!(
        result,
        Err(TransactionError::Work(Some("57014".to_owned())))
    );

    let recovered = runtime
        .with_tenant_transaction(&tenant, |transaction| {
            Box::pin(async move {
                transaction
                    .query_one("SELECT 1::int", &[])
                    .await
                    .map(|row| row.get::<_, i32>(0))
                    .map_err(|_| ())
            })
        })
        .await
        .expect("pool recovered after statement timeout");
    assert_eq!(recovered, 1);
}

#[tokio::test]
#[ignore = "requires an isolated PostgreSQL database"]
async fn exhausted_pool_fails_at_the_bounded_wait_deadline() {
    let runtime = Arc::new(runtime_with(
        1,
        1,
        Duration::from_millis(50),
        Duration::from_secs(2),
    ));
    let tenant = TenantId::parse("tenant-a").expect("tenant");
    let entered = Arc::new(Notify::new());
    let release = Arc::new(Notify::new());
    let holder = {
        let runtime = Arc::clone(&runtime);
        let entered = Arc::clone(&entered);
        let release = Arc::clone(&release);
        let tenant = tenant.clone();
        tokio::spawn(async move {
            runtime
                .with_tenant_transaction(&tenant, move |_transaction| {
                    Box::pin(async move {
                        entered.notify_one();
                        release.notified().await;
                        Ok::<_, ()>(())
                    })
                })
                .await
        })
    };
    entered.notified().await;

    let waiting = runtime
        .with_tenant_transaction(&tenant, |_transaction| Box::pin(async { Ok::<_, ()>(()) }))
        .await;
    assert_eq!(waiting, Err(TransactionError::PoolUnavailable));
    release.notify_one();
    assert_eq!(holder.await.expect("holder task"), Ok(()));
}

#[tokio::test]
#[ignore = "requires an isolated PostgreSQL database"]
async fn cancelling_a_pool_waiter_releases_its_bounded_admission_slot() {
    let runtime = Arc::new(runtime_with(
        1,
        1,
        Duration::from_millis(500),
        Duration::from_secs(2),
    ));
    let tenant = TenantId::parse("tenant-a").expect("tenant");
    let entered = Arc::new(Notify::new());
    let release = Arc::new(Notify::new());
    let holder = {
        let runtime = Arc::clone(&runtime);
        let tenant = tenant.clone();
        let entered = Arc::clone(&entered);
        let release = Arc::clone(&release);
        tokio::spawn(async move {
            runtime
                .with_tenant_transaction(&tenant, move |_transaction| {
                    Box::pin(async move {
                        entered.notify_one();
                        release.notified().await;
                        Ok::<_, ()>(())
                    })
                })
                .await
        })
    };
    entered.notified().await;
    let waiter = {
        let runtime = Arc::clone(&runtime);
        let tenant = tenant.clone();
        tokio::spawn(async move {
            runtime
                .with_tenant_transaction(&tenant, |_transaction| {
                    Box::pin(async { Ok::<_, ()>(()) })
                })
                .await
        })
    };
    tokio::time::timeout(Duration::from_millis(100), async {
        while runtime.status().waiting != 1 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("one pool waiter");
    waiter.abort();
    assert!(waiter.await.expect_err("waiter cancelled").is_cancelled());

    let replacement_waiter = {
        let runtime = Arc::clone(&runtime);
        let tenant = tenant.clone();
        tokio::spawn(async move {
            runtime
                .with_tenant_transaction(&tenant, |_transaction| {
                    Box::pin(async { Ok::<_, ()>(()) })
                })
                .await
        })
    };
    tokio::time::timeout(Duration::from_millis(100), async {
        while runtime.status().waiting != 1 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("replacement waiter admitted");
    release.notify_one();
    assert_eq!(holder.await.expect("holder task"), Ok(()));
    assert_eq!(
        replacement_waiter.await.expect("replacement waiter"),
        Ok(())
    );
}

#[tokio::test]
#[ignore = "requires an isolated PostgreSQL database"]
async fn admission_rejects_work_beyond_the_fixed_connection_and_waiter_bound() {
    let runtime = Arc::new(runtime_with(
        1,
        1,
        Duration::from_millis(500),
        Duration::from_secs(2),
    ));
    let tenant = TenantId::parse("tenant-a").expect("tenant");
    let entered = Arc::new(Notify::new());
    let release = Arc::new(Notify::new());
    let holder = {
        let runtime = Arc::clone(&runtime);
        let tenant = tenant.clone();
        let entered = Arc::clone(&entered);
        let release = Arc::clone(&release);
        tokio::spawn(async move {
            runtime
                .with_tenant_transaction(&tenant, move |_transaction| {
                    Box::pin(async move {
                        entered.notify_one();
                        release.notified().await;
                        Ok::<_, ()>(())
                    })
                })
                .await
        })
    };
    entered.notified().await;
    let waiter = {
        let runtime = Arc::clone(&runtime);
        let tenant = tenant.clone();
        tokio::spawn(async move {
            runtime
                .with_tenant_transaction(&tenant, |_transaction| {
                    Box::pin(async { Ok::<_, ()>(()) })
                })
                .await
        })
    };
    tokio::time::timeout(Duration::from_millis(100), async {
        while runtime.status().waiting != 1 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("one bounded pool waiter");

    let rejected = runtime
        .with_tenant_transaction(&tenant, |_transaction| Box::pin(async { Ok::<_, ()>(()) }))
        .await;
    assert_eq!(rejected, Err(TransactionError::AdmissionRejected));
    release.notify_one();
    assert_eq!(holder.await.expect("holder task"), Ok(()));
    assert_eq!(waiter.await.expect("waiter task"), Ok(()));
}

#[tokio::test]
#[ignore = "requires an isolated PostgreSQL database"]
async fn commit_error_is_unknown_and_discards_the_connection_without_retrying() {
    let runtime = runtime(1, Duration::from_millis(200));
    let tenant = TenantId::parse("tenant-a").expect("tenant");
    runtime
        .with_tenant_transaction(&tenant, |transaction| {
            Box::pin(async move {
                transaction
                    .batch_execute(
                        "CREATE TABLE public.rm01_commit_probe(\
                           value integer UNIQUE DEFERRABLE INITIALLY DEFERRED\
                         )",
                    )
                    .await
                    .map_err(|_| ())
            })
        })
        .await
        .expect("commit probe table");

    let failed_backend_pid = Arc::new(AtomicI32::new(0));
    let result = runtime
        .with_tenant_transaction(&tenant, {
            let failed_backend_pid = Arc::clone(&failed_backend_pid);
            move |transaction| {
                Box::pin(async move {
                    let pid = transaction
                        .query_one("SELECT pg_catalog.pg_backend_pid()", &[])
                        .await
                        .map(|row| row.get::<_, i32>(0))
                        .map_err(|_| ())?;
                    failed_backend_pid.store(pid, Ordering::Relaxed);
                    transaction
                        .batch_execute(
                            "INSERT INTO public.rm01_commit_probe(value) VALUES (1), (1)",
                        )
                        .await
                        .map_err(|_| ())
                })
            }
        })
        .await;
    assert_eq!(result, Err(TransactionError::CommitUnknown));

    let recovered_backend_pid = runtime
        .with_tenant_transaction(&tenant, |transaction| {
            Box::pin(async move {
                transaction
                    .query_one("SELECT pg_catalog.pg_backend_pid()", &[])
                    .await
                    .map(|row| row.get::<_, i32>(0))
                    .map_err(|_| ())
            })
        })
        .await
        .expect("replacement connection");
    assert_ne!(
        recovered_backend_pid,
        failed_backend_pid.load(Ordering::Relaxed)
    );

    runtime
        .with_tenant_transaction(&tenant, |transaction| {
            Box::pin(async move {
                transaction
                    .batch_execute("DROP TABLE public.rm01_commit_probe")
                    .await
                    .map_err(|_| ())
            })
        })
        .await
        .expect("commit probe cleanup");
}

#[tokio::test]
#[ignore = "requires an isolated PostgreSQL database"]
async fn external_work_cancellation_rolls_back_and_discards_the_connection() {
    let runtime = Arc::new(runtime(1, Duration::from_secs(1)));
    let tenant = TenantId::parse("tenant-a").expect("tenant");
    runtime
        .with_tenant_transaction(&tenant, |transaction| {
            Box::pin(async move {
                transaction
                    .batch_execute("CREATE TABLE public.rm01_cancel_probe(value integer)")
                    .await
                    .map_err(|_| ())
            })
        })
        .await
        .expect("cancellation probe table");

    let failed_backend_pid = Arc::new(AtomicI32::new(0));
    let entered = Arc::new(Notify::new());
    let task = {
        let runtime = Arc::clone(&runtime);
        let tenant = tenant.clone();
        let failed_backend_pid = Arc::clone(&failed_backend_pid);
        let entered = Arc::clone(&entered);
        tokio::spawn(async move {
            runtime
                .with_tenant_transaction(&tenant, move |transaction| {
                    Box::pin(async move {
                        let pid = transaction
                            .query_one("SELECT pg_catalog.pg_backend_pid()", &[])
                            .await
                            .map(|row| row.get::<_, i32>(0))
                            .map_err(|_| ())?;
                        failed_backend_pid.store(pid, Ordering::Relaxed);
                        transaction
                            .batch_execute("INSERT INTO public.rm01_cancel_probe VALUES (1)")
                            .await
                            .map_err(|_| ())?;
                        entered.notify_one();
                        std::future::pending::<Result<(), ()>>().await
                    })
                })
                .await
        })
    };
    entered.notified().await;
    task.abort();
    assert!(task.await.expect_err("task cancelled").is_cancelled());

    let (recovered_backend_pid, row_count) = runtime
        .with_tenant_transaction(&tenant, |transaction| {
            Box::pin(async move {
                transaction
                    .query_one(
                        "SELECT pg_catalog.pg_backend_pid(), (SELECT count(*)::bigint FROM public.rm01_cancel_probe)",
                        &[],
                    )
                    .await
                    .map(|row| (row.get::<_, i32>(0), row.get::<_, i64>(1)))
                    .map_err(|_| ())
            })
        })
        .await
        .expect("replacement connection after cancellation");
    assert_ne!(
        recovered_backend_pid,
        failed_backend_pid.load(Ordering::Relaxed)
    );
    assert_eq!(row_count, 0);

    runtime
        .with_tenant_transaction(&tenant, |transaction| {
            Box::pin(async move {
                transaction
                    .batch_execute("DROP TABLE public.rm01_cancel_probe")
                    .await
                    .map_err(|_| ())
            })
        })
        .await
        .expect("cancellation probe cleanup");
}

#[tokio::test]
#[ignore = "requires an isolated PostgreSQL database"]
async fn clean_recycle_resets_session_state_before_reusing_a_connection() {
    let runtime = runtime(1, Duration::from_millis(500));
    let tenant = TenantId::parse("tenant-a").expect("tenant");
    let first_pid = runtime
        .with_tenant_transaction(&tenant, |transaction| {
            Box::pin(async move {
                transaction
                    .batch_execute("SET SESSION app.rm01_session_probe = 'leak'")
                    .await
                    .map_err(|_| ())?;
                transaction
                    .query_one("SELECT pg_catalog.pg_backend_pid()", &[])
                    .await
                    .map(|row| row.get::<_, i32>(0))
                    .map_err(|_| ())
            })
        })
        .await
        .expect("set session probe");

    let (reused_pid, leaked_value) = runtime
        .with_tenant_transaction(&tenant, |transaction| {
            Box::pin(async move {
                transaction
                    .query_one(
                        "SELECT pg_catalog.pg_backend_pid(), pg_catalog.current_setting('app.rm01_session_probe', true)",
                        &[],
                    )
                    .await
                    .map(|row| (row.get::<_, i32>(0), row.get::<_, Option<String>>(1)))
                    .map_err(|_| ())
            })
        })
        .await
        .expect("recycled connection");
    assert_eq!(reused_pid, first_pid);
    assert!(leaked_value.is_none_or(|value| value.is_empty()));
}

#[tokio::test]
#[ignore = "requires isolated PostgreSQL admin and runtime roles"]
async fn rollback_failure_is_unknown_and_discards_the_connection() {
    let admin_url = std::env::var("CONVERACT_TEST_POSTGRES_ADMIN_URL")
        .expect("CONVERACT_TEST_POSTGRES_ADMIN_URL");
    let (admin, admin_connection) = tokio_postgres::connect(&admin_url, NoTls)
        .await
        .expect("admin connection");
    let admin = Arc::new(admin);
    let admin_task = tokio::spawn(admin_connection);
    let runtime = runtime(1, Duration::from_millis(500));
    let tenant = TenantId::parse("tenant-a").expect("tenant");
    let failed_backend_pid = Arc::new(AtomicI32::new(0));
    let result = runtime
        .with_tenant_transaction(&tenant, {
            let admin = Arc::clone(&admin);
            let failed_backend_pid = Arc::clone(&failed_backend_pid);
            move |transaction| {
                Box::pin(async move {
                    let pid = transaction
                        .query_one("SELECT pg_catalog.pg_backend_pid()", &[])
                        .await
                        .map(|row| row.get::<_, i32>(0))
                        .map_err(|_| "pid_query_failed")?;
                    failed_backend_pid.store(pid, Ordering::Relaxed);
                    let terminated = admin
                        .query_one("SELECT pg_catalog.pg_terminate_backend($1)", &[&pid])
                        .await
                        .map(|row| row.get::<_, bool>(0))
                        .map_err(|_| "terminate_failed")?;
                    assert!(terminated);
                    tokio::time::sleep(Duration::from_millis(20)).await;
                    Err::<(), _>("work_failed")
                })
            }
        })
        .await;
    assert_eq!(result, Err(TransactionError::RollbackUnknown));

    let recovered_backend_pid = runtime
        .with_tenant_transaction(&tenant, |transaction| {
            Box::pin(async move {
                transaction
                    .query_one("SELECT pg_catalog.pg_backend_pid()", &[])
                    .await
                    .map(|row| row.get::<_, i32>(0))
                    .map_err(|_| ())
            })
        })
        .await
        .expect("replacement connection after rollback failure");
    assert_ne!(
        recovered_backend_pid,
        failed_backend_pid.load(Ordering::Relaxed)
    );

    drop(runtime);
    drop(admin);
    admin_task
        .await
        .expect("admin connection task")
        .expect("admin connection shutdown");
}

#[tokio::test]
#[ignore = "requires isolated PostgreSQL admin and runtime roles"]
async fn external_commit_cancellation_discards_the_connection_for_reconciliation() {
    let admin_url = std::env::var("CONVERACT_TEST_POSTGRES_ADMIN_URL")
        .expect("CONVERACT_TEST_POSTGRES_ADMIN_URL");
    let (admin, admin_connection) = tokio_postgres::connect(&admin_url, NoTls)
        .await
        .expect("admin connection");
    let admin_task = tokio::spawn(admin_connection);
    create_commit_cancellation_fixture(&admin).await;

    let runtime = Arc::new(runtime(1, Duration::from_secs(1)));
    let tenant = TenantId::parse("tenant-a").expect("tenant");
    let failed_backend_pid = Arc::new(AtomicI32::new(0));
    let work_done = Arc::new(Notify::new());
    let task = {
        let runtime = Arc::clone(&runtime);
        let tenant = tenant.clone();
        let failed_backend_pid = Arc::clone(&failed_backend_pid);
        let work_done = Arc::clone(&work_done);
        tokio::spawn(async move {
            runtime
                .with_tenant_transaction(&tenant, move |transaction| {
                    Box::pin(async move {
                        let pid = transaction
                            .query_one("SELECT pg_catalog.pg_backend_pid()", &[])
                            .await
                            .map(|row| row.get::<_, i32>(0))
                            .map_err(|_| ())?;
                        failed_backend_pid.store(pid, Ordering::Relaxed);
                        transaction
                            .batch_execute(
                                "INSERT INTO public.rm01_commit_cancel_probe(id) VALUES (1)",
                            )
                            .await
                            .map_err(|_| ())?;
                        work_done.notify_one();
                        Ok::<_, ()>(())
                    })
                })
                .await
        })
    };
    work_done.notified().await;
    wait_for_commit_trigger(&admin, failed_backend_pid.load(Ordering::Relaxed)).await;
    task.abort();
    assert!(task.await.expect_err("task cancelled").is_cancelled());
    tokio::time::sleep(Duration::from_millis(550)).await;

    let (recovered_backend_pid, row_count) = runtime
        .with_tenant_transaction(&tenant, |transaction| {
            Box::pin(async move {
                transaction
                    .query_one(
                        "SELECT pg_catalog.pg_backend_pid(), (SELECT count(*)::bigint FROM public.rm01_commit_cancel_probe)",
                        &[],
                    )
                    .await
                    .map(|row| (row.get::<_, i32>(0), row.get::<_, i64>(1)))
                    .map_err(|_| ())
            })
        })
        .await
        .expect("replacement connection after commit cancellation");
    assert_ne!(
        recovered_backend_pid,
        failed_backend_pid.load(Ordering::Relaxed)
    );
    assert!((0..=1).contains(&row_count));

    drop(runtime);
    drop_commit_cancellation_fixture(&admin).await;
    drop(admin);
    admin_task
        .await
        .expect("admin connection task")
        .expect("admin connection shutdown");
}

async fn create_commit_cancellation_fixture(admin: &PgClient) {
    admin
        .batch_execute(
            r"
            CREATE TABLE public.rm01_commit_cancel_probe(id integer PRIMARY KEY);
            CREATE FUNCTION public.rm01_sleep_before_commit() RETURNS trigger
            LANGUAGE plpgsql AS $$
            BEGIN
              PERFORM pg_catalog.pg_sleep(0.5);
              RETURN NULL;
            END
            $$;
            CREATE CONSTRAINT TRIGGER rm01_sleep_before_commit
              AFTER INSERT ON public.rm01_commit_cancel_probe
              DEFERRABLE INITIALLY DEFERRED
              FOR EACH ROW EXECUTE FUNCTION public.rm01_sleep_before_commit();
            GRANT SELECT, INSERT ON public.rm01_commit_cancel_probe TO opc_runtime_test;
            ",
        )
        .await
        .expect("commit cancellation fixture");
}

async fn wait_for_commit_trigger(admin: &PgClient, backend_pid: i32) {
    tokio::time::timeout(Duration::from_millis(200), async {
        loop {
            let sleeping = admin
                .query_one(
                    "SELECT wait_event = 'PgSleep' FROM pg_catalog.pg_stat_activity WHERE pid = $1",
                    &[&backend_pid],
                )
                .await
                .map(|row| row.get::<_, Option<bool>>(0).unwrap_or(false))
                .unwrap_or(false);
            if sleeping {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("commit entered deferred trigger");
}

async fn drop_commit_cancellation_fixture(admin: &PgClient) {
    admin
        .batch_execute(
            "DROP TABLE public.rm01_commit_cancel_probe; \
             DROP FUNCTION public.rm01_sleep_before_commit()",
        )
        .await
        .expect("commit cancellation fixture cleanup");
}

#[tokio::test]
#[ignore = "requires isolated PostgreSQL admin and non-bypass runtime roles"]
async fn database_rls_isolates_reads_writes_for_the_authoritative_tenant() {
    let admin_url = std::env::var("CONVERACT_TEST_POSTGRES_ADMIN_URL")
        .expect("CONVERACT_TEST_POSTGRES_ADMIN_URL");
    let (admin, admin_connection) = tokio_postgres::connect(&admin_url, NoTls)
        .await
        .expect("admin connection");
    let admin_task = tokio::spawn(admin_connection);
    admin
        .batch_execute(
            r"
            CREATE TABLE public.rm01_tenant_records(
              tenant_id text NOT NULL,
              value text NOT NULL
            );
            ALTER TABLE public.rm01_tenant_records ENABLE ROW LEVEL SECURITY;
            ALTER TABLE public.rm01_tenant_records FORCE ROW LEVEL SECURITY;
            CREATE POLICY rm01_tenant_records_policy ON public.rm01_tenant_records
              USING (tenant_id = pg_catalog.current_setting('app.current_tenant', true))
              WITH CHECK (tenant_id = pg_catalog.current_setting('app.current_tenant', true));
            GRANT SELECT, INSERT ON public.rm01_tenant_records TO opc_runtime_test;
            INSERT INTO public.rm01_tenant_records VALUES ('tenant-a', 'a'), ('tenant-b', 'b');
            ",
        )
        .await
        .expect("RLS fixture");

    let runtime = runtime(2, Duration::from_millis(500));
    let tenant_a = TenantId::parse("tenant-a").expect("tenant A");
    let tenant_b = TenantId::parse("tenant-b").expect("tenant B");
    assert_eq!(visible_values(&runtime, &tenant_a).await, vec!["a"]);
    assert_eq!(visible_values(&runtime, &tenant_b).await, vec!["b"]);

    let cross_tenant_insert = runtime
        .with_tenant_transaction(&tenant_a, |transaction| {
            Box::pin(async move {
                transaction
                    .execute(
                        "INSERT INTO public.rm01_tenant_records(tenant_id, value) VALUES ('tenant-b', 'leak')",
                        &[],
                    )
                    .await
                    .map(|_| ())
                    .map_err(|_| "rls_rejected")
            })
        })
        .await;
    assert_eq!(
        cross_tenant_insert,
        Err(TransactionError::Work("rls_rejected"))
    );

    let role = runtime
        .with_tenant_transaction(&tenant_a, |transaction| {
            Box::pin(async move {
                transaction
                    .query_one(
                        "SELECT rolsuper, rolbypassrls FROM pg_catalog.pg_roles WHERE rolname = current_user",
                        &[],
                    )
                    .await
                    .map(|row| (row.get::<_, bool>(0), row.get::<_, bool>(1)))
                    .map_err(|_| ())
            })
        })
        .await
        .expect("runtime role");
    assert_eq!(role, (false, false));

    drop(runtime);
    admin
        .batch_execute("DROP TABLE public.rm01_tenant_records")
        .await
        .expect("fixture cleanup");
    drop(admin);
    admin_task
        .await
        .expect("admin connection task")
        .expect("admin connection shutdown");
}

async fn visible_values(runtime: &PostgresRuntime, tenant: &TenantId) -> Vec<String> {
    runtime
        .with_tenant_transaction(tenant, |transaction| {
            Box::pin(async move {
                transaction
                    .query(
                        "SELECT value FROM public.rm01_tenant_records ORDER BY value",
                        &[],
                    )
                    .await
                    .map(|rows| rows.into_iter().map(|row| row.get(0)).collect())
                    .map_err(|_| ())
            })
        })
        .await
        .expect("tenant read")
}

fn runtime(max_connections: usize, transaction_timeout: Duration) -> PostgresRuntime {
    runtime_with(
        max_connections,
        4,
        Duration::from_millis(50),
        transaction_timeout,
    )
}

fn runtime_with(
    max_connections: usize,
    max_waiters: usize,
    pool_wait_timeout: Duration,
    transaction_timeout: Duration,
) -> PostgresRuntime {
    let database_url = std::env::var("CONVERACT_TEST_POSTGRES_URL")
        .expect("CONVERACT_TEST_POSTGRES_URL must point to an isolated database");
    let settings = PostgresRuntimeSettings::new(PostgresRuntimeLimits {
        max_connections,
        max_waiters,
        pool_wait_timeout,
        connect_timeout: Duration::from_millis(500),
        recycle_timeout: Duration::from_millis(100),
        statement_timeout: Duration::from_millis(40),
        lock_timeout: Duration::from_millis(10),
        transaction_timeout,
        rollback_timeout: Duration::from_millis(20),
    })
    .expect("valid settings");
    PostgresRuntime::build(
        database_url.parse().expect("PostgreSQL URL"),
        NoTls,
        settings,
    )
    .expect("runtime")
}
