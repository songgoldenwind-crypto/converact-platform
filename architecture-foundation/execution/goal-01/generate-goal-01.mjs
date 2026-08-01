import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { evaluateMarketGate } from './evaluate-market-gate.mjs';

const goalDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = realpathSync(resolve(goalDirectory, '../../..'));
const generatedAt = '2026-08-01T00:00:00Z';
const goalSha = '736225a0d4c0d8abe2d951b95bf502e81f4dfbbcefce8a8defb81e330b7c5af1';
const g00Commit = 'c10a3a2c636fa0f62f8108a113a729138e367929';

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function sha256File(path) {
  return sha256(readFileSync(path));
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function writeJson(name, value) {
  writeFileSync(join(goalDirectory, name), `${JSON.stringify(value, null, 2)}\n`);
}

function repositoryPath(path) {
  return join(repositoryRoot, path);
}

function assertBinding() {
  const actual = sha256File(repositoryPath('goals/goal-01-product-domain-commercial-gates.md'));
  if (actual !== goalSha) throw new Error(`G01 binding SHA drifted: ${actual}`);
  execFileSync('git', ['merge-base', '--is-ancestor', g00Commit, 'HEAD'], {
    cwd: repositoryRoot,
    stdio: 'ignore',
  });
}

function term(
  termId,
  canonicalName,
  layer,
  classification,
  authority,
  definition,
  invariants,
  forbiddenAliases = [],
  strictSpecializationOf,
) {
  const value = {
    term_id: termId,
    canonical_name: canonicalName,
    layer,
    classification,
    authority,
    definition,
    invariants,
    forbidden_aliases: forbiddenAliases,
  };
  if (strictSpecializationOf) value.strict_specialization_of = strictSpecializationOf;
  return value;
}

function vocabularyContract() {
  return {
    $schema: './ubiquitous-language-v1.schema.json',
    contract_id: 'converact-ubiquitous-language-v1',
    version: '1.0.0',
    generated_at: generatedAt,
    platform_root: 'Engagement',
    status: {
      contract: 'verified_contract',
      runtime_implementation: 'not_run',
      production_eligible: false,
    },
    terms: [
      term('TERM:TENANT', 'Tenant', 'platform', 'platform_boundary', 'Converact Identity', 'Security, policy, data and billing isolation boundary.', ['Every platform object belongs to exactly one Tenant.'], ['Account']),
      term('TERM:ENGAGEMENT', 'Engagement', 'platform', 'platform_root', 'Converact Engage', 'Long-lived, objective-driven unit of governed business execution across interactions.', ['Stable EngagementId across channels.', 'A Profile specializes but never replaces this aggregate.'], ['Call', 'Room', 'Ticket', 'Case', 'Opportunity', 'WorkOrder', 'Resolution']),
      term('TERM:ENGAGEMENT_ITEM', 'EngagementItem', 'platform', 'platform_aggregate_child', 'Converact Engage', 'A separately measurable and verifiable item inside an Engagement.', ['Belongs to one Engagement.', 'Item type is a Profile discriminator, not a new Authority.'], ['Ticket', 'ProblemRecord']),
      term('TERM:ENGAGEMENT_PROFILE', 'EngagementProfile', 'platform', 'profile_contract', 'Converact Product Contract', 'Versioned specialization contract for schema, policy, metrics, UI and dependencies.', ['Cannot own a platform Authority.', 'Failure is scoped to the Profile.'], ['WorkflowTemplate']),
      term('TERM:PROFILE_BINDING', 'ProfileBinding', 'platform', 'platform_aggregate_child', 'Converact Engage', 'Immutable binding from an Engagement to a Profile contract version.', ['Exactly one active Profile version per binding generation.'], []),
      term('TERM:OBJECTIVE', 'Objective', 'platform', 'platform_aggregate_child', 'Converact Engage', 'Versioned intended business result with measurable policy.', ['Does not equal an AI prompt or call disposition.'], ['Prompt']),
      term('TERM:INTERACTION', 'Interaction', 'collaboration', 'collaboration_root', 'Converact Fabric Coordination', 'One continuous participation window that may span communication sessions.', ['Stable across media switches.', 'Does not equal a Call or Room.'], ['Call', 'Room']),
      term('TERM:COMMUNICATION_SESSION', 'CommunicationSession', 'collaboration', 'collaboration_child', 'Converact Fabric Coordination', 'A bounded communication realization linked to native communication Authorities.', ['References, but does not own, Call and Room state.'], ['CallSession', 'Room']),
      term('TERM:TASK', 'Task', 'agent_runtime', 'execution_unit', 'Converact Agent Runtime', 'Leased human or AI work unit with bounded context and handoff.', ['Task execution cannot finalize an Action or Outcome by itself.'], ['AgentRun']),
      term('TERM:EVIDENCE', 'Evidence', 'engage', 'evidence_fact', 'Converact Engage', 'Provenance, consent, retention and integrity-bound observation used by verification.', ['Candidate AI output is not verified Evidence.', 'Evidence is append-only by revision.'], ['Transcript', 'Recording']),
      term('TERM:ACTION', 'Action', 'engage_action', 'action_lifecycle', 'Converact Engage Action Authority', 'Intent, authorization, attempt, receipt, verification and compensation lifecycle for an external effect.', ['Network delivery is not exactly once.', 'Unknown effects require query/reconcile.'], ['ToolCall', 'Webhook']),
      term('TERM:OUTCOME_CLAIM', 'OutcomeClaim', 'engage', 'outcome_fact', 'Converact Engage', 'Versioned claim that an Objective result occurred under a VerificationPolicy.', ['Only Finalized claims may later become billable.', 'Disputes use immutable reversal or credit.'], ['ResolutionStatus', 'ModelAnswer']),
      term('TERM:RESOLUTION', 'Resolution', 'resolve_profile', 'profile_projection', 'Converact Engage', 'Resolve Profile projection of an Engagement.', ['Never the horizontal platform root.', 'Uses the same Engagement Authority.'], ['Engagement'], { term: 'Engagement', discriminator: 'profile_type=resolution' }),
      term('TERM:RESOLUTION_ITEM', 'ResolutionItem', 'resolve_profile', 'profile_projection', 'Converact Engage', 'Resolve Profile projection of a problem EngagementItem.', ['Uses the same EngagementItem Authority.'], ['Ticket'], { term: 'EngagementItem', discriminator: 'item_type=problem' }),
      term('TERM:CALL', 'Call', 'communication', 'external_reference', 'Unified RustPBX or external PBX/CCaaS', 'Telephony business object owned by the selected telephony Authority.', ['Referenced by CommunicationSession; never the platform root.'], ['Engagement']),
      term('TERM:ROOM', 'Room', 'communication', 'external_reference', 'LiveKit', 'WebRTC/SFU runtime room.', ['Referenced by CommunicationSession; never the platform root.'], ['Engagement', 'Interaction']),
      term('TERM:EXTERNAL_CASE', 'ExternalCase', 'overlay', 'external_reference', 'Customer CRM/FSM', 'Formal Case, Ticket or WorkOrder retained by the customer system in Overlay.', ['Converact never mirrors a second formal Authority.'], ['Engagement']),
    ],
  };
}

function authority(domain, writer, executors, externalOverlayAuthority = false) {
  return { domain, writer, writer_count: 1, executors, external_overlay_authority: externalOverlayAuthority };
}

function profileContract() {
  return {
    $schema: './engagement-profile-contract-v1.schema.json',
    contract_id: 'converact-platform-profile-offer-option-v1',
    version: '1.0.0',
    generated_at: generatedAt,
    binding_goal: {
      path: 'goals/goal-01-product-domain-commercial-gates.md',
      sha256: goalSha,
    },
    current_state: {
      document_contract: 'verified_contract',
      runtime_implementation: 'not_run',
      market_qualification: 'not_run',
      production_eligible: false,
      goal_outcome: 'blocked_external',
    },
    platform: {
      root_aggregate: 'Engagement',
      layer_contracts: [
        { layer: 'horizontal_platform', owns: ['upper domain model', 'single authorities', 'stable interfaces', 'evidence discipline'], cannot_own: ['vertical ICP', 'vertical price'], gate: 'platform_contract' },
        { layer: 'engagement_profile', owns: ['namespaced schema', 'policy', 'metrics', 'UI projection', 'profile stop gate'], cannot_own: ['second platform state', 'second authority'], gate: 'profile_contract_and_market' },
        { layer: 'product_offer', owns: ['purchasable scope', 'price', 'acceptance', 'responsibility', 'change order'], cannot_own: ['unqualified roadmap capability'], gate: 'offer_gate' },
        { layer: 'deployment_option', owns: ['qualified delivery and capability selection'], cannot_own: ['implicit authority change'], gate: 'option_and_capability_gate' },
      ],
      authorities: [
        authority('sip_edge', 'Kamailio', ['Unified RustPBX']),
        authority('native_call_leg_dialog_cdr_recording_intent_media_plan', 'Unified RustPBX', ['RTPengine', 'voice-media-rs', 'rvoip low-level adapters']),
        authority('ordinary_rtp_rtcp_srtp', 'RTPengine', ['Unified RustPBX control adapter']),
        authority('decoded_media_mix_capture_ai_tap', 'voice-media-rs', ['codec and DSP backends', 'fenced recording capture worker']),
        authority('recording_manifest_evidence', 'Converact Region Recording Plane', ['voice-media-rs capture worker', 'LiveKit Egress adapter', 'object storage adapter', 'Converact Engage evidence linker']),
        authority('webrtc_room_participant_publication_sfu', 'LiveKit', ['Fabric Coordination']),
        authority('engagement_evidence_outcome', 'Converact Engage', ['Engagement Profile validators']),
        authority('interaction_communication_session_bridge_generation', 'Converact Fabric Coordination', ['communication authorities']),
        authority('agent_run_task_context_handoff_evaluation', 'Converact Agent Runtime', ['bounded agent framework adapters']),
        authority('action_intent_attempt_receipt_verification', 'Converact Engage Action Authority', ['provider and connector executors']),
        authority('external_case_opportunity_workorder_sla', 'Customer CRM/FSM', ['Converact Overlay connector'], true),
      ],
      stable_ids: ['TenantId', 'EngagementId', 'EngagementItemId', 'ProfileBindingId', 'InteractionId', 'CommunicationSessionId', 'TaskId', 'EvidenceId', 'ActionIntentId', 'OutcomeClaimId'],
      stable_invariants: [
        'one writer per authority domain and generation',
        'Profile validators are pure and side-effect free',
        'Call and Room are references, not Engagement aliases',
        'network effects use idempotency plus query/reconcile',
        'AI, recording and connector failure must not terminate established Human Communication',
      ],
    },
    profile_extension: {
      allowed: ['namespaced schema', 'validation policy', 'metrics', 'UI projection', 'connector requirements', 'capability requirements', 'profile-scoped stop gates'],
      forbidden: ['second authority', 'second platform store', 'platform state bypass', 'side effects in validator', 'vertical fields in horizontal core', 'market result propagation to platform'],
      validator_contract: {
        side_effects_allowed: false,
        owns_store: false,
        return_values: ['accept', 'reject', 'defer'],
      },
    },
    resolve_profile: {
      profile_id: 'converact-resolve-v1',
      version: '1.0.0',
      profile_type: 'resolution',
      base_aggregate: 'Engagement',
      item_base_aggregate: 'EngagementItem',
      authority_domains: [],
      schema_namespace: 'profiles.resolve.v1',
      icp: 'Chinese LED display system exporters serving US/English markets with measurable first-installation and commissioning failure cost.',
      budget_owner: 'Service or after-sales executive who owns avoidable dispatch, downtime, rework and expert-wait economics.',
      champion: 'Service operations or digital transformation leader able to align telephony, CRM/FSM and support engineers.',
      jtbd: 'Resolve a US onsite LED display first-installation or commissioning failure through existing phone to no-app video to CN/EN collaboration to Evidence to human-verified acceptance while existing PBX and CRM/FSM retain Authority.',
      product_family_id: 'led-display-system-v1',
      flow_id: 'remote-installation-commissioning-v1',
      flow_version: '1.0.0',
      product_scope: { customer_teams: 1, product_families: 1, agreed_flows: 1 },
      language_pair: ['zh-CN', 'en-US'],
      validator: {
        side_effects_allowed: false,
        owns_store: false,
        return_values: ['accept', 'reject', 'defer'],
      },
    },
    resolve_offer: {
      offer_id: 'resolve-assist-pilot-a-b1-v1',
      profile_contract: 'converact-resolve-v1@1.0.0',
      sales_status: 'not_run',
      payment_percentages: [50, 25, 25],
      market_validation_signature: {
        commercial_evidence_state: 'not_run',
        conditional_signature_permitted: true,
        counts_toward_market_gate: true,
        activates_delivery: false,
        pre_signature_requires: ['platform contract gate', 'resolve profile contract gate', 'ICP/flow/value/budget/data qualification', 'fixed A+B1 order form', 'procurement path and expiry'],
        activation_requires: ['resolve_market_gate', 'applicable capability gates', 'security and DPA approval', 'runtime production eligibility for contracted scope'],
      },
      pilot: {
        offer_id: 'resolve-assist-pilot-a-b1-v1',
        price_usd: 20000,
        duration_weeks: 12,
        integration_weeks: 2,
        operating_weeks: 8,
        review_weeks: 2,
        max_named_experts: 20,
        max_agreed_eligible_items: 300,
        max_converact_person_days: 20,
        customer_teams: 1,
        product_families: 1,
        agreed_flows: 1,
        phone_adapters: 1,
        crm_fsm_connectors: 1,
        product_family_id: 'led-display-system-v1',
        flow_id: 'remote-installation-commissioning-v1',
        flow_version: '1.0.0',
        milestones: ['A', 'B1'],
        b1: {
          cn_en_captions_text_translation_required: true,
          translated_tts_injection: false,
        },
        service_scope: ['two-week integration', 'eight-week operation', 'two-week review', 'weekly evidence review'],
      },
      out_of_scope: ['second team/product/flow/provider/connector', 'ViLTE', 'Native PBX', 'translated TTS injection', 'remote control', 'autonomous high-risk action', 'B2/B3'],
    },
    option_register: [
      { option_id: 'overlay-existing-pbx-crm-fsm', category: 'deployment', sales_status: 'not_run', eligible_for_pilot: true, required_gates: ['G01 contract', 'G11 selected real connectors'], changes_authority: false },
      { option_id: 'native-converact-pbx', category: 'deployment', sales_status: 'option', eligible_for_pilot: false, required_gates: ['G02', 'G03', 'G04', 'G05', 'G06', 'G08'], changes_authority: false },
      { option_id: 'dedicated-on-prem', category: 'deployment', sales_status: 'option', eligible_for_pilot: false, required_gates: ['security', 'operations', 'capacity', 'unit economics'], changes_authority: false },
      { option_id: 'oem-white-label', category: 'deployment', sales_status: 'option', eligible_for_pilot: false, required_gates: ['brand', 'support', 'supply chain', 'commercial'], changes_authority: false },
      { option_id: 'vilte-operator-av', category: 'capability_and_deployment', sales_status: 'option', eligible_for_pilot: false, required_gates: ['G17 and independent carrier/IMS evidence'], changes_authority: false },
      { option_id: 'resolve-b1-text-translation', category: 'capability', sales_status: 'planned', eligible_for_pilot: true, required_gates: ['G12 speech and translation qualification'], changes_authority: false },
      { option_id: 'translated-tts-injection', category: 'capability', sales_status: 'not_run', eligible_for_pilot: false, required_gates: ['separate safety, experience, latency and market gate'], changes_authority: false },
      { option_id: 'remote-desktop-control', category: 'capability', sales_status: 'option', eligible_for_pilot: false, required_gates: ['authorization, audit, security, support and market'], changes_authority: false },
      { option_id: 'resolve-b2-b3-autonomous-assist', category: 'offer', sales_status: 'not_run', eligible_for_pilot: false, required_gates: ['independent customer conversion, action safety and evaluation'], changes_authority: false },
    ],
    gates: {
      platform_contract: { status: 'verified_contract', satisfied: true, evidence: ['G01 machine contracts', 'G01 focused tests', 'G01 rule-based independent review'] },
      resolve_profile_contract: { status: 'verified_contract', satisfied: true, evidence: ['fixed ICP/JTBD', 'Pilot A+B1 contract', 'ROI and stop-gate contracts'] },
      resolve_market: { status: 'not_run', satisfied: false, evidence: [] },
    },
    non_propagation: [
      'Platform contract completion is not Resolve market qualification.',
      'Resolve contract completion is not production eligibility.',
      'A Profile stop decision does not invalidate the Horizontal Platform.',
      'An Option failure does not change platform Authority.',
    ],
  };
}

function marketEvidenceRegister() {
  const register = {
    $schema: './interview-and-demand-evidence-register.schema.json',
    register_id: 'resolve-market-evidence-v1',
    version: '1.0.0',
    generated_at: generatedAt,
    scope: {
      profile_id: 'converact-resolve-v1',
      offer_id: 'resolve-assist-pilot-a-b1-v1',
      product_family_id: 'led-display-system-v1',
      flow_id: 'remote-installation-commissioning-v1',
      flow_version: '1.0.0',
      icp: 'Chinese LED display system exporters serving US/English first-installation and commissioning flows',
      same_flow_required: true,
    },
    synthetic_data_allowed: false,
    privacy_contract: {
      git_content: 'Non-reversible organization/interviewee pseudonyms, evidence metadata, hashes and controlled-store references only.',
      controlled_store_required: true,
      prohibited_in_git: ['personal names', 'email', 'phone', 'contract body', 'credentials', 'customer confidential values'],
      integrity: 'SHA-256 of controlled evidence plus immutable review revision.',
    },
    qualification_thresholds: {
      qualifying_interviews: 20,
      signed_usd_20000_pilots: 1,
      additional_time_bound_paid_commitments: 2,
      distinct_organizations: 3,
    },
    interviews: [],
    paid_commitments: [],
  };
  const evaluated = evaluateMarketGate(register, { asOf: generatedAt });
  return { ...register, summary: evaluated.summary, market_gate: evaluated.market_gate };
}

function source(sourceId, subject, url, reviewedSections, usageLimit, extras = {}) {
  return {
    source_id: sourceId,
    subject,
    url,
    source_tier: 'official_primary',
    captured_at: generatedAt,
    reviewed_sections: reviewedSections,
    usage_limit: usageLimit,
    used_as_converact_performance_evidence: false,
    ...extras,
  };
}

function claim(claimId, layer, subject, claimType, statement, sourceIds, extras = {}) {
  return {
    claim_id: claimId,
    layer,
    subject,
    claim_type: claimType,
    statement,
    source_ids: sourceIds,
    inference_basis: extras.inferenceBasis ?? '',
    proven: extras.proven ?? claimType === 'public_fact',
    status: extras.status ?? (claimType === 'public_fact' ? 'publicly_documented' : 'not_run'),
    required_evidence: extras.requiredEvidence ?? [],
    usage_limit: extras.usageLimit ?? 'Does not prove Converact capability, performance, market demand or superiority.',
  };
}

function competitiveSourceRegister() {
  const sources = [
    source('SRC:GENESYS:CLOUD', 'Genesys Cloud CX', 'https://www.genesys.com/genesys-cloud', ['voice, digital, AI, journey and workforce engagement capability overview'], 'Vendor capability statement only.'),
    source('SRC:ZOOM:CONTACT_CENTER', 'Zoom Contact Center', 'https://www.zoom.com/en/products/contact-center/', ['phone, video, email, chat, SMS, social, AI and WEM overview'], 'Vendor capability and packaging statement only.'),
    source('SRC:TWILIO:CPAAS', 'Twilio CPaaS', 'https://www.twilio.com/en-us/cpaas', ['communications API and channel overview'], 'Vendor capability statement only; no scale or performance claim is inherited.'),
    source('SRC:LIVEKIT:TELEPHONY', 'LiveKit Telephony', 'https://docs.livekit.io/telephony/', ['supported SIP features, service architecture'], 'Current official documentation; dynamic page must be re-captured before implementation.'),
    source('SRC:LIVEKIT:AGENTS', 'LiveKit Agents', 'https://docs.livekit.io/agents/', ['framework and model integration overview'], 'Framework capability statement only.'),
    source('SRC:LIVEKIT:ABOUT', 'LiveKit platform', 'https://docs.livekit.io/intro/about/', ['open-source SFU and realtime platform overview'], 'Architecture statement only; no borrowed scale claim.'),
    source('SRC:SIGHTCALL:RVS', 'SightCall Remote Visual Support', 'https://sightcall.com/platform/remote-visual-support-2026/', ['live video, AR, no-app join, evidence and integrations'], 'Vendor capability statement; published outcome percentages are excluded.'),
    source('SRC:TECHSEE:FIELD', 'TechSee Live for Field Services', 'https://techsee.com/techsee-live-field-services/', ['AI-powered visual assistance and remote technician support'], 'Vendor capability statement only.'),
    source('SRC:CAREAR:ASSIST', 'CareAR Assist', 'https://carear.com/assist-demo', ['AR remote assistance, live video and annotations'], 'Vendor capability statement only.'),
    source('SRC:SALESFORCE:SERVICE', 'Salesforce Service Cloud', 'https://www.salesforce.com/service/cloud/guide/', ['case, omnichannel, knowledge, voice and field service overview'], 'Vendor capability statement; published ROI is excluded.'),
    source('SRC:SALESFORCE:FIELD', 'Salesforce Field Service', 'https://www.salesforce.com/service/field-service-management/guide/', ['scheduling, mobile, asset, inventory and work-order overview'], 'Vendor capability statement only.'),
    source('SRC:SERVICENOW:CSM', 'ServiceNow Customer Service Management', 'https://www.servicenow.com/products/customer-service-management.html', ['case, agent workspace, workflow, knowledge and AI overview'], 'Vendor capability statement only.'),
    source('SRC:SERVICENOW:FSM', 'ServiceNow Field Service Management', 'https://www.servicenow.com/docs/en-US/bundle/zurich-field-service-management/page/product/field-service-management/concept/fsm-application-landing-page.html', ['dispatcher, technician and mobile field-service overview'], 'Official product documentation only.'),
    source('SRC:SIERRA:AGENT', 'Sierra Agent', 'https://sierra.ai/product/meet-your-agent', ['phone, chat, SMS, email, multilingual action, handoff and studio overview'], 'Vendor capability statement only; outcome claims are excluded.'),
    source('SRC:DECAGON:AGENT', 'Decagon Agent', 'https://decagon.ai/product/overview', ['chat, voice, email, integration, guardrail, testing, versioning and observability overview'], 'Vendor capability statement only; outcome claims are excluded.'),
    source('SRC:HF:S2S', 'Hugging Face speech-to-speech', 'https://github.com/huggingface/speech-to-speech', ['README modular VAD-STT-LLM-TTS pipeline, swappable backends and Realtime-compatible API'], 'Repository README and license are availability evidence only; performance must be reproduced.'),
    source('SRC:LIVEKIT:AGENTS_REPO', 'LiveKit Agents source', 'https://github.com/livekit/agents', ['open-source framework repository'], 'Repository existence and source review entry only.'),
    source('SRC:ACTIVE_CALL:PIN', 'Active Call source', 'https://github.com/miuda-ai/active-call/tree/a5c7a88490b65975c0b0ae2787311c49022d4a8d', ['README capabilities and Cargo package metadata at immutable commit'], 'Source identity and declared metadata only. The LICENSE body is absent at this revision; no integration or performance conclusion is authorized.', {
      repository_url: 'https://github.com/miuda-ai/active-call',
      immutable_revision: 'a5c7a88490b65975c0b0ae2787311c49022d4a8d',
      declared_license: 'MIT',
      license_body_status: 'missing_at_revision',
      source_hash_status: 'not_run',
      integration_status: 'not_run',
      performance_status: 'not_run',
    }),
    source('SRC:RUSTPBX:REPO', 'RustPBX source', 'https://github.com/restsend/rustpbx', ['PBX repository overview'], 'Candidate source only; exact commit, license, security and performance remain gated.'),
    source('SRC:RVOIP:REPO', 'rvoip source', 'https://github.com/eisenzopf/rvoip', ['SIP, media and session workspace overview'], 'Candidate source only; exact slices and same-source tests remain gated.'),
  ];

  const claims = [
    claim('CLAIM:FACT:GENESYS', 'platform_market', 'Genesys', 'public_fact', 'Genesys publicly presents Cloud CX as a platform spanning voice, digital, AI, journey and workforce engagement.', ['SRC:GENESYS:CLOUD']),
    claim('CLAIM:FACT:ZOOM', 'platform_market', 'Zoom', 'public_fact', 'Zoom publicly presents Contact Center with phone, video, digital channels, AI assistance and workforce/quality capabilities.', ['SRC:ZOOM:CONTACT_CENTER']),
    claim('CLAIM:FACT:TWILIO', 'platform_market', 'Twilio', 'public_fact', 'Twilio publicly presents CPaaS APIs for embedding messaging, voice, video, email and verification into applications.', ['SRC:TWILIO:CPAAS']),
    claim('CLAIM:FACT:LIVEKIT_SIP_VIDEO', 'component', 'LiveKit', 'public_fact', 'LiveKit Telephony currently documents Video over SIP as not supported while listing DTMF, transfer, RTP and SRTP support.', ['SRC:LIVEKIT:TELEPHONY']),
    claim('CLAIM:FACT:LIVEKIT_AGENTS', 'component', 'LiveKit Agents', 'public_fact', 'LiveKit Agents documents model interfaces for STT, LLM, TTS and realtime speech-to-speech paths.', ['SRC:LIVEKIT:AGENTS', 'SRC:LIVEKIT:AGENTS_REPO']),
    claim('CLAIM:FACT:LIVEKIT_SFU', 'component', 'LiveKit', 'public_fact', 'LiveKit documents its server as an open-source WebRTC SFU and realtime platform.', ['SRC:LIVEKIT:ABOUT']),
    claim('CLAIM:FACT:SIGHTCALL', 'resolve_market', 'SightCall', 'public_fact', 'SightCall publicly offers no-app remote visual support with video, AR guidance, evidence capture and enterprise integrations.', ['SRC:SIGHTCALL:RVS']),
    claim('CLAIM:FACT:TECHSEE', 'resolve_market', 'TechSee', 'public_fact', 'TechSee publicly offers AI-powered visual assistance for field service and remote technicians.', ['SRC:TECHSEE:FIELD']),
    claim('CLAIM:FACT:CAREAR', 'resolve_market', 'CareAR', 'public_fact', 'CareAR publicly offers AR remote assistance with live video and annotations.', ['SRC:CAREAR:ASSIST']),
    claim('CLAIM:FACT:SALESFORCE', 'platform_market', 'Salesforce', 'public_fact', 'Salesforce publicly provides Case, omnichannel service, knowledge, voice and field-service workflows.', ['SRC:SALESFORCE:SERVICE', 'SRC:SALESFORCE:FIELD']),
    claim('CLAIM:FACT:SERVICENOW', 'platform_market', 'ServiceNow', 'public_fact', 'ServiceNow publicly provides CSM case/workflow/agent workspace and FSM operations.', ['SRC:SERVICENOW:CSM', 'SRC:SERVICENOW:FSM']),
    claim('CLAIM:FACT:SIERRA', 'platform_market', 'Sierra', 'public_fact', 'Sierra publicly presents an enterprise agent spanning phone, chat, SMS and email with actions, handoff and a studio.', ['SRC:SIERRA:AGENT']),
    claim('CLAIM:FACT:DECAGON', 'platform_market', 'Decagon', 'public_fact', 'Decagon publicly presents chat, voice and email agents with integrations, guardrails, testing, versioning and observability.', ['SRC:DECAGON:AGENT']),
    claim('CLAIM:FACT:HF_S2S', 'component', 'Hugging Face speech-to-speech', 'public_fact', 'The official repository describes a modular VAD→STT→LLM→TTS pipeline with swappable backends and a Realtime-compatible interface.', ['SRC:HF:S2S']),
    claim('CLAIM:FACT:ACTIVE_CALL', 'component', 'Active Call', 'public_fact', 'At the pinned commit, Active Call is a Rust SIP/WebRTC voice-agent crate whose README documents traditional and realtime speech paths, Playbooks, telephony actions and media processing; Cargo metadata declares version 0.3.75 and MIT.', ['SRC:ACTIVE_CALL:PIN']),
    claim('CLAIM:FACT:RUST_CANDIDATES', 'component', 'RustPBX and rvoip', 'public_fact', 'RustPBX and rvoip have public source repositories that can be evaluated as candidates.', ['SRC:RUSTPBX:REPO', 'SRC:RVOIP:REPO']),
    claim('CLAIM:INFERENCE:CCAAS_BUDGET', 'platform_market', 'Enterprise CCaaS', 'converact_inference', 'Genesys and Zoom compete for broad contact-center budgets; Converact should integrate or coexist before attempting full-suite replacement.', ['SRC:GENESYS:CLOUD', 'SRC:ZOOM:CONTACT_CENTER'], { inferenceBasis: 'Their official scope includes broad channel, routing, AI and workforce capabilities beyond the fixed Resolve Pilot.', proven: false }),
    claim('CLAIM:INFERENCE:CPAAS_PARTNER', 'platform_market', 'CPaaS', 'converact_inference', 'Twilio represents a communications API and carrier integration layer that Converact should buy, partner with or wrap rather than treat as Engagement Authority.', ['SRC:TWILIO:CPAAS'], { inferenceBasis: 'The documented product scope is API-based channel execution, while Converact owns cross-channel Engagement, Evidence, Action and Outcome semantics.', proven: false }),
    claim('CLAIM:INFERENCE:ENTERPRISE_AGENT', 'platform_market', 'Enterprise AI Agent', 'converact_inference', 'Sierra and Decagon compete for enterprise agent automation budgets, so Converact cannot claim differentiation from channels, tools, handoff or framework features alone.', ['SRC:SIERRA:AGENT', 'SRC:DECAGON:AGENT'], { inferenceBasis: 'Their official product descriptions already include multiple channels, actions, handoff or governance tooling; Converact differentiation must be tested on the same high-value Resolution flow.', proven: false }),
    claim('CLAIM:INFERENCE:CRM_AUTHORITY', 'platform_market', 'CRM/FSM', 'converact_inference', 'Salesforce and ServiceNow should remain formal Case/WorkOrder Authorities in the initial Overlay Offer.', ['SRC:SALESFORCE:SERVICE', 'SRC:SERVICENOW:CSM'], { inferenceBasis: 'Their official product scope centers on formal service records and workflows; duplicating them creates a second Authority.', proven: false }),
    claim('CLAIM:INFERENCE:VISUAL_DIRECT', 'resolve_market', 'Visual support vendors', 'converact_inference', 'SightCall, TechSee and CareAR are direct Resolve alternatives for visual remote support, but Converact differentiation remains a hypothesis.', ['SRC:SIGHTCALL:RVS', 'SRC:TECHSEE:FIELD', 'SRC:CAREAR:ASSIST'], { inferenceBasis: 'Their published capability overlaps no-app/live visual guidance; same-flow buyer win/loss evidence is absent.', proven: false }),
    claim('CLAIM:INFERENCE:LIVEKIT_PARTNER', 'component', 'LiveKit', 'converact_inference', 'LiveKit is a Room/WebRTC/SFU execution partner or component, not Converact Engagement or telephony business Authority.', ['SRC:LIVEKIT:TELEPHONY', 'SRC:LIVEKIT:ABOUT'], { inferenceBasis: 'LiveKit documents Room/Participant/SFU primitives and SIP bridging, while Converact owns cross-system business continuity.', proven: false }),
    claim('CLAIM:INFERENCE:HF_CANDIDATE', 'component', 'Hugging Face speech-to-speech', 'converact_inference', 'HF speech-to-speech is a candidate to replace only overlapping SpeechRuntime stages; it is not presumed faster or more accurate.', ['SRC:HF:S2S', 'SRC:LIVEKIT:AGENTS'], { inferenceBasis: 'Both expose overlapping speech loops, but no Converact same-source benchmark exists.', proven: false }),
    claim('CLAIM:INFERENCE:ACTIVE_ADAPTER', 'component', 'Active Call', 'converact_inference', 'Converact should evaluate only Active Call capabilities that fit a pure PCM and canonical-event adapter, while RustPBX remains the sole SIP, RTP control, Call and telephony billing Authority.', ['SRC:ACTIVE_CALL:PIN'], { inferenceBasis: 'The pinned upstream includes overlapping SIP, WebRTC, media and speech execution as well as useful Playbook and telephony-agent semantics; adopting it wholesale would duplicate Converact Authorities.', proven: false, requiredEvidence: ['LICENSE body and notice resolution', 'dependency, unsafe and FFI inventory', 'capability-level keep-wrap-rewrite-reject matrix', 'same-workload quality, latency, capacity and failure tests'], usageLimit: 'A pinned identity proves only provenance; it does not authorize source absorption or prove Converact performance.' }),
    claim('CLAIM:TEST:RESOLVE_WIN_LOSS', 'resolve_market', 'Resolve differentiation', 'converact_test_requirement', 'Run auditable same-flow buyer evaluations and win/loss interviews against current phone/video/CRM/FSM alternatives.', [], { requiredEvidence: ['same ICP and flow', 'buyer-owned baseline', 'decision and budget evidence', 'competitor or status-quo alternative'], status: 'not_run' }),
    claim('CLAIM:TEST:SPEECH_PARITY', 'component', 'SpeechRuntime candidates', 'converact_test_requirement', 'Compare HF, retained LiveKit Agents functions and any pinned Active Call overlap on identical audio, language, hardware, network, turn definitions, quality and total cost.', [], { requiredEvidence: ['exact commits/models', 'identical corpus and seeds', 'VAD false accept/reject', 'first stable partial', 'first audible audio', 'long-session and failure evidence'], status: 'not_run' }),
    claim('CLAIM:TEST:RUST_SLICES', 'component', 'RustPBX/rvoip absorption', 'converact_test_requirement', 'Evaluate exact low-level slices without creating duplicate SIP, RTP, media or business Authorities.', [], { requiredEvidence: ['exact commits and licenses', 'source and dependency security review', 'same-function benchmarks', 'fault/recovery tests', 'migration and active-zero deletion plan'], status: 'not_run' }),
    claim('CLAIM:TEST:PLATFORM_COMPETITION', 'platform_market', 'Platform competition', 'converact_test_requirement', 'Test whether the horizontal platform wins a defined budget without borrowing Resolve outcomes or feature-count parity.', [], { requiredEvidence: ['profile-specific buyer evidence', 'build/buy/partner cost', 'integration burden', 'measurable outcome and no-bid threshold'], status: 'not_run' }),
  ];

  return {
    $schema: './competitive-source-register-v1.schema.json',
    register_id: 'g01-competitive-source-register-v1',
    version: '1.0.0',
    generated_at: generatedAt,
    fact_policy: 'Official public facts, Converact inferences and Converact test requirements are separate and cannot upgrade each other.',
    sources,
    claims,
  };
}

const directOutcomeArtifacts = {
  1: ['product-domain-contract.md', 'platform-profile-offer-option-contract.md', 'engagement-profile-contract-v1.json'],
  2: ['ubiquitous-language-v1.json', 'product-domain-contract.md'],
  3: ['product-domain-contract.md', 'engagement-profile-contract-v1.json'],
  4: ['authority-and-user-journey.md', 'engagement-profile-contract-v1.json'],
  5: ['pilot-scope-and-acceptance-contract.md', 'engagement-profile-contract-v1.json'],
  6: ['pilot-scope-and-acceptance-contract.md', 'roi-unit-economics-model.md'],
  7: ['platform-profile-offer-option-contract.md', 'commercial-stop-gates.md'],
  8: ['market-evidence-protocol.md', 'interview-and-demand-evidence-register.json'],
  9: ['roi-unit-economics-model.md', 'evaluate-roi.mjs'],
  10: ['commercial-stop-gates.md'],
  11: ['platform-market-and-competitive-map.md', 'competitive-and-build-buy-partner-review.md', 'competitive-source-register-v1.json'],
};

function artifactPaths(names) {
  return names.map((name) => name.startsWith('../goal-00/')
    ? `architecture-foundation/execution/goal-00/${name.slice('../goal-00/'.length)}`
    : `architecture-foundation/execution/goal-01/${name}`);
}

function traceRow(requirementId, sourceId, sourceRequirementId, requirement, gate, disposition, evidenceStatus, names) {
  return {
    requirement_id: requirementId,
    source_id: sourceId,
    source_requirement_id: sourceRequirementId,
    requirement,
    gate,
    disposition,
    evidence_status: evidenceStatus,
    production_eligible: false,
    artifacts: artifactPaths(names),
  };
}

function traceabilityContract() {
  const g00 = readJson(repositoryPath('architecture-foundation/execution/goal-00/requirement-traceability-v1.json'));
  const g00Rows = g00.requirements.filter((row) => row.target_goals?.includes('G01')).map((row) => {
    const legacy = row.source_id === 'LEGACY_LOCAL_CHANGES';
    const resolve = row.source_id === 'RESOLVE_R1';
    const names = legacy
      ? ['product-domain-contract.md', '../goal-00/workspace-inventory-v1.json']
      : resolve
        ? ['authority-and-user-journey.md', 'pilot-scope-and-acceptance-contract.md']
        : ['product-domain-contract.md', 'platform-profile-offer-option-contract.md'];
    return traceRow(
      `G01:FROM_G00:${row.requirement_id}`,
      'G00_TRACE',
      row.requirement_id,
      row.requirement,
      legacy ? 'preservation_boundary' : resolve ? 'resolve_profile_contract' : 'platform_contract',
      legacy ? 'preserve_read_only_no_migration' : 'implemented_in_contract',
      legacy ? 'preserved_read_only' : 'verified_contract',
      names,
    );
  });

  const outcomes = [
    'Freeze Platform/Profile/Offer/Deployment Option four-layer contract.',
    'Freeze Engagement upper model and Resolution strict specialization.',
    'Freeze Native/Overlay Authority, Profile extension, degradation and AI/human boundaries.',
    'Freeze one Resolve ICP, buyers, users, JTBD, product family, language pair and main flow.',
    'Freeze fixed 12-week USD 20k Pilot A+B1 scope and limits.',
    'Freeze objective Pilot metrics, baseline, eligibility, sampling, attribution, dispute and verification.',
    'Freeze sales vocabulary, no-bid/partner, change order and unavailable scope.',
    'Establish real-market evidence protocol without fabricating evidence.',
    'Establish ROI and unit-economics model including real costs and reversals.',
    'Freeze Profile-scoped stop gates without invalidating the Horizontal Platform.',
    'Freeze two-layer competition and Build/Absorb/Buy/Partner baseline.',
  ].map((requirement, index) => traceRow(
    `G01:OUTCOME:${String(index + 1).padStart(2, '0')}`,
    'G01_GOAL',
    `required-outcome-${index + 1}`,
    requirement,
    index + 1 === 8 ? 'resolve_market_protocol' : index + 1 >= 4 ? 'resolve_profile_contract' : 'platform_contract',
    'implemented_in_contract',
    'verified_contract',
    directOutcomeArtifacts[index + 1],
  ));

  const workOrderDefinitions = [
    ['Extract from G00 trace, Platform R2 and Resolve R1 without adding a parallel Offer.', 'verified_contract', ['traceability-v1.json']],
    ['Freeze Platform/Profile/Offer/Option, language and Authority first.', 'verified_contract', ['product-domain-contract.md', 'platform-profile-offer-option-contract.md']],
    ['Freeze Resolve Pilot and Evidence schema without leaking after-sales fields into horizontal core.', 'verified_contract', ['engagement-profile-contract-v1.json', 'market-evidence-protocol.md']],
    ['Validate schemas and metric formula with synthetic non-market fixtures.', 'verified_contract', ['goal-01-contract.test.mjs', 'evaluate-roi.mjs', 'evaluate-market-gate.mjs', 'tdd-evidence.md']],
    ['Execute real interviews/paid validation or record the exact external blocker.', 'not_run', ['interview-and-demand-evidence-register.json']],
    ['Update ICP/scope/no-bid from real evidence with version and reason.', 'not_run', ['market-evidence-protocol.md']],
    ['Independently review extensibility, isolation, sellability, measurability, privacy and customization risk.', 'verified_contract', ['independent-review.md']],
  ];
  const workOrders = workOrderDefinitions.map(([requirement, status, names], index) => traceRow(
    `G01:WORK_ORDER:${String(index + 1).padStart(2, '0')}`,
    'G01_GOAL',
    `work-order-${index + 1}`,
    requirement,
    index >= 4 && index <= 5 ? 'resolve_market' : 'program',
    status === 'not_run' ? 'external_evidence_required' : 'implemented_in_contract',
    status,
    names,
  ));

  const acceptance = [
    ['PLATFORM', 1, 'Platform/Profile/Offer/Option boundary, Engagement upper model and single Authority are unambiguous.', 'verified_contract', ['product-domain-contract.md', 'engagement-profile-contract-v1.json']],
    ['PLATFORM', 2, 'Resolution is a Profile and cannot bypass platform state.', 'verified_contract', ['ubiquitous-language-v1.json', 'engagement-profile-contract-v1.json']],
    ['PLATFORM', 3, 'Communication, Speech, Agent, Action, Evidence and Options can be qualified behind stable interfaces.', 'verified_contract', ['product-domain-contract.md']],
    ['PLATFORM', 4, 'Platform competition and Resolve win/no-bid remain separate.', 'verified_contract', ['platform-market-and-competitive-map.md']],
    ['PLATFORM', 5, 'Machine contracts, schemas, trace and links validate.', 'verified_contract', ['goal-01-contract.test.mjs']],
    ['RESOLVE', 1, 'One ICP/JTBD/main flow and one Pilot contract have no Authority ambiguity.', 'verified_contract', ['authority-and-user-journey.md', 'pilot-scope-and-acceptance-contract.md']],
    ['RESOLVE', 2, 'Milestone A/B1, ROI, Outcome, degradation and change order are objectively testable.', 'verified_contract', ['pilot-scope-and-acceptance-contract.md', 'roi-unit-economics-model.md']],
    ['RESOLVE', 3, 'Competition distinguishes fact, inference and Converact tests and yields win/no-bid/partner decisions.', 'verified_contract', ['competitive-source-register-v1.json', 'competitive-and-build-buy-partner-review.md']],
    ['MARKET', 1, 'At least 20 auditable target buyer/Champion interviews.', 'not_run', ['interview-and-demand-evidence-register.json']],
    ['MARKET', 2, 'Three organizations validate one flow: one signed Pilot plus two time-bound paid commitments.', 'not_run', ['interview-and-demand-evidence-register.json']],
    ['MARKET', 3, 'Value pool, budget and data availability exist in real evidence.', 'not_run', ['interview-and-demand-evidence-register.json']],
    ['MARKET', 4, 'Vendor benchmarks, demos and internal opinions do not substitute buyer evidence.', 'not_run', ['market-evidence-protocol.md']],
  ].map(([family, number, requirement, status, names]) => traceRow(
    `G01:ACCEPTANCE:${family}:${String(number).padStart(2, '0')}`,
    'G01_GOAL',
    `acceptance-${family.toLowerCase()}-${number}`,
    requirement,
    family === 'PLATFORM' ? 'platform_contract' : family === 'RESOLVE' ? 'resolve_profile_contract' : 'resolve_market',
    status === 'not_run' ? 'external_evidence_required' : 'implemented_in_contract',
    status,
    names,
  ));

  const gates = [
    traceRow('G01:GATE:PLATFORM_CONTRACT', 'G01_GOAL', 'platform-contract-gate', 'Platform Contract Gate.', 'platform_contract', 'gate_evaluated', 'verified_contract', ['independent-review.md', 'goal-01-contract.test.mjs']),
    traceRow('G01:GATE:RESOLVE_PROFILE_CONTRACT', 'G01_GOAL', 'resolve-profile-contract-gate', 'Resolve Profile Contract Gate.', 'resolve_profile_contract', 'gate_evaluated', 'verified_contract', ['independent-review.md', 'goal-01-contract.test.mjs']),
    traceRow('G01:GATE:RESOLVE_MARKET', 'G01_GOAL', 'resolve-market-gate', 'Resolve Market Gate.', 'resolve_market', 'external_evidence_required', 'not_run', ['interview-and-demand-evidence-register.json']),
  ];

  const nonGoals = [
    'Do not build generic CCaaS, low-code Studio, multi-Agent market or full CRM/FSM in G01.',
    'Do not select multiple phone providers, CRMs or launch industries.',
    'Do not develop communication, AI, Connector or UI.',
    'Do not promise ViLTE, Native PBX, remote control, generic Vision or autonomous high-risk actions.',
    'Do not use broad platform ambition to bypass Profile market validation.',
  ].map((requirement, index) => traceRow(
    `G01:NON_GOAL:${String(index + 1).padStart(2, '0')}`,
    'G01_GOAL',
    `non-goal-${index + 1}`,
    requirement,
    'program',
    'excluded_by_contract',
    'verified_contract',
    ['2026-07-31-goal-01-product-commercial-plan.md'],
  ));

  const rows = [...g00Rows, ...outcomes, ...workOrders, ...acceptance, ...gates, ...nonGoals];
  const marketVerified = rows.filter((row) => row.gate === 'resolve_market' && row.evidence_status === 'verified_contract').length;
  return {
    $schema: './traceability-v1.schema.json',
    goal_id: 'G01',
    version: '1.0.0',
    generated_at: generatedAt,
    entry_baseline_commit: g00Commit,
    binding_inputs: [
      { path: 'goals/PROGRAM-RULES.md', sha256: sha256File(repositoryPath('goals/PROGRAM-RULES.md')) },
      { path: 'goals/goal-01-product-domain-commercial-gates.md', sha256: goalSha },
      { path: 'goals/manifest.json', sha256: sha256File(repositoryPath('goals/manifest.json')) },
      { path: 'architecture-foundation/execution/goal-00/requirement-traceability-v1.json', sha256: sha256File(repositoryPath('architecture-foundation/execution/goal-00/requirement-traceability-v1.json')) },
    ],
    current_state: 'contract_gates_verified_market_blocked_external',
    goal_outcome: 'blocked_external',
    market_gate_status: 'not_run',
    production_eligible: false,
    rows,
    closure: {
      row_count: rows.length,
      g00_to_g01_row_count: g00Rows.length,
      direct_g01_row_count: rows.length - g00Rows.length,
      unresolved_count: 0,
      verified_contract_count: rows.filter((row) => row.evidence_status === 'verified_contract').length,
      preserved_read_only_count: rows.filter((row) => row.evidence_status === 'preserved_read_only').length,
      not_run_count: rows.filter((row) => row.evidence_status === 'not_run').length,
      market_evidence_rows_verified: marketVerified,
    },
  };
}

function roiFixture(id, description, input) {
  return {
    fixture_id: id,
    evidence_class: 'synthetic_non_market_evidence',
    market_evidence: false,
    description,
    contains_customer_data: false,
    input,
  };
}

function writeRoiFixtures() {
  const commonCosts = {
    carrier_line_sfu_usd: 18000,
    gpu_model_usd: 16000,
    storage_egress_usd: 6000,
    support_sre_usd: 22000,
    implementation_amortized_usd: 10000,
    partner_fees_usd: 8000,
  };
  writeJson('fixtures/roi-qualifying.synthetic.json', roiFixture(
    'ROI:SYNTHETIC:QUALIFYING',
    'Synthetic arithmetic case that crosses contract thresholds; it is not demand, price or market evidence.',
    {
      eligible_annual_items: 1000,
      baseline_avoidable_event_rate: 0.2,
      verified_value_per_avoided_event_usd: 3000,
      primary_value_dedupe_key: 'dispatch:led-installation:annual-baseline-v1',
      additional_value_pools: [
        { pool_id: 'downtime-primary', dedupe_key: 'downtime:asset-window', annual_value_usd: 100000 },
        { pool_id: 'downtime-duplicate-view', dedupe_key: 'downtime:asset-window', annual_value_usd: 70000 },
      ],
      first_year_subscription_usd: 120000,
      first_year_services_usd: 40000,
      first_year_usage_cost_usd: 30000,
      first_year_customer_change_cost_usd: 10000,
      annual_recognized_revenue_usd: 300000,
      credits_usd: 0,
      reversals_usd: 0,
      refunds_usd: 0,
      costs: commonCosts,
      cac_usd: 100000,
    },
  ));
  writeJson('fixtures/roi-no-bid.synthetic.json', roiFixture(
    'ROI:SYNTHETIC:NO_BID',
    'Synthetic case below the 3x value gate and economic thresholds.',
    {
      eligible_annual_items: 200,
      baseline_avoidable_event_rate: 0.1,
      verified_value_per_avoided_event_usd: 2000,
      primary_value_dedupe_key: 'dispatch:led-installation:annual-baseline-v1',
      additional_value_pools: [],
      first_year_subscription_usd: 80000,
      first_year_services_usd: 50000,
      first_year_usage_cost_usd: 30000,
      first_year_customer_change_cost_usd: 40000,
      annual_recognized_revenue_usd: 150000,
      credits_usd: 10000,
      reversals_usd: 0,
      refunds_usd: 0,
      costs: commonCosts,
      cac_usd: 120000,
    },
  ));
  writeJson('fixtures/roi-credit-reversal.synthetic.json', roiFixture(
    'ROI:SYNTHETIC:CREDIT_REVERSAL',
    'Synthetic case proving credits, reversals and refunds reduce recognized revenue and margin.',
    {
      eligible_annual_items: 1000,
      baseline_avoidable_event_rate: 0.25,
      verified_value_per_avoided_event_usd: 3000,
      primary_value_dedupe_key: 'dispatch:led-installation:annual-baseline-v1',
      additional_value_pools: [{ pool_id: 'expert-wait', dedupe_key: 'expert-wait:team-window', annual_value_usd: 50000 }],
      first_year_subscription_usd: 120000,
      first_year_services_usd: 40000,
      first_year_usage_cost_usd: 30000,
      first_year_customer_change_cost_usd: 10000,
      annual_recognized_revenue_usd: 400000,
      credits_usd: 50000,
      reversals_usd: 20000,
      refunds_usd: 10000,
      costs: commonCosts,
      cac_usd: 100000,
    },
  ));
  writeJson('fixtures/roi-zero-denominator.synthetic.json', roiFixture(
    'ROI:SYNTHETIC:ZERO_DENOMINATOR',
    'Synthetic invalid input proving the evaluator fails closed when first-year cost is zero.',
    {
      eligible_annual_items: 100,
      baseline_avoidable_event_rate: 0.2,
      verified_value_per_avoided_event_usd: 1000,
      primary_value_dedupe_key: 'dispatch:led-installation:annual-baseline-v1',
      additional_value_pools: [],
      first_year_subscription_usd: 0,
      first_year_services_usd: 0,
      first_year_usage_cost_usd: 0,
      first_year_customer_change_cost_usd: 0,
      annual_recognized_revenue_usd: 100000,
      credits_usd: 0,
      reversals_usd: 0,
      refunds_usd: 0,
      costs: commonCosts,
      cac_usd: 10000,
    },
  ));
}

assertBinding();
writeJson('ubiquitous-language-v1.json', vocabularyContract());
writeJson('engagement-profile-contract-v1.json', profileContract());
writeJson('interview-and-demand-evidence-register.json', marketEvidenceRegister());
writeJson('competitive-source-register-v1.json', competitiveSourceRegister());
writeJson('traceability-v1.json', traceabilityContract());
writeRoiFixtures();
