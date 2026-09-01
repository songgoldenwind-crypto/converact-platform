use converact_ai_outbound_core::{SpeechSession, SpeechSessionError};
use converact_voice_agent_contracts::{
    AgentRunId, AudioWriteOutcome, ChannelBindingId, ContextRevision, ExecutionGeneration,
    InteractionId, PcmAudioFrame, ResponseFence, ResponseGeneration, ResponseLease,
    ResponseLeaseGeneration, SpeechControlFence, SpeechResponseId, SpeechSessionBinding,
    SpeechSessionId, SpeechSessionState, TenantId,
};

fn control(value: u64) -> SpeechControlFence {
    SpeechControlFence::new(value).unwrap()
}

fn response_fence(value: u64) -> ResponseFence {
    ResponseFence::new(value).unwrap()
}

fn binding() -> SpeechSessionBinding {
    SpeechSessionBinding::new(
        TenantId::parse("tenant-001").unwrap(),
        InteractionId::parse("interaction-001").unwrap(),
        AgentRunId::parse("agent-run-001").unwrap(),
        SpeechSessionId::parse("speech-session-001").unwrap(),
        ChannelBindingId::parse("channel-binding-001").unwrap(),
        ExecutionGeneration::new(1).unwrap(),
        ExecutionGeneration::new(1).unwrap(),
        control(7),
    )
}

fn lease(response: &str, generation: u64, fence: u64) -> ResponseLease {
    ResponseLease::new(
        SpeechResponseId::parse(response).unwrap(),
        ContextRevision::new(generation).unwrap(),
        ResponseLeaseGeneration::new(generation).unwrap(),
        ResponseGeneration::new(generation).unwrap(),
        response_fence(fence),
    )
}

fn frame(sequence: u64) -> PcmAudioFrame {
    PcmAudioFrame::try_new(sequence, sequence * 20_000_000, 16_000, 1, vec![0; 640]).unwrap()
}

#[test]
fn session_moves_from_blocked_prepare_to_active_response_and_closed() {
    let mut session = SpeechSession::prepare(binding());
    assert_eq!(session.state(), SpeechSessionState::PreparedBlocked);
    assert_eq!(
        session.try_write_audio(control(7), &frame(1), true),
        Err(SpeechSessionError::SessionNotActive),
    );

    session.commit(control(7)).unwrap();
    assert_eq!(session.state(), SpeechSessionState::Active);
    assert_eq!(
        session.try_write_audio(control(7), &frame(1), true),
        Ok(AudioWriteOutcome::Accepted),
    );

    let first = lease("response-001", 1, 11);
    session.create_response(control(7), first.clone()).unwrap();
    assert_eq!(session.current_response(), Some(&first));
    assert!(
        session
            .cancel_response(control(7), response_fence(11))
            .unwrap()
    );
    assert!(
        !session
            .cancel_response(control(7), response_fence(11))
            .unwrap()
    );

    session.close(control(7)).unwrap();
    assert_eq!(session.state(), SpeechSessionState::Closed);
    assert_eq!(
        session.try_write_audio(control(7), &frame(2), true),
        Ok(AudioWriteOutcome::Closed),
    );
    session.close(control(7)).unwrap();
}

#[test]
fn stale_control_and_response_fences_cannot_change_current_authority() {
    let mut session = SpeechSession::prepare(binding());
    assert_eq!(
        session.commit(control(6)),
        Err(SpeechSessionError::StaleControlFence),
    );
    session.commit(control(7)).unwrap();
    assert_eq!(
        session.try_write_audio(control(6), &frame(1), true),
        Err(SpeechSessionError::StaleControlFence),
    );
    assert_eq!(
        session.create_response(control(6), lease("response-001", 1, 11)),
        Err(SpeechSessionError::StaleControlFence),
    );

    session
        .create_response(control(7), lease("response-001", 1, 11))
        .unwrap();
    assert_eq!(
        session.cancel_response(control(7), response_fence(10)),
        Err(SpeechSessionError::StaleResponseFence),
    );
    assert_eq!(
        session.close(control(6)),
        Err(SpeechSessionError::StaleControlFence),
    );
    assert!(session.current_response().is_some());
}

#[test]
fn audio_and_response_generations_never_move_backwards() {
    let mut session = SpeechSession::prepare(binding());
    session.commit(control(7)).unwrap();
    assert_eq!(
        session.try_write_audio(control(7), &frame(1), false),
        Ok(AudioWriteOutcome::DroppedOverflow),
    );
    assert_eq!(
        session.try_write_audio(control(7), &frame(1), true),
        Err(SpeechSessionError::AudioSequenceNotMonotonic),
    );
    assert_eq!(
        session.try_write_audio(control(7), &frame(2), true),
        Ok(AudioWriteOutcome::Accepted),
    );
    let clock_rollback = PcmAudioFrame::try_new(3, 19_000_000, 16_000, 1, vec![0; 640]).unwrap();
    assert_eq!(
        session.try_write_audio(control(7), &clock_rollback, true),
        Err(SpeechSessionError::AudioClockNotMonotonic),
    );

    session
        .create_response(control(7), lease("response-002", 2, 12))
        .unwrap();
    assert!(
        session
            .cancel_response(control(7), response_fence(12))
            .unwrap()
    );
    assert_eq!(
        session.create_response(control(7), lease("response-001", 1, 13)),
        Err(SpeechSessionError::ResponseGenerationNotMonotonic),
    );
    session
        .create_response(control(7), lease("response-003", 3, 13))
        .unwrap();
}
