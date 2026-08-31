use converact_ai_outbound_core::{
    AgentDraft, AuthoringError, CampaignCommand, CampaignSchedule, CampaignTransition,
    CreateCampaign, DialPolicyRevision, DialPolicyRevisionInput, ImportContact, ImportContactInput,
    ImportContacts, RecordingMode, ReleaseComponentDigests, publish_agent,
};
use converact_voice_agent_contracts::{
    AgentDefinitionId, AgentReleaseId, CallAttemptId, CampaignContactId, CampaignId,
    IdempotencyKey, InteractionId,
};

#[test]
fn published_release_exposes_only_the_fields_required_by_persistence() {
    let release = publish_agent(
        AgentDraft::try_new(
            AgentDefinitionId::parse("agent-001").unwrap(),
            AgentReleaseId::parse("release-001").unwrap(),
            "General service agent",
            "zh-CN",
        )
        .unwrap(),
        component_digests(),
    )
    .unwrap();

    assert_eq!(release.name(), "General service agent");
    assert_eq!(release.language(), "zh-CN");
    assert_eq!(release.components(), &component_digests());
}

#[test]
fn campaign_and_transition_commands_have_deterministic_content_hashes() {
    let left = CreateCampaign::try_new(
        CampaignId::parse("campaign-001").unwrap(),
        AgentReleaseId::parse("release-001").unwrap(),
        "audience-001",
        dial_policy(),
        CampaignSchedule::try_new(1_800_000_000_000, "Asia/Shanghai").unwrap(),
    )
    .unwrap();
    let right = CreateCampaign::try_new(
        CampaignId::parse("campaign-001").unwrap(),
        AgentReleaseId::parse("release-001").unwrap(),
        "audience-001",
        dial_policy(),
        CampaignSchedule::try_new(1_800_000_000_000, "Asia/Shanghai").unwrap(),
    )
    .unwrap();

    assert_eq!(left.request_hash(), right.request_hash());
    assert_eq!(left.request_hash().len(), 64);
    assert_eq!(left.audience_id(), "audience-001");
    assert_eq!(left.dial_policy_revision(), "dial-policy-r1");
    assert_eq!(left.dial_policy().caller_id(), Some("+8610000000000"));
    assert_eq!(left.dial_policy().timeout_secs(), 30);
    assert_eq!(left.dial_policy().trunk(), Some("carrier-a"));

    let transition = CampaignTransition::try_new(
        CampaignId::parse("campaign-001").unwrap(),
        CampaignCommand::Schedule,
        1,
        IdempotencyKey::parse("campaign-001:schedule:1").unwrap(),
    )
    .unwrap();
    assert_eq!(transition.command(), CampaignCommand::Schedule);
    assert_eq!(transition.expected_revision(), 1);
    assert_eq!(transition.request_hash().len(), 64);
}

#[test]
fn dial_policy_is_bounded_content_addressed_and_redacted() {
    let policy = dial_policy();
    let debug = format!("{policy:?}");

    assert_eq!(policy.revision_id(), "dial-policy-r1");
    assert_eq!(policy.content_hash().len(), 64);
    assert!(!debug.contains("10000000000"));
    assert!(!debug.contains("carrier-a"));
    assert_eq!(
        DialPolicyRevision::try_new(DialPolicyRevisionInput {
            revision_id: "dial-policy-r2".to_owned(),
            caller_id: Some("+8610000000000\r\nX-Evil: yes".to_owned()),
            timeout_secs: 30,
            trunk: None,
        }),
        Err(AuthoringError::InvalidDialPolicy),
    );
}

#[test]
fn import_accepts_five_hundred_contacts_and_hashes_content() {
    let contacts = (0..500).map(contact).collect();
    let batch = ImportContacts::try_new(
        CampaignId::parse("campaign-001").unwrap(),
        1,
        IdempotencyKey::parse("campaign-001:import:001").unwrap(),
        contacts,
    )
    .unwrap();

    assert_eq!(batch.contacts().len(), 500);
    assert_eq!(batch.request_hash().len(), 64);
    assert_eq!(
        batch.contacts()[0].recording_mode(),
        RecordingMode::AfterDisclosure
    );
    assert_eq!(batch.contacts()[0].destination(), "+8613800000000");
}

#[test]
fn import_rejects_empty_oversized_and_duplicate_identity_batches() {
    assert_eq!(
        ImportContacts::try_new(
            CampaignId::parse("campaign-001").unwrap(),
            1,
            IdempotencyKey::parse("campaign-001:import:empty").unwrap(),
            Vec::new(),
        ),
        Err(AuthoringError::InvalidBatchSize)
    );

    let oversized = (0..501).map(contact).collect();
    assert_eq!(
        ImportContacts::try_new(
            CampaignId::parse("campaign-001").unwrap(),
            1,
            IdempotencyKey::parse("campaign-001:import:large").unwrap(),
            oversized,
        ),
        Err(AuthoringError::InvalidBatchSize)
    );

    let duplicate = contact(7);
    assert_eq!(
        ImportContacts::try_new(
            CampaignId::parse("campaign-001").unwrap(),
            1,
            IdempotencyKey::parse("campaign-001:import:duplicate").unwrap(),
            vec![duplicate.clone(), duplicate],
        ),
        Err(AuthoringError::DuplicateIdentity)
    );
}

#[test]
fn contact_validation_and_debug_output_fail_closed_without_destination_leakage() {
    let mut invalid = contact_input(1);
    invalid.destination = "bad destination".to_owned();
    assert_eq!(
        ImportContact::try_new(invalid),
        Err(AuthoringError::InvalidDestination)
    );

    let mut invalid = contact_input(1);
    invalid.consent_id = "bad consent".to_owned();
    assert_eq!(
        ImportContact::try_new(invalid),
        Err(AuthoringError::InvalidConsent)
    );

    let mut invalid = contact_input(1);
    invalid.retention_until_ms = invalid.scheduled_for_ms;
    assert_eq!(
        ImportContact::try_new(invalid),
        Err(AuthoringError::InvalidRetention)
    );

    let batch = ImportContacts::try_new(
        CampaignId::parse("campaign-001").unwrap(),
        1,
        IdempotencyKey::parse("campaign-001:import:debug").unwrap(),
        vec![contact(1)],
    )
    .unwrap();
    let debug = format!("{batch:?}");
    assert!(!debug.contains("+8613800000001"));
    assert!(!debug.contains("consent-001"));
    assert!(debug.contains("contact_count: 1"));
}

#[test]
fn campaign_schedule_and_transition_revision_are_bounded() {
    assert_eq!(
        CampaignSchedule::try_new(0, "Asia/Shanghai"),
        Err(AuthoringError::InvalidSchedule)
    );
    assert_eq!(
        CampaignSchedule::try_new(1_800_000_000_000, "bad timezone"),
        Err(AuthoringError::InvalidSchedule)
    );
    assert_eq!(
        CampaignTransition::try_new(
            CampaignId::parse("campaign-001").unwrap(),
            CampaignCommand::Start,
            0,
            IdempotencyKey::parse("campaign-001:start:0").unwrap(),
        ),
        Err(AuthoringError::InvalidRevision)
    );
}

fn contact(index: usize) -> ImportContact {
    ImportContact::try_new(contact_input(index)).unwrap()
}

fn dial_policy() -> DialPolicyRevision {
    DialPolicyRevision::try_new(DialPolicyRevisionInput {
        revision_id: "dial-policy-r1".to_owned(),
        caller_id: Some("+8610000000000".to_owned()),
        timeout_secs: 30,
        trunk: Some("carrier-a".to_owned()),
    })
    .unwrap()
}

fn contact_input(index: usize) -> ImportContactInput {
    ImportContactInput {
        contact_id: CampaignContactId::parse(format!("contact-{index:03}")).unwrap(),
        external_contact_id: format!("external-{index:03}"),
        destination: format!("+861380000{index:04}"),
        consent_id: "consent-001".to_owned(),
        recording_mode: RecordingMode::AfterDisclosure,
        retention_until_ms: 1_900_000_000_000,
        scheduled_for_ms: 1_800_000_000_000,
        attempt_id: CallAttemptId::parse(format!("attempt-{index:03}")).unwrap(),
        interaction_id: InteractionId::parse(format!("interaction-{index:03}")).unwrap(),
        idempotency_key: IdempotencyKey::parse(format!("dial:attempt-{index:03}")).unwrap(),
    }
}

fn component_digests() -> ReleaseComponentDigests {
    ReleaseComponentDigests {
        prompt_revision_hash: "1".repeat(64),
        conversation_flow_revision_hash: "2".repeat(64),
        knowledge_revision_hash: "3".repeat(64),
        tool_schema_hash: "4".repeat(64),
        speech_profile_hash: "5".repeat(64),
        compliance_policy_hash: "6".repeat(64),
        outcome_schema_hash: "7".repeat(64),
        evaluation_rubric_hash: "8".repeat(64),
    }
}
