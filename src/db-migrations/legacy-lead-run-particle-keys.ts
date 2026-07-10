/**
 * Legacy lead_run_particle_snapshots CHECK constraint whitelist.
 *
 * Used only by db.ts migrations to upgrade in-place sqlite databases
 * that already contain the legacy lead_run_particle_snapshots table.
 * After lead-acquisition module is archived this constant must remain
 * so that existing dev/prod databases can still complete schema upgrade
 * paths without crashing.
 *
 * DO NOT add new keys here. New code should not write to
 * lead_run_particle_snapshots — that table will be retired together
 * with the rest of the lead-acquisition module.
 */
export const LEAD_RUN_PARTICLE_KEYS = [
  'human_feedback_calibration_packet',
  'source_quality_benchmark',
  'mission_autoplay_guard',
  'multi_channel_followup_pack',
  'feedback_action_application_packet',
  'prospect_outreach_writeback_packet',
  'next_batch_learning_profile',
  'next_batch_seed_queue',
  'prospect_outreach_channel_adapter_receipt',
  'prospect_outreach_live_demo_acceptance',
  'public_source_discover_job',
  'writeback_confirmation_packet',
  'discovery_mission_packet',
  'public_source_adapter_packet',
  'generation_state_packet',
  'weekly_founder_brief_packet',
  'founder_decision_writeback_packet',
  'execution_state_machine_snapshot',
  'non_phone_receipt_writeback',
  'wechat_local_import_packet',
  'lead_list_import_packet',
  'ai_script_generation_job',
  'compression_discard_audit'
] as const;

export type LeadRunParticleKey = (typeof LEAD_RUN_PARTICLE_KEYS)[number];
