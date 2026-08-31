mod support;

use support::TestWorker;

#[tokio::test]
async fn one_attempt_reaches_completed_with_disclosure_and_final_transcript() {
    let app = TestWorker::controlled();
    let release = app.publish_fixture_agent();
    let campaign = app.create_fixture_campaign(release.id());
    let attempt = app.run_one_contact(campaign.id()).await.unwrap();

    assert_eq!(attempt.state().as_str(), "completed");
    assert!(attempt.disclosure_completed());
    assert_eq!(attempt.final_transcript_segments(), 2);
    assert_eq!(attempt.outcome().unwrap().code(), "customer_interested");
    assert_eq!(app.telephony().originate_count(), 1);
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
