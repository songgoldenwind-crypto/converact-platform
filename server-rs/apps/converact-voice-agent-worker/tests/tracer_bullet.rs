mod support;

use support::TestWorker;

#[tokio::test]
async fn one_attempt_reaches_completed_without_waiting_for_post_call_evidence() {
    let app = TestWorker::controlled();
    let release = app.publish_fixture_agent();
    let campaign = app.create_fixture_campaign(release.id());
    let attempt = app.run_one_contact(campaign.id()).await.unwrap();

    assert_eq!(attempt.state().as_str(), "completed");
    assert!(attempt.disclosure_completed());
    assert_eq!(attempt.post_call_state().as_str(), "pending");
    assert_eq!(attempt.post_call_error_code(), None);
    assert_eq!(attempt.final_transcript_segments(), None);
    assert_eq!(attempt.outcome(), None);
    assert_eq!(app.finalization_job_count(), 1);
    assert_eq!(app.telephony().originate_count(), 1);
}

#[tokio::test]
async fn campaign_release_is_bound_to_the_agent_reservation() {
    let app = TestWorker::controlled();
    let release = app.publish_fixture_agent();
    let campaign = app.create_fixture_campaign(release.id());

    app.run_one_contact(campaign.id()).await.unwrap();

    let reserved = app.reserved_agent_release().unwrap();
    assert_eq!(reserved.id().as_str(), release.id());
    assert_eq!(reserved.content_hash(), release.content_hash());
    assert_eq!(reserved.components(), release.components());
    let session_id = app.reserved_agent_session_id().unwrap();
    assert!(session_id.as_str().starts_with("ac."));
    assert_eq!(session_id.as_str().len(), 67);
}

#[tokio::test]
async fn failed_atomic_completion_leaves_no_attempt_projection_or_orphan_job() {
    let app = TestWorker::controlled();
    let release = app.publish_fixture_agent();
    let campaign = app.create_fixture_campaign(release.id());
    app.fail_atomic_completion();

    let error = app.run_one_contact(campaign.id()).await.unwrap_err();

    assert_eq!(error.code(), "voice_agent_repository_unavailable");
    assert!(!app.has_attempt("tenant-a", "attempt-001"));
    assert_eq!(app.finalization_job_count(), 0);
    assert_eq!(app.orchestrator_attempt_state().as_str(), "conversing");
}

#[tokio::test]
async fn draining_worker_rejects_new_attempt_before_telephony_mutation() {
    let app = TestWorker::controlled();
    let release = app.publish_fixture_agent();
    let campaign = app.create_fixture_campaign(release.id());
    app.request_shutdown();

    let error = app.run_one_contact(campaign.id()).await.unwrap_err();

    assert_eq!(error.code(), "voice_agent_worker_draining");
    assert_eq!(app.telephony().originate_count(), 0);
}

#[tokio::test]
async fn unbound_campaign_cannot_reach_telephony() {
    let app = TestWorker::controlled();

    let error = app.run_one_contact("campaign-missing").await.unwrap_err();

    assert_eq!(error.code(), "voice_agent_campaign_not_found");
    assert_eq!(app.telephony().originate_count(), 0);
}
