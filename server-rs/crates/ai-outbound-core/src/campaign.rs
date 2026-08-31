use converact_voice_agent_contracts::{CampaignId, CampaignState};

use crate::DomainError;

/// Commands accepted by the Campaign authority state machine.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CampaignCommand {
    Schedule,
    Start,
    Pause,
    Resume,
    Drain,
    Complete,
    Cancel,
    Archive,
}

/// A Campaign aggregate with bounded active-attempt accounting.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Campaign {
    id: CampaignId,
    state: CampaignState,
    active_attempts: u32,
    revision: u64,
}

impl Campaign {
    /// Creates a draft Campaign.
    #[must_use]
    pub const fn new(id: CampaignId) -> Self {
        Self {
            id,
            state: CampaignState::Draft,
            active_attempts: 0,
            revision: 1,
        }
    }

    /// Applies one exhaustive Campaign transition.
    ///
    /// # Errors
    ///
    /// Rejects transitions outside the frozen state graph, completion with active Attempts,
    /// and revision overflow.
    pub fn apply(&self, command: CampaignCommand) -> Result<Self, DomainError> {
        let next = match (self.state, command) {
            (CampaignState::Draft, CampaignCommand::Schedule) => CampaignState::Scheduled,
            (CampaignState::Scheduled, CampaignCommand::Start)
            | (CampaignState::Paused, CampaignCommand::Resume) => CampaignState::Running,
            (CampaignState::Running, CampaignCommand::Pause) => CampaignState::Paused,
            (CampaignState::Running | CampaignState::Paused, CampaignCommand::Drain) => {
                CampaignState::Draining
            }
            (CampaignState::Draining, CampaignCommand::Complete) => {
                if self.active_attempts != 0 {
                    return Err(DomainError::ActiveAttemptsRemain);
                }
                CampaignState::Completed
            }
            (
                CampaignState::Draft
                | CampaignState::Scheduled
                | CampaignState::Running
                | CampaignState::Paused
                | CampaignState::Draining,
                CampaignCommand::Cancel,
            ) => CampaignState::Cancelled,
            (CampaignState::Completed | CampaignState::Cancelled, CampaignCommand::Archive)
                if self.active_attempts == 0 =>
            {
                CampaignState::Archived
            }
            _ => return Err(DomainError::InvalidTransition),
        };
        let mut campaign = self.clone();
        campaign.revision = next_revision(campaign.revision)?;
        campaign.state = next;
        Ok(campaign)
    }

    /// Records a newly claimed physical Attempt while the Campaign accepts work.
    ///
    /// # Errors
    ///
    /// Rejects claims outside `running` and active-counter or revision overflow.
    pub fn observe_attempt_started(&self) -> Result<Self, DomainError> {
        if !self.accepts_new_attempts() {
            return Err(DomainError::InvalidTransition);
        }
        let mut campaign = self.clone();
        campaign.active_attempts = campaign
            .active_attempts
            .checked_add(1)
            .ok_or(DomainError::CounterOverflow)?;
        campaign.revision = next_revision(campaign.revision)?;
        Ok(campaign)
    }

    /// Records convergence of one active physical Attempt without changing Campaign state.
    ///
    /// # Errors
    ///
    /// Rejects counter underflow and revision overflow.
    pub fn observe_attempt_finished(&self) -> Result<Self, DomainError> {
        let mut campaign = self.clone();
        campaign.active_attempts = campaign
            .active_attempts
            .checked_sub(1)
            .ok_or(DomainError::InvalidTransition)?;
        campaign.revision = next_revision(campaign.revision)?;
        Ok(campaign)
    }

    /// Returns whether a worker may claim a new Attempt.
    #[must_use]
    pub const fn accepts_new_attempts(&self) -> bool {
        matches!(self.state, CampaignState::Running)
    }

    /// Returns the current active physical Attempt count.
    #[must_use]
    pub const fn active_attempts(&self) -> u32 {
        self.active_attempts
    }

    /// Returns the Campaign state.
    #[must_use]
    pub const fn state(&self) -> CampaignState {
        self.state
    }

    /// Returns the Campaign identifier.
    #[must_use]
    pub const fn id(&self) -> &CampaignId {
        &self.id
    }

    /// Returns the checked aggregate revision.
    #[must_use]
    pub const fn revision(&self) -> u64 {
        self.revision
    }
}

fn next_revision(revision: u64) -> Result<u64, DomainError> {
    revision
        .checked_add(1)
        .ok_or(DomainError::RevisionExhausted)
}
