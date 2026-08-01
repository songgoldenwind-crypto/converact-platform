import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';

import Ajv2020 from 'ajv/dist/2020.js';

const goalDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = realpathSync(resolve(goalDirectory, '../../..'));

const contracts = {
  vocabulary: {
    schema: 'ubiquitous-language-v1.schema.json',
    document: 'ubiquitous-language-v1.json',
    invalid: 'fixtures/invalid-ubiquitous-language.json',
  },
  profile: {
    schema: 'engagement-profile-contract-v1.schema.json',
    document: 'engagement-profile-contract-v1.json',
    invalid: 'fixtures/invalid-engagement-profile-contract.json',
  },
  marketEvidence: {
    schema: 'interview-and-demand-evidence-register.schema.json',
    document: 'interview-and-demand-evidence-register.json',
    invalid: 'fixtures/invalid-interview-and-demand-evidence-register.json',
  },
  competitiveSources: {
    schema: 'competitive-source-register-v1.schema.json',
    document: 'competitive-source-register-v1.json',
    invalid: 'fixtures/invalid-competitive-source-register.json',
  },
  traceability: {
    schema: 'traceability-v1.schema.json',
    document: 'traceability-v1.json',
    invalid: 'fixtures/invalid-traceability.json',
  },
};

const requiredMarkdown = [
  '2026-07-31-goal-01-product-commercial-plan.md',
  'product-domain-contract.md',
  'platform-profile-offer-option-contract.md',
  'authority-and-user-journey.md',
  'pilot-scope-and-acceptance-contract.md',
  'market-evidence-protocol.md',
  'roi-unit-economics-model.md',
  'platform-market-and-competitive-map.md',
  'competitive-and-build-buy-partner-review.md',
  'commercial-stop-gates.md',
  'tdd-evidence.md',
  'independent-review.md',
];

const requiredCanonicalTerms = [
  'Engagement',
  'EngagementItem',
  'EngagementProfile',
  'Objective',
  'Interaction',
  'CommunicationSession',
  'Task',
  'Evidence',
  'Action',
  'OutcomeClaim',
  'Resolution',
  'ResolutionItem',
];

const requiredPilot = {
  offer_id: 'resolve-assist-pilot-a-b1-v1',
  price_usd: 20_000,
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
};

const requiredOfficialDomains = new Set([
  'carear.com',
  'decagon.ai',
  'docs.livekit.io',
  'genesys.com',
  'github.com',
  'livekit.com',
  'salesforce.com',
  'sierra.ai',
  'servicenow.com',
  'sightcall.com',
  'techsee.com',
  'twilio.com',
  'zoom.com',
]);

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function compile(schemaName) {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  return ajv.compile(readJson(join(goalDirectory, schemaName)));
}

function assertValid(validate, value, label) {
  assert.equal(
    validate(value),
    true,
    `${label} must validate: ${JSON.stringify(validate.errors)}`,
  );
}

function assertRejectedAt(validate, value, expectedPath, label) {
  assert.equal(validate(value), false, `${label} must be rejected`);
  assert.ok(
    validate.errors?.some((error) => error.instancePath === expectedPath || error.instancePath.startsWith(`${expectedPath}/`)),
    `${label} must fail at ${expectedPath}: ${JSON.stringify(validate.errors)}`,
  );
}

function collectMarkdownLinks(text) {
  return [...text.matchAll(/\[[^\]]*\]\(([^)]+)\)/gu)].map((match) => match[1]);
}

function resolveLocalLink(markdownPath, target) {
  const clean = target.split('#', 1)[0];
  return resolve(dirname(markdownPath), decodeURIComponent(clean));
}

function everyObject(value, visitor, pointer = '') {
  if (Array.isArray(value)) {
    value.forEach((item, index) => everyObject(item, visitor, `${pointer}/${index}`));
    return;
  }
  if (value !== null && typeof value === 'object') {
    visitor(value, pointer);
    for (const [key, item] of Object.entries(value)) {
      everyObject(item, visitor, `${pointer}/${key}`);
    }
  }
}

test('schemas reject their intentionally invalid fixtures before accepting canonical documents', () => {
  for (const [name, paths] of Object.entries(contracts)) {
    const validate = compile(paths.schema);
    const invalid = readJson(join(goalDirectory, paths.invalid));
    assert.equal(validate(invalid), false, `${name} invalid fixture must be rejected`);
    assert.ok(validate.errors?.length, `${name} rejection must expose schema errors`);

    const documentPath = join(goalDirectory, paths.document);
    assert.ok(existsSync(documentPath), `missing required artifact: ${paths.document}`);
    assertValid(validate, readJson(documentPath), paths.document);
  }
});

test('schemas reject one targeted invariant drift at its exact path', () => {
  const vocabulary = readJson(join(goalDirectory, contracts.vocabulary.document));
  const vocabularyValidator = compile(contracts.vocabulary.schema);
  const wrongRoot = structuredClone(vocabulary);
  wrongRoot.platform_root = 'Resolution';
  assertRejectedAt(vocabularyValidator, wrongRoot, '/platform_root', 'Resolution cannot become platform root');

  const profile = readJson(join(goalDirectory, contracts.profile.document));
  const profileValidator = compile(contracts.profile.schema);
  const profileWriter = structuredClone(profile);
  profileWriter.resolve_profile.authority_domains = ['second_resolution_store'];
  assertRejectedAt(profileValidator, profileWriter, '/resolve_profile/authority_domains', 'Profile cannot own an Authority');
  const priceDrift = structuredClone(profile);
  priceDrift.resolve_offer.pilot.price_usd = 19_999;
  assertRejectedAt(profileValidator, priceDrift, '/resolve_offer/pilot/price_usd', 'Pilot price cannot drift');

  const market = readJson(join(goalDirectory, contracts.marketEvidence.document));
  const marketValidator = compile(contracts.marketEvidence.schema);
  const invalidCalendarTimestamp = structuredClone(market);
  invalidCalendarTimestamp.generated_at = '2026-02-30T00:00:00Z';
  assertRejectedAt(marketValidator, invalidCalendarTimestamp, '/generated_at', 'calendar-invalid timestamp');
  const validCommitment = {
    evidence_id: 'COM:SCHEMA_TEST',
    organization_pseudonym: 'ORG-A001',
    linked_interview_evidence_ids: ['INT:SCHEMA_TEST'],
    commitment_type: 'signed_pilot_contract',
    offer_id: 'resolve-assist-pilot-a-b1-v1',
    product_family_id: 'led-display-system-v1',
    flow_id: 'remote-installation-commissioning-v1',
    flow_version: '1.0.0',
    amount_usd: 20_000,
    currency: 'USD',
    payment_percentages: [50, 25, 25],
    scope_milestones: ['A', 'B1'],
    written_commitment: true,
    signed: true,
    written_at: '2026-07-20T00:00:00Z',
    expires_at: '2026-12-31T00:00:00Z',
    controlled_uri: 'controlled://g01-test/schema-commitment',
    sha256: 'c'.repeat(64),
    same_flow: true,
    value_pool_observed: true,
    budget_observed: true,
    data_availability_observed: true,
    reviewer_pseudonyms: ['REV-A1', 'REV-B2'],
    review_status: 'qualified',
  };
  const marketWithCommitment = structuredClone(market);
  marketWithCommitment.paid_commitments = [validCommitment];
  assertValid(marketValidator, marketWithCommitment, 'structurally valid future market register');
  for (const [field, value] of [['amount_usd', 0], ['signed', false], ['flow_id', 'wrong-flow-v1']]) {
    const drift = structuredClone(marketWithCommitment);
    drift.paid_commitments[0][field] = value;
    assertRejectedAt(marketValidator, drift, `/paid_commitments/0/${field}`, `market commitment ${field} drift`);
  }

  const sources = readJson(join(goalDirectory, contracts.competitiveSources.document));
  const sourceValidator = compile(contracts.competitiveSources.schema);
  const unsourcedFact = structuredClone(sources);
  unsourcedFact.claims.find((claim) => claim.claim_type === 'public_fact').source_ids = [];
  assertRejectedAt(sourceValidator, unsourcedFact, '/claims/0/source_ids', 'public fact requires an official source');

  const trace = readJson(join(goalDirectory, contracts.traceability.document));
  const traceValidator = compile(contracts.traceability.schema);
  const evidenceFreeTrace = structuredClone(trace);
  evidenceFreeTrace.rows[0].artifacts = [];
  assertRejectedAt(traceValidator, evidenceFreeTrace, '/rows/0/artifacts', 'trace row requires evidence artifacts');
});

test('every required G01 artifact exists inside the exact Goal boundary', () => {
  const required = [
    ...requiredMarkdown,
    ...Object.values(contracts).flatMap(({ schema, document }) => [schema, document]),
    'evaluate-roi.mjs',
    'evaluate-market-gate.mjs',
    'generate-goal-01.mjs',
  ];
  for (const path of required) {
    assert.ok(existsSync(join(goalDirectory, path)), `missing required G01 artifact: ${path}`);
  }
  assert.equal(
    relative(repositoryRoot, goalDirectory).replaceAll('\\', '/'),
    'architecture-foundation/execution/goal-01',
  );
});

test('ubiquitous language keeps Engagement as root and Resolve as a strict Profile projection', () => {
  const vocabulary = readJson(join(goalDirectory, contracts.vocabulary.document));
  const terms = new Map(vocabulary.terms.map((term) => [term.canonical_name, term]));
  assert.deepEqual([...terms.keys()].filter((name) => requiredCanonicalTerms.includes(name)).sort(), [...requiredCanonicalTerms].sort());
  assert.equal(new Set(vocabulary.terms.map((term) => term.term_id)).size, vocabulary.terms.length);
  assert.equal(vocabulary.platform_root, 'Engagement');
  assert.equal(terms.get('Engagement')?.classification, 'platform_root');
  assert.equal(terms.get('EngagementItem')?.classification, 'platform_aggregate_child');
  assert.deepEqual(terms.get('Resolution')?.strict_specialization_of, {
    term: 'Engagement',
    discriminator: 'profile_type=resolution',
  });
  assert.deepEqual(terms.get('ResolutionItem')?.strict_specialization_of, {
    term: 'EngagementItem',
    discriminator: 'item_type=problem',
  });
  for (const forbiddenRoot of ['Call', 'Room', 'Ticket', 'Case', 'Opportunity', 'WorkOrder', 'Resolution']) {
    assert.notEqual(vocabulary.platform_root, forbiddenRoot);
  }
});

test('Profile, Offer and Option contract has one authority per domain and no Profile writer', () => {
  const contract = readJson(join(goalDirectory, contracts.profile.document));
  assert.equal(contract.platform.root_aggregate, 'Engagement');
  assert.equal(contract.current_state.runtime_implementation, 'not_run');
  assert.equal(contract.current_state.market_qualification, 'not_run');
  assert.equal(contract.current_state.production_eligible, false);
  assert.equal(contract.current_state.goal_outcome, 'blocked_external');

  const domains = contract.platform.authorities.map((entry) => entry.domain);
  assert.equal(new Set(domains).size, domains.length, 'authority domains must be unique');
  assert.ok(contract.platform.authorities.every((entry) => entry.writer_count === 1));
  const authorities = new Map(contract.platform.authorities.map((entry) => [entry.domain, entry]));
  assert.equal(authorities.get('native_call_leg_dialog_cdr_recording_intent_media_plan')?.writer, 'Unified RustPBX');
  assert.equal(authorities.get('recording_manifest_evidence')?.writer, 'Converact Region Recording Plane');
  assert.equal(authorities.get('decoded_media_mix_capture_ai_tap')?.writer, 'voice-media-rs');
  assert.equal(domains.includes('decoded_media_mix_record_ai_tap'), false);
  assert.deepEqual(contract.resolve_profile.authority_domains, []);
  assert.equal(contract.resolve_profile.base_aggregate, 'Engagement');
  assert.equal(contract.resolve_profile.item_base_aggregate, 'EngagementItem');
  assert.equal(contract.resolve_profile.profile_type, 'resolution');
  assert.equal(contract.resolve_profile.product_family_id, 'led-display-system-v1');
  assert.equal(contract.resolve_profile.flow_id, 'remote-installation-commissioning-v1');
  assert.equal(contract.resolve_profile.flow_version, '1.0.0');
  assert.equal(contract.resolve_profile.validator.side_effects_allowed, false);
  assert.equal(contract.resolve_profile.validator.owns_store, false);

  for (const [key, value] of Object.entries(requiredPilot)) {
    assert.equal(contract.resolve_offer.pilot[key], value, `Pilot ${key} drifted`);
  }
  assert.deepEqual(contract.resolve_offer.pilot.milestones, ['A', 'B1']);
  assert.equal(contract.resolve_offer.pilot.b1.translated_tts_injection, false);
  assert.equal(contract.resolve_offer.pilot.b1.cn_en_captions_text_translation_required, true);
  assert.deepEqual(contract.resolve_offer.payment_percentages, [50, 25, 25]);
  assert.equal(contract.resolve_offer.payment_percentages.reduce((sum, value) => sum + value, 0), 100);
  assert.equal(contract.resolve_offer.market_validation_signature.conditional_signature_permitted, true);
  assert.equal(contract.resolve_offer.market_validation_signature.counts_toward_market_gate, true);
  assert.equal(contract.resolve_offer.market_validation_signature.activates_delivery, false);
  assert.ok(contract.resolve_offer.market_validation_signature.activation_requires.includes('resolve_market_gate'));

  const allowedSalesStatuses = new Set(['available', 'pilot', 'planned', 'option', 'not_run']);
  for (const entry of contract.option_register) assert.ok(allowedSalesStatuses.has(entry.sales_status));
  assert.equal(contract.gates.resolve_market.status, 'not_run');
  assert.equal(contract.gates.resolve_market.satisfied, false);
});

test('market register is privacy-safe, empty of fabricated demand and fails closed', () => {
  const register = readJson(join(goalDirectory, contracts.marketEvidence.document));
  assert.equal(register.synthetic_data_allowed, false);
  assert.deepEqual(register.interviews, []);
  assert.deepEqual(register.paid_commitments, []);
  assert.equal(register.summary.qualifying_interviews, 0);
  assert.equal(register.summary.signed_usd_20000_pilots, 0);
  assert.equal(register.summary.time_bound_paid_commitments, 0);
  assert.equal(register.market_gate.status, 'not_run');
  assert.equal(register.market_gate.satisfied, false);
  assert.deepEqual(register.market_gate.missing, [
    '20 qualifying Budget Owner/Champion interviews',
    '1 signed USD 20,000 Pilot contract',
    '2 additional time-bound written paid commitments for the same flow',
    'auditable value pool, budget and data-availability evidence',
  ]);

  const forbiddenKeys = new Set([
    'email', 'phone', 'full_name', 'contact_name', 'contract_body', 'access_token', 'password', 'secret',
  ]);
  everyObject(register, (object, pointer) => {
    for (const key of Object.keys(object)) {
      assert.ok(!forbiddenKeys.has(key), `PII/secret-shaped key ${pointer}/${key} is forbidden`);
    }
  });
});

test('market gate is recomputed from exact-flow, paid, reviewed and unexpired evidence', async () => {
  const modulePath = pathToFileURL(join(goalDirectory, 'evaluate-market-gate.mjs')).href;
  const { evaluateMarketGate } = await import(modulePath);
  const canonical = readJson(join(goalDirectory, contracts.marketEvidence.document));
  const empty = evaluateMarketGate(canonical, { asOf: '2026-08-01T00:00:00Z' });
  assert.deepEqual(empty.summary, canonical.summary);
  assert.deepEqual(empty.market_gate, canonical.market_gate);
  assert.deepEqual(empty.invalid_evidence, []);
  const forgedProjection = structuredClone(canonical);
  forgedProjection.summary.qualifying_interviews = 20;
  forgedProjection.market_gate.status = 'qualified';
  forgedProjection.market_gate.satisfied = true;
  const recomputedProjection = evaluateMarketGate(forgedProjection, { asOf: '2026-08-01T00:00:00Z' });
  assert.notDeepEqual(recomputedProjection.summary, forgedProjection.summary);
  assert.equal(recomputedProjection.market_gate.satisfied, false);

  const scope = {
    product_family_id: 'led-display-system-v1',
    flow_id: 'remote-installation-commissioning-v1',
    flow_version: '1.0.0',
  };
  const interview = (index, organization) => ({
    evidence_id: `INT:TEST_${String(index).padStart(2, '0')}`,
    organization_pseudonym: organization,
    interviewee_pseudonym: `SUBJ-${String(index).padStart(4, '0')}`,
    role_class: index % 2 === 0 ? 'budget_owner' : 'champion',
    interviewed_at: '2026-07-15T00:00:00Z',
    controlled_uri: `controlled://g01-test/interview-${index}`,
    sha256: 'a'.repeat(64),
    ...scope,
    value_pool_observed: true,
    budget_observed: true,
    data_availability_observed: true,
    reviewer_pseudonyms: ['REV-A1', 'REV-B2'],
    review_status: 'qualified',
  });
  const organizations = ['ORG-A001', 'ORG-B002', 'ORG-C003'];
  const interviews = Array.from({ length: 20 }, (_, index) => interview(index + 1, organizations[index % 3]));
  const commitment = (id, organization, type, interviewId) => ({
    evidence_id: `COM:${id}`,
    organization_pseudonym: organization,
    linked_interview_evidence_ids: [interviewId],
    commitment_type: type,
    offer_id: 'resolve-assist-pilot-a-b1-v1',
    ...scope,
    amount_usd: 20_000,
    currency: 'USD',
    payment_percentages: [50, 25, 25],
    scope_milestones: ['A', 'B1'],
    written_commitment: true,
    signed: type === 'signed_pilot_contract',
    written_at: '2026-07-20T00:00:00Z',
    expires_at: '2026-12-31T00:00:00Z',
    controlled_uri: `controlled://g01-test/commitment-${id}`,
    sha256: 'b'.repeat(64),
    same_flow: true,
    value_pool_observed: true,
    budget_observed: true,
    data_availability_observed: true,
    reviewer_pseudonyms: ['REV-A1', 'REV-B2'],
    review_status: 'qualified',
  });
  const qualifying = structuredClone(canonical);
  qualifying.interviews = interviews;
  qualifying.paid_commitments = [
    commitment('PILOT_A', 'ORG-A001', 'signed_pilot_contract', 'INT:TEST_01'),
    commitment('PAID_B', 'ORG-B002', 'time_bound_paid_commitment', 'INT:TEST_02'),
    commitment('PAID_C', 'ORG-C003', 'time_bound_paid_commitment', 'INT:TEST_03'),
  ];
  const candidate = evaluateMarketGate(qualifying, { asOf: '2026-08-01T00:00:00Z' });
  assert.equal(candidate.market_gate.candidate_satisfied, true);
  assert.equal(candidate.market_gate.satisfied, false);
  assert.equal(candidate.market_gate.status, 'candidate_qualified');
  assert.ok(candidate.market_gate.missing.includes('controlled evidence verification and three-party Gate approval'));
  assert.equal(candidate.summary.qualifying_interviews, 20);
  assert.equal(candidate.summary.distinct_paid_organizations, 3);
  assert.deepEqual(candidate.invalid_evidence, []);

  for (const [label, mutate, expectedReason] of [
    ['zero amount', (row) => { row.amount_usd = 0; }, 'amount_must_be_positive'],
    ['unsigned pilot', (row) => { row.signed = false; }, 'signed_pilot_required'],
    ['wrong flow', (row) => { row.flow_id = 'different-flow-v1'; }, 'scope_mismatch'],
    ['wrong payment schedule', (row) => { row.payment_percentages = [0, 0, 0]; }, 'payment_schedule_mismatch'],
    ['expired', (row) => { row.expires_at = '2026-07-01T00:00:00Z'; }, 'expired'],
    ['missing interview link', (row) => { row.linked_interview_evidence_ids = ['INT:UNKNOWN']; }, 'linked_qualified_interview_missing'],
  ]) {
    const candidate = structuredClone(qualifying);
    mutate(candidate.paid_commitments[0]);
    const result = evaluateMarketGate(candidate, { asOf: '2026-08-01T00:00:00Z' });
    assert.equal(result.market_gate.satisfied, false, label);
    assert.ok(result.invalid_evidence.some((entry) => entry.reasons.includes(expectedReason)), label);
  }

  const duplicateSeat = structuredClone(qualifying);
  duplicateSeat.paid_commitments[2].organization_pseudonym = 'ORG-B002';
  duplicateSeat.paid_commitments[2].linked_interview_evidence_ids = ['INT:TEST_02'];
  const duplicateResult = evaluateMarketGate(duplicateSeat, { asOf: '2026-08-01T00:00:00Z' });
  assert.equal(duplicateResult.market_gate.satisfied, false);
  assert.equal(duplicateResult.summary.distinct_paid_organizations, 2);

  const repeatedInterviewee = structuredClone(qualifying);
  repeatedInterviewee.interviews[19].interviewee_pseudonym = repeatedInterviewee.interviews[0].interviewee_pseudonym;
  const repeatedResult = evaluateMarketGate(repeatedInterviewee, { asOf: '2026-08-01T00:00:00Z' });
  assert.equal(repeatedResult.summary.qualifying_interviews, 19);
  assert.equal(repeatedResult.market_gate.satisfied, false);
  assert.ok(repeatedResult.invalid_evidence.some((entry) => entry.reasons.includes('duplicate_interviewee_not_counted')));

  const futureInterview = structuredClone(qualifying);
  futureInterview.interviews[19].interviewed_at = '2026-08-02T00:00:00Z';
  const futureInterviewResult = evaluateMarketGate(futureInterview, { asOf: '2026-08-01T00:00:00Z' });
  assert.equal(futureInterviewResult.summary.qualifying_interviews, 19);
  assert.equal(futureInterviewResult.market_gate.satisfied, false);
  assert.ok(futureInterviewResult.invalid_evidence.some((entry) => entry.reasons.includes('future_interview')));

  const futureCommitment = structuredClone(qualifying);
  futureCommitment.paid_commitments[0].written_at = '2026-08-02T00:00:00Z';
  const futureCommitmentResult = evaluateMarketGate(futureCommitment, { asOf: '2026-08-01T00:00:00Z' });
  assert.equal(futureCommitmentResult.market_gate.satisfied, false);
  assert.ok(futureCommitmentResult.invalid_evidence.some((entry) => entry.reasons.includes('future_commitment')));

  const invertedCommitmentWindow = structuredClone(qualifying);
  invertedCommitmentWindow.paid_commitments[0].written_at = '2027-01-01T00:00:00Z';
  const invertedWindowResult = evaluateMarketGate(invertedCommitmentWindow, { asOf: '2026-08-01T00:00:00Z' });
  assert.equal(invertedWindowResult.market_gate.satisfied, false);
  assert.ok(invertedWindowResult.invalid_evidence.some((entry) => entry.reasons.includes('invalid_commitment_window')));

  const invalidCalendarInterview = structuredClone(qualifying);
  invalidCalendarInterview.interviews[19].interviewed_at = '2026-02-30T00:00:00Z';
  const invalidCalendarInterviewResult = evaluateMarketGate(invalidCalendarInterview, { asOf: '2026-08-01T00:00:00Z' });
  assert.equal(invalidCalendarInterviewResult.summary.qualifying_interviews, 19);
  assert.ok(invalidCalendarInterviewResult.invalid_evidence.some((entry) => entry.reasons.includes('invalid_interview_date')));

  const invalidCalendarCommitment = structuredClone(qualifying);
  invalidCalendarCommitment.paid_commitments[0].written_at = '2026-02-30T00:00:00Z';
  const invalidCalendarCommitmentResult = evaluateMarketGate(invalidCalendarCommitment, { asOf: '2026-08-01T00:00:00Z' });
  assert.equal(invalidCalendarCommitmentResult.market_gate.candidate_satisfied, false);
  assert.ok(invalidCalendarCommitmentResult.invalid_evidence.some((entry) => entry.reasons.includes('invalid_written_date')));
});

test('ROI and unit economics evaluator is deterministic, deduplicated and fail closed', async () => {
  const modulePath = pathToFileURL(join(goalDirectory, 'evaluate-roi.mjs')).href;
  const { evaluatePilotEconomics } = await import(modulePath);
  const cases = [
    ['roi-qualifying.synthetic.json', 'qualified_candidate'],
    ['roi-no-bid.synthetic.json', 'no_bid'],
    ['roi-credit-reversal.synthetic.json', 'qualified_candidate'],
  ];
  for (const [filename, expectedDecision] of cases) {
    const fixture = readJson(join(goalDirectory, 'fixtures', filename));
    assert.equal(fixture.evidence_class, 'synthetic_non_market_evidence');
    const first = evaluatePilotEconomics(fixture.input);
    const second = evaluatePilotEconomics(fixture.input);
    assert.deepEqual(first, second, `${filename} must be deterministic`);
    assert.equal(first.decision, expectedDecision, `${filename} decision drifted`);
    assert.equal(first.market_evidence, false);
    assert.equal(first.formula_version, 'resolve-roi-v1');
  }

  const qualifyingInput = readJson(join(goalDirectory, 'fixtures/roi-qualifying.synthetic.json')).input;
  assert.equal(typeof qualifyingInput.primary_value_dedupe_key, 'string');
  assert.ok(qualifyingInput.primary_value_dedupe_key.length > 0);
  const qualifying = evaluatePilotEconomics(qualifyingInput);
  assert.ok(qualifying.value_to_first_year_cost_ratio >= 3);
  assert.ok(qualifying.steady_state_gross_margin_ratio >= 0.7);
  assert.ok(qualifying.cac_payback_months < 12);
  assert.equal(qualifying.additional_value_pool_input_count, 2);
  assert.equal(qualifying.additional_value_pool_deduped_count, 1);
  assert.equal(qualifying.deduped_additional_value_usd, 70_000, 'duplicate value estimates must use the conservative lower value');

  const primaryOverlapInput = structuredClone(qualifyingInput);
  primaryOverlapInput.additional_value_pools.push({
    pool_id: 'primary-value-duplicate',
    dedupe_key: primaryOverlapInput.primary_value_dedupe_key,
    annual_value_usd: qualifying.primary_avoided_event_value_usd,
  });
  const primaryOverlap = evaluatePilotEconomics(primaryOverlapInput);
  assert.equal(primaryOverlap.primary_overlap_excluded_count, 1);
  assert.equal(primaryOverlap.annual_addressable_value_usd, qualifying.annual_addressable_value_usd);

  const credits = readJson(join(goalDirectory, 'fixtures/roi-credit-reversal.synthetic.json')).input;
  const creditResult = evaluatePilotEconomics(credits);
  assert.equal(
    creditResult.net_recognized_revenue_usd,
    credits.annual_recognized_revenue_usd - credits.credits_usd - credits.reversals_usd - credits.refunds_usd,
  );

  const invalid = readJson(join(goalDirectory, 'fixtures/roi-zero-denominator.synthetic.json'));
  assert.equal(invalid.evidence_class, 'synthetic_non_market_evidence');
  assert.throws(() => evaluatePilotEconomics(invalid.input), /first-year cost must be greater than zero/u);
});

test('competitive register separates official facts, inferences and future Converact tests', () => {
  const register = readJson(join(goalDirectory, contracts.competitiveSources.document));
  const sourceIds = new Set(register.sources.map((source) => source.source_id));
  const claimIds = new Set(register.claims.map((claim) => claim.claim_id));
  assert.equal(sourceIds.size, register.sources.length);
  assert.equal(claimIds.size, register.claims.length);
  assert.deepEqual(new Set(register.claims.map((claim) => claim.claim_type)), new Set([
    'public_fact', 'converact_inference', 'converact_test_requirement',
  ]));

  for (const source of register.sources) {
    const url = new URL(source.url);
    const domain = url.hostname.replace(/^www\./u, '');
    assert.equal(url.protocol, 'https:');
    assert.ok(requiredOfficialDomains.has(domain), `non-official source domain: ${domain}`);
    assert.equal(source.source_tier, 'official_primary');
    assert.equal(source.used_as_converact_performance_evidence, false);
    assert.match(source.captured_at, /^2026-08-01/u);
  }

  for (const claim of register.claims) {
    for (const sourceId of claim.source_ids) assert.ok(sourceIds.has(sourceId));
    if (claim.claim_type === 'public_fact') assert.ok(claim.source_ids.length > 0);
    if (claim.claim_type === 'converact_inference') {
      assert.ok(claim.source_ids.length > 0);
      assert.ok(claim.inference_basis.length > 0);
      assert.equal(claim.proven, false);
    }
    if (claim.claim_type === 'converact_test_requirement') {
      assert.equal(claim.status, 'not_run');
      assert.deepEqual(claim.source_ids, []);
      assert.ok(claim.required_evidence.length > 0);
    }
  }

  const activeSource = register.sources.find((source) => source.source_id === 'SRC:ACTIVE_CALL:PIN');
  assert.equal(
    activeSource?.url,
    'https://github.com/miuda-ai/active-call/tree/a5c7a88490b65975c0b0ae2787311c49022d4a8d',
  );
  assert.match(activeSource?.usage_limit ?? '', /LICENSE body is absent/u);
  assert.equal(activeSource?.repository_url, 'https://github.com/miuda-ai/active-call');
  assert.equal(activeSource?.immutable_revision, 'a5c7a88490b65975c0b0ae2787311c49022d4a8d');
  assert.equal(activeSource?.declared_license, 'MIT');
  assert.equal(activeSource?.license_body_status, 'missing_at_revision');
  assert.equal(activeSource?.source_hash_status, 'not_run');
  assert.equal(activeSource?.integration_status, 'not_run');
  assert.equal(activeSource?.performance_status, 'not_run');
  const activeFact = register.claims.find((claim) => claim.claim_id === 'CLAIM:FACT:ACTIVE_CALL');
  assert.equal(activeFact?.status, 'publicly_documented');
  assert.match(activeFact?.statement ?? '', /0\.3\.75/u);
  const activeDecision = register.claims.find((claim) => claim.claim_id === 'CLAIM:INFERENCE:ACTIVE_ADAPTER');
  assert.equal(activeDecision?.status, 'not_run');
  assert.ok(activeDecision?.required_evidence.includes('LICENSE body and notice resolution'));
});

test('traceability closes every G00→G01 row and every G01 outcome without falsifying market evidence', () => {
  const trace = readJson(join(goalDirectory, contracts.traceability.document));
  const g00 = readJson(join(repositoryRoot, 'architecture-foundation/execution/goal-00/requirement-traceability-v1.json'));
  const expectedG00Ids = g00.requirements
    .filter((row) => row.target_goals?.includes('G01'))
    .map((row) => row.requirement_id)
    .sort();
  const assertCoverage = (candidate) => {
    const tracedG00Ids = candidate.rows
      .filter((row) => row.source_id === 'G00_TRACE')
      .map((row) => row.source_requirement_id)
      .sort();
    assert.deepEqual(tracedG00Ids, expectedG00Ids);
    for (let index = 1; index <= 11; index += 1) {
      const id = `G01:OUTCOME:${String(index).padStart(2, '0')}`;
      assert.ok(candidate.rows.some((row) => row.requirement_id === id), `missing ${id}`);
    }
    for (const gate of ['PLATFORM_CONTRACT', 'RESOLVE_PROFILE_CONTRACT', 'RESOLVE_MARKET']) {
      assert.ok(candidate.rows.some((row) => row.requirement_id === `G01:GATE:${gate}`));
    }
    assert.equal(new Set(candidate.rows.map((row) => row.requirement_id)).size, candidate.rows.length);
    const expectedClosure = {
      row_count: candidate.rows.length,
      g00_to_g01_row_count: candidate.rows.filter((row) => row.source_id === 'G00_TRACE').length,
      direct_g01_row_count: candidate.rows.filter((row) => row.source_id === 'G01_GOAL').length,
      unresolved_count: 0,
      verified_contract_count: candidate.rows.filter((row) => row.evidence_status === 'verified_contract').length,
      preserved_read_only_count: candidate.rows.filter((row) => row.evidence_status === 'preserved_read_only').length,
      not_run_count: candidate.rows.filter((row) => row.evidence_status === 'not_run').length,
      market_evidence_rows_verified: candidate.rows.filter((row) => row.gate === 'resolve_market' && row.evidence_status === 'verified_contract').length,
    };
    assert.deepEqual(candidate.closure, expectedClosure);
    assert.ok(candidate.rows.filter((row) => row.gate === 'resolve_market').every((row) => row.evidence_status === 'not_run'));
    assert.ok(candidate.rows.every((row) => ['verified_contract', 'not_run', 'preserved_read_only'].includes(row.evidence_status)));
    for (const row of candidate.rows) {
      for (const artifact of row.artifacts) {
        assert.ok(existsSync(join(repositoryRoot, artifact)), `${row.requirement_id} references missing ${artifact}`);
      }
    }
  };
  assertCoverage(trace);
  assert.equal(trace.goal_outcome, 'blocked_external');

  const missingG00Row = structuredClone(trace);
  missingG00Row.rows = missingG00Row.rows.filter((row) => row.source_requirement_id !== expectedG00Ids[0]);
  missingG00Row.closure.row_count -= 1;
  missingG00Row.closure.g00_to_g01_row_count -= 1;
  if (trace.rows.find((row) => row.source_requirement_id === expectedG00Ids[0]).evidence_status === 'preserved_read_only') {
    missingG00Row.closure.preserved_read_only_count -= 1;
  } else {
    missingG00Row.closure.verified_contract_count -= 1;
  }
  assert.throws(() => assertCoverage(missingG00Row), /Expected values to be strictly deep-equal/u);
});

test('all local Markdown links resolve and no document makes an unproved completion claim', () => {
  const forbiddenClaims = [
    /Resolve market gate (?:is|已) (?:complete|completed|通过)/iu,
    /production[_ -]?eligible\s*[:=]\s*true/iu,
    /20 qualifying interviews completed/iu,
    /signed pilot contract verified/iu,
  ];
  for (const name of requiredMarkdown) {
    const path = join(goalDirectory, name);
    const text = readFileSync(path, 'utf8');
    for (const pattern of forbiddenClaims) assert.doesNotMatch(text, pattern, `${name} contains an unproved claim`);
    for (const target of collectMarkdownLinks(text)) {
      if (/^(?:https?:|mailto:|#)/u.test(target)) continue;
      const local = resolveLocalLink(path, target);
      assert.ok(existsSync(local), `${name} has unresolved local link ${target}`);
    }
  }
});

test('independent review closes contract findings without claiming market or human evidence', () => {
  const review = readFileSync(join(goalDirectory, 'independent-review.md'), 'utf8');
  assert.match(review, /Reviewer type：independent AI subagent/u);
  assert.match(review, /Final disposition：`accepted_contract_gates_with_external_market_blocker`/u);
  assert.match(review, /Open Critical：0/u);
  assert.match(review, /Open Important：0/u);
  assert.match(review, /Resolve Market Gate：`not_run`/u);
  assert.match(review, /G01 outcome：`blocked_external`/u);
  assert.match(review, /不是人工、客户、法律或生产审计/u);
});

test('binding inputs and generated artifact identities are hash-addressed', () => {
  const trace = readJson(join(goalDirectory, contracts.traceability.document));
  const expectedBindings = {
    'goals/PROGRAM-RULES.md': sha256File(join(repositoryRoot, 'goals/PROGRAM-RULES.md')),
    'goals/goal-01-product-domain-commercial-gates.md': '736225a0d4c0d8abe2d951b95bf502e81f4dfbbcefce8a8defb81e330b7c5af1',
    'goals/manifest.json': sha256File(join(repositoryRoot, 'goals/manifest.json')),
    'architecture-foundation/execution/goal-00/requirement-traceability-v1.json': sha256File(join(repositoryRoot, 'architecture-foundation/execution/goal-00/requirement-traceability-v1.json')),
  };
  for (const [path, expectedSha] of Object.entries(expectedBindings)) {
    const binding = trace.binding_inputs.find((entry) => entry.path === path);
    assert.equal(binding?.sha256, expectedSha, `${path} binding digest drifted`);
  }
  assert.equal(trace.goal_id, 'G01');
  assert.equal(trace.market_gate_status, 'not_run');
  assert.equal(trace.production_eligible, false);
});

test('fixtures are JSON-only, synthetic data is explicitly non-market, and no customer identities exist', () => {
  const fixtureNames = [
    ...Object.values(contracts).map(({ invalid }) => invalid),
    'fixtures/roi-qualifying.synthetic.json',
    'fixtures/roi-no-bid.synthetic.json',
    'fixtures/roi-credit-reversal.synthetic.json',
    'fixtures/roi-zero-denominator.synthetic.json',
  ];
  for (const name of fixtureNames) {
    assert.equal(extname(name), '.json');
    const value = readJson(join(goalDirectory, name));
    if (name.includes('.synthetic.')) {
      assert.equal(value.evidence_class, 'synthetic_non_market_evidence');
      assert.equal(value.market_evidence, false);
    }
  }
});
