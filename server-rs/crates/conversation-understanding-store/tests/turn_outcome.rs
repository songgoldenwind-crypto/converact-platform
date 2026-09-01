use converact_conversation_understanding_store::{
    AppendOutcome, UnderstandingStoreError, UnderstandingTurnAppendOutcome,
};

#[test]
fn advanced_and_current_replay_is_one_atomic_applied_graph() {
    assert_eq!(
        UnderstandingTurnAppendOutcome::classify([
            AppendOutcome::HeadAdvanced { head_revision: 2 },
            AppendOutcome::HeadReplay { head_revision: 1 },
            AppendOutcome::HeadAdvanced { head_revision: 2 },
            AppendOutcome::HeadAdvanced { head_revision: 2 },
        ]),
        Ok(UnderstandingTurnAppendOutcome::Applied)
    );
}

#[test]
fn no_write_replay_and_superseded_graphs_are_distinguished() {
    assert_eq!(
        UnderstandingTurnAppendOutcome::classify([
            AppendOutcome::HeadReplay { head_revision: 2 },
            AppendOutcome::HeadReplay { head_revision: 1 },
            AppendOutcome::HeadReplay { head_revision: 2 },
            AppendOutcome::HeadReplay { head_revision: 2 },
        ]),
        Ok(UnderstandingTurnAppendOutcome::Replayed)
    );
    assert_eq!(
        UnderstandingTurnAppendOutcome::classify([
            AppendOutcome::HeadSuperseded {
                current_head_revision: 3,
            },
            AppendOutcome::HeadReplay { head_revision: 1 },
            AppendOutcome::HeadSuperseded {
                current_head_revision: 3,
            },
            AppendOutcome::HeadSuperseded {
                current_head_revision: 3,
            },
        ]),
        Ok(UnderstandingTurnAppendOutcome::Superseded)
    );
}

#[test]
fn a_write_mixed_with_superseded_or_record_only_rolls_back() {
    assert_eq!(
        UnderstandingTurnAppendOutcome::classify([
            AppendOutcome::HeadAdvanced { head_revision: 2 },
            AppendOutcome::HeadSuperseded {
                current_head_revision: 3,
            },
            AppendOutcome::HeadReplay { head_revision: 2 },
            AppendOutcome::HeadReplay { head_revision: 2 },
        ]),
        Err(UnderstandingStoreError::StaleFence)
    );
    assert_eq!(
        UnderstandingTurnAppendOutcome::classify([
            AppendOutcome::HeadReplay { head_revision: 2 },
            AppendOutcome::RecordOnlyReplay,
            AppendOutcome::HeadReplay { head_revision: 2 },
            AppendOutcome::HeadReplay { head_revision: 2 },
        ]),
        Err(UnderstandingStoreError::StoredRowInvalid)
    );
}
