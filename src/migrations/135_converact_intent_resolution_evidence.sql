-- Additive record-only Intent evidence kinds. Authoritative head kinds remain unchanged.
SET LOCAL lock_timeout = '5s';

ALTER TABLE converact_conversation_understanding_records
  DROP CONSTRAINT IF EXISTS converact_conversation_understanding_records_record_kind_check;
ALTER TABLE converact_conversation_understanding_records
  ADD CONSTRAINT converact_conversation_understanding_records_record_kind_check CHECK (
    record_kind IN (
      'intent_observation', 'intent_provider_observation', 'intent_resolution_evidence',
      'emotion_observation', 'emotion_fusion', 'customer_state_snapshot',
      'dialogue_recommendation'
    )
  ) NOT VALID;
ALTER TABLE converact_conversation_understanding_records
  VALIDATE CONSTRAINT converact_conversation_understanding_records_record_kind_check;

ALTER TABLE converact_conversation_understanding_records
  DROP CONSTRAINT IF EXISTS converact_conversation_understanding_records_check;
ALTER TABLE converact_conversation_understanding_records
  ADD CONSTRAINT converact_conversation_understanding_records_check CHECK (
    (record_kind IN (
      'intent_observation', 'intent_provider_observation', 'intent_resolution_evidence'
    ) AND domain = 'intent') OR
    (record_kind IN ('emotion_observation', 'emotion_fusion') AND domain = 'emotion') OR
    (record_kind = 'customer_state_snapshot' AND domain = 'customer_state') OR
    (record_kind = 'dialogue_recommendation' AND domain = 'dialogue')
  ) NOT VALID;
ALTER TABLE converact_conversation_understanding_records
  VALIDATE CONSTRAINT converact_conversation_understanding_records_check;
