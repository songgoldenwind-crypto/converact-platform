-- Validate the v2 expand constraints separately from migration 113.
-- PostgreSQL validates CHECK constraints under ShareUpdateExclusiveLock; the
-- brief AccessExclusive expand transaction has already committed, so this
-- scan does not hold the table-wide writer-blocking lock for its duration.

ALTER TABLE ivekit_sip_protocol_effects
  VALIDATE CONSTRAINT ivekit_sip_protocol_effects_state_v2_check;
ALTER TABLE ivekit_sip_protocol_effects
  VALIDATE CONSTRAINT ivekit_sip_protocol_effects_terminal_v2_check;
ALTER TABLE ivekit_sip_effect_receipts
  VALIDATE CONSTRAINT ivekit_sip_effect_receipts_level_v2_check;
ALTER TABLE ivekit_sip_effect_receipts
  VALIDATE CONSTRAINT ivekit_sip_effect_receipts_transition_v2_check;
