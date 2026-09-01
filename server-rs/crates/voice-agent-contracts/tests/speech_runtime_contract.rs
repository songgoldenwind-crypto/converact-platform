use converact_voice_agent_contracts::{
    AgentRunId, AudioWriteOutcome, ChannelBindingId, ContextRevision, ExecutionGeneration,
    InteractionId, PcmAudioFrame, ResponseFence, ResponseGeneration, ResponseLease,
    ResponseLeaseGeneration, SpeechContractError, SpeechControlFence, SpeechResponseId,
    SpeechRuntimeEventKind, SpeechSessionBinding, SpeechSessionId, SpeechSessionState, TenantId,
};

fn binding() -> SpeechSessionBinding {
    SpeechSessionBinding::new(
        TenantId::parse("tenant-001").unwrap(),
        InteractionId::parse("interaction-001").unwrap(),
        AgentRunId::parse("agent-run-001").unwrap(),
        SpeechSessionId::parse("speech-session-001").unwrap(),
        ChannelBindingId::parse("channel-binding-001").unwrap(),
        ExecutionGeneration::new(2).unwrap(),
        ExecutionGeneration::new(3).unwrap(),
        SpeechControlFence::new(4).unwrap(),
    )
}

#[test]
fn speech_authority_types_are_distinct_bounded_and_wire_stable() {
    let binding = binding();
    assert_eq!(binding.tenant_id().as_str(), "tenant-001");
    assert_eq!(binding.interaction_id().as_str(), "interaction-001");
    assert_eq!(binding.agent_run_id().as_str(), "agent-run-001");
    assert_eq!(binding.speech_session_id().as_str(), "speech-session-001");
    assert_eq!(binding.channel_binding_id().as_str(), "channel-binding-001");
    assert_eq!(binding.session_generation().get(), 2);
    assert_eq!(binding.media_generation().get(), 3);
    assert_eq!(binding.control_fence().get(), 4);

    let lease = ResponseLease::new(
        SpeechResponseId::parse("response-001").unwrap(),
        ContextRevision::new(5).unwrap(),
        ResponseLeaseGeneration::new(6).unwrap(),
        ResponseGeneration::new(7).unwrap(),
        ResponseFence::new(8).unwrap(),
    );
    assert_eq!(lease.response_id().as_str(), "response-001");
    assert_eq!(lease.context_revision().get(), 5);
    assert_eq!(lease.lease_generation().get(), 6);
    assert_eq!(lease.response_generation().get(), 7);
    assert_eq!(lease.response_fence().get(), 8);

    let value = serde_json::to_value(&binding).unwrap();
    assert_eq!(value["control_fence"], 4);
    assert_eq!(
        serde_json::from_value::<SpeechSessionBinding>(value).unwrap(),
        binding,
    );
    assert_eq!(
        SpeechControlFence::new(0),
        Err(SpeechContractError::InvalidGeneration),
    );
    assert_eq!(
        ResponseFence::new(0),
        Err(SpeechContractError::InvalidGeneration),
    );
}

#[test]
fn pcm_frames_are_bounded_and_revalidated_on_deserialization() {
    let frame = PcmAudioFrame::try_new(1, 99, 16_000, 1, vec![0; 640]).unwrap();
    assert_eq!(frame.sequence(), 1);
    assert_eq!(frame.captured_at_mono_ns(), 99);
    assert_eq!(frame.sample_rate_hz(), 16_000);
    assert_eq!(frame.channels(), 1);
    assert_eq!(frame.payload().len(), 640);

    let value = serde_json::to_value(&frame).unwrap();
    assert_eq!(value["encoding"], "pcm_s16le");
    assert_eq!(
        serde_json::from_value::<PcmAudioFrame>(value).unwrap(),
        frame
    );

    assert_eq!(
        PcmAudioFrame::try_new(0, 1, 16_000, 1, vec![0; 640]),
        Err(SpeechContractError::InvalidAudioFrame),
    );
    assert_eq!(
        PcmAudioFrame::try_new(1, 0, 16_000, 1, vec![0; 640]),
        Err(SpeechContractError::InvalidAudioFrame),
    );
    assert_eq!(
        PcmAudioFrame::try_new(1, 1, 44_100, 1, vec![0; 640]),
        Err(SpeechContractError::UnsupportedSampleRate),
    );
    assert_eq!(
        PcmAudioFrame::try_new(1, 1, 16_000, 3, vec![0; 640]),
        Err(SpeechContractError::UnsupportedChannels),
    );
    assert_eq!(
        PcmAudioFrame::try_new(1, 1, 16_000, 1, vec![0; 641]),
        Err(SpeechContractError::InvalidAudioFrame),
    );
    assert_eq!(
        PcmAudioFrame::try_new(1, 1, 48_000, 2, vec![0; 11_524]),
        Err(SpeechContractError::AudioFrameTooLarge),
    );

    let malformed = serde_json::json!({
        "sequence": 1,
        "captured_at_mono_ns": 1,
        "encoding": "pcm_s16le",
        "sample_rate_hz": 16_000,
        "channels": 1,
        "payload": [0, 1, 2]
    });
    assert!(serde_json::from_value::<PcmAudioFrame>(malformed).is_err());

    let oversized = serde_json::json!({
        "sequence": 1,
        "captured_at_mono_ns": 1,
        "encoding": "pcm_s16le",
        "sample_rate_hz": 48_000,
        "channels": 2,
        "payload": vec![0; 11_521]
    });
    assert!(serde_json::from_value::<PcmAudioFrame>(oversized).is_err());
}

#[test]
fn lifecycle_write_outcomes_and_event_kinds_are_closed_wire_values() {
    assert_eq!(
        serde_json::to_string(&SpeechSessionState::PreparedBlocked).unwrap(),
        "\"prepared_blocked\"",
    );
    assert_eq!(
        serde_json::to_string(&AudioWriteOutcome::DroppedOverflow).unwrap(),
        "\"dropped_overflow\"",
    );
    assert_eq!(
        serde_json::to_string(&SpeechRuntimeEventKind::ResponseToolCall).unwrap(),
        "\"response_tool_call\"",
    );
    assert!(serde_json::from_str::<SpeechSessionState>("\"future_state\"").is_err());
    assert!(serde_json::from_str::<SpeechRuntimeEventKind>("\"future_event\"").is_err());
}
