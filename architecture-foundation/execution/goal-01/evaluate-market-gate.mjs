const expectedScope = Object.freeze({
  offer_id: 'resolve-assist-pilot-a-b1-v1',
  product_family_id: 'led-display-system-v1',
  flow_id: 'remote-installation-commissioning-v1',
  flow_version: '1.0.0',
});

const missingLabels = Object.freeze({
  interviews: '20 qualifying Budget Owner/Champion interviews',
  pilot: '1 signed USD 20,000 Pilot contract',
  commitments: '2 additional time-bound written paid commitments for the same flow',
  commercialFacts: 'auditable value pool, budget and data-availability evidence',
});

const permittedNextActions = Object.freeze([
  'recruit ICP Budget Owners and Champions',
  'store evidence in approved controlled storage',
  'update this register only from audited evidence',
]);

const forbiddenUnlocks = Object.freeze([
  'G11 Resolve connector implementation',
  'G16 Resolve commercialization',
  'Resolve market-qualified claim',
  'second Profile development',
]);

const externalApprovalLabel = 'controlled evidence verification and three-party Gate approval';

function validDate(value) {
  if (typeof value !== 'string') return false;
  const match = /^(20\d{2})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/u.exec(value);
  if (match === null) return false;
  const [, year, month, day, hour, minute, second, fraction = ''] = match;
  const expected = [year, month, day, hour, minute, second].map(Number);
  if (expected[1] < 1 || expected[1] > 12 || expected[2] < 1 || expected[2] > 31
      || expected[3] > 23 || expected[4] > 59 || expected[5] > 59) return false;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return false;
  const date = new Date(parsed);
  return date.getUTCFullYear() === expected[0]
    && date.getUTCMonth() + 1 === expected[1]
    && date.getUTCDate() === expected[2]
    && date.getUTCHours() === expected[3]
    && date.getUTCMinutes() === expected[4]
    && date.getUTCSeconds() === expected[5]
    && date.getUTCMilliseconds() === Number(fraction.padEnd(3, '0'));
}

function validHash(value) {
  return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
}

function validControlledUri(value) {
  return typeof value === 'string' && /^controlled:\/\/[a-zA-Z0-9._~/-]+$/u.test(value);
}

function hasIndependentReviewers(value) {
  return Array.isArray(value)
    && value.length >= 2
    && new Set(value).size === value.length
    && value.every((reviewer) => /^REV-[A-Z0-9]+$/u.test(reviewer));
}

function scopeMatches(row) {
  return Object.entries(expectedScope).every(([field, expected]) => row[field] === expected);
}

function addInvalid(invalidEvidence, row, reasons) {
  invalidEvidence.push({
    evidence_id: typeof row?.evidence_id === 'string' ? row.evidence_id : 'UNKNOWN',
    reasons: [...new Set(reasons)].sort(),
  });
}

function qualifiedInterviews(register, asOfMs, invalidEvidence) {
  const seenIds = new Set();
  const seenInterviewees = new Set();
  const qualified = [];
  for (const row of register.interviews ?? []) {
    if (row?.review_status !== 'qualified') continue;
    const reasons = [];
    if (typeof row.evidence_id !== 'string' || !/^INT:[A-Z0-9_-]+$/u.test(row.evidence_id)) reasons.push('invalid_evidence_id');
    if (seenIds.has(row.evidence_id)) reasons.push('duplicate_evidence_id');
    seenIds.add(row.evidence_id);
    if (typeof row.organization_pseudonym !== 'string' || !/^ORG-[A-Z0-9]{4,}$/u.test(row.organization_pseudonym)) reasons.push('invalid_organization_pseudonym');
    if (typeof row.interviewee_pseudonym !== 'string' || !/^SUBJ-[A-Z0-9]{4,}$/u.test(row.interviewee_pseudonym)) {
      reasons.push('invalid_interviewee_pseudonym');
    } else if (seenInterviewees.has(row.interviewee_pseudonym)) {
      reasons.push('duplicate_interviewee_not_counted');
    } else {
      seenInterviewees.add(row.interviewee_pseudonym);
    }
    if (!['budget_owner', 'champion'].includes(row.role_class)) reasons.push('invalid_role');
    if (!validDate(row.interviewed_at)) reasons.push('invalid_interview_date');
    else if (Date.parse(row.interviewed_at) > asOfMs) reasons.push('future_interview');
    if (!validControlledUri(row.controlled_uri)) reasons.push('invalid_controlled_uri');
    if (!validHash(row.sha256)) reasons.push('invalid_evidence_hash');
    if (!scopeMatches({ ...row, offer_id: expectedScope.offer_id })) reasons.push('scope_mismatch');
    if (!hasIndependentReviewers(row.reviewer_pseudonyms)) reasons.push('independent_review_missing');
    if (reasons.length > 0) addInvalid(invalidEvidence, row, reasons);
    else qualified.push(row);
  }
  return qualified;
}

function qualifiedCommitments(register, interviewById, asOfMs, invalidEvidence) {
  const seenIds = new Set();
  const qualified = [];
  for (const row of register.paid_commitments ?? []) {
    if (row?.review_status !== 'qualified') continue;
    const reasons = [];
    if (typeof row.evidence_id !== 'string' || !/^COM:[A-Z0-9_-]+$/u.test(row.evidence_id)) reasons.push('invalid_evidence_id');
    if (seenIds.has(row.evidence_id)) reasons.push('duplicate_evidence_id');
    seenIds.add(row.evidence_id);
    if (typeof row.organization_pseudonym !== 'string' || !/^ORG-[A-Z0-9]{4,}$/u.test(row.organization_pseudonym)) reasons.push('invalid_organization_pseudonym');
    if (!scopeMatches(row) || row.same_flow !== true) reasons.push('scope_mismatch');
    if (!Number.isFinite(row.amount_usd) || row.amount_usd <= 0) reasons.push('amount_must_be_positive');
    if (row.currency !== 'USD') reasons.push('currency_must_be_usd');
    if (!Array.isArray(row.payment_percentages)
        || row.payment_percentages.length !== 3
        || row.payment_percentages[0] !== 50
        || row.payment_percentages[1] !== 25
        || row.payment_percentages[2] !== 25) reasons.push('payment_schedule_mismatch');
    if (row.written_commitment !== true) reasons.push('written_commitment_required');
    const writtenAtValid = validDate(row.written_at);
    const expiresAtValid = validDate(row.expires_at);
    if (!writtenAtValid) reasons.push('invalid_written_date');
    else if (Date.parse(row.written_at) > asOfMs) reasons.push('future_commitment');
    if (!expiresAtValid) reasons.push('invalid_expiry');
    else if (Date.parse(row.expires_at) <= asOfMs) reasons.push('expired');
    if (writtenAtValid && expiresAtValid && Date.parse(row.written_at) >= Date.parse(row.expires_at)) {
      reasons.push('invalid_commitment_window');
    }
    if (!validControlledUri(row.controlled_uri)) reasons.push('invalid_controlled_uri');
    if (!validHash(row.sha256)) reasons.push('invalid_evidence_hash');
    if (!hasIndependentReviewers(row.reviewer_pseudonyms)) reasons.push('independent_review_missing');
    if (row.value_pool_observed !== true || row.budget_observed !== true || row.data_availability_observed !== true) {
      reasons.push('commercial_facts_missing');
    }
    if (!Array.isArray(row.scope_milestones)
        || row.scope_milestones.length !== 2
        || row.scope_milestones[0] !== 'A'
        || row.scope_milestones[1] !== 'B1') reasons.push('a_b1_scope_required');

    if (row.commitment_type === 'signed_pilot_contract') {
      if (row.amount_usd !== 20_000) reasons.push('signed_pilot_amount_must_equal_20000');
      if (row.signed !== true) reasons.push('signed_pilot_required');
    } else if (row.commitment_type !== 'time_bound_paid_commitment') {
      reasons.push('invalid_commitment_type');
    }

    const links = Array.isArray(row.linked_interview_evidence_ids) ? row.linked_interview_evidence_ids : [];
    const hasLinkedInterview = links.some((id) => interviewById.get(id)?.organization_pseudonym === row.organization_pseudonym);
    if (!hasLinkedInterview) reasons.push('linked_qualified_interview_missing');

    if (reasons.length > 0) addInvalid(invalidEvidence, row, reasons);
    else qualified.push(row);
  }
  return qualified;
}

export function evaluateMarketGate(register, { asOf } = {}) {
  if (register === null || typeof register !== 'object' || Array.isArray(register)) {
    throw new TypeError('market evidence register must be an object');
  }
  const asOfValue = asOf ?? register.generated_at;
  if (!validDate(asOfValue)) throw new TypeError('asOf must be a valid timestamp');
  const asOfMs = Date.parse(asOfValue);
  const invalidEvidence = [];
  const interviews = qualifiedInterviews(register, asOfMs, invalidEvidence);
  const interviewById = new Map(interviews.map((row) => [row.evidence_id, row]));
  const commitments = qualifiedCommitments(register, interviewById, asOfMs, invalidEvidence);

  const interviewOrganizations = new Set(interviews.map((row) => row.organization_pseudonym));
  const pilotOrganizations = new Set(commitments
    .filter((row) => row.commitment_type === 'signed_pilot_contract')
    .map((row) => row.organization_pseudonym));
  const additionalCommitmentOrganizations = new Set(commitments
    .filter((row) => row.commitment_type === 'time_bound_paid_commitment' && !pilotOrganizations.has(row.organization_pseudonym))
    .map((row) => row.organization_pseudonym));
  const paidOrganizations = new Set([...pilotOrganizations, ...additionalCommitmentOrganizations]);
  const commercialFactOrganizations = new Set(commitments.map((row) => row.organization_pseudonym));

  const summary = {
    qualifying_interviews: interviews.length,
    distinct_interview_organizations: interviewOrganizations.size,
    signed_usd_20000_pilots: pilotOrganizations.size,
    time_bound_paid_commitments: additionalCommitmentOrganizations.size,
    distinct_paid_organizations: paidOrganizations.size,
    same_flow_organizations: paidOrganizations.size,
    auditable_value_pool_organizations: commercialFactOrganizations.size,
    auditable_budget_organizations: commercialFactOrganizations.size,
    auditable_data_availability_organizations: commercialFactOrganizations.size,
  };

  const missing = [];
  if (summary.qualifying_interviews < 20) missing.push(missingLabels.interviews);
  if (summary.signed_usd_20000_pilots < 1) missing.push(missingLabels.pilot);
  if (summary.time_bound_paid_commitments < 2 || summary.distinct_paid_organizations < 3) missing.push(missingLabels.commitments);
  if (summary.same_flow_organizations < 3
      || summary.auditable_value_pool_organizations < 3
      || summary.auditable_budget_organizations < 3
      || summary.auditable_data_availability_organizations < 3) missing.push(missingLabels.commercialFacts);
  const candidateSatisfied = missing.length === 0;
  if (candidateSatisfied) missing.push(externalApprovalLabel);
  const marketGate = {
    status: candidateSatisfied ? 'candidate_qualified' : 'not_run',
    candidate_satisfied: candidateSatisfied,
    satisfied: false,
    missing,
    permitted_next_actions: candidateSatisfied
      ? ['verify controlled evidence hashes and obtain product, commercial and independent Gate approvals']
      : [...permittedNextActions],
    forbidden_unlocks: [...forbiddenUnlocks],
  };

  return { summary, market_gate: marketGate, invalid_evidence: invalidEvidence };
}
