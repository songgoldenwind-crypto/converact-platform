export {
  SystemPlatformClock,
  createPlatformDeadline,
  platformDeadlineState,
  systemMonotonicNowMs
} from './clock.js';
export type {
  PlatformClock,
  PlatformDeadline,
  PlatformDeadlineState
} from './clock.js';

export { evaluatePlatformAccess } from './identity.js';
export type {
  IdentityKind,
  PlatformAccessDecision,
  PlatformIdentityClaims
} from './identity.js';

export { evaluateConsentLease, issueConsentLease } from './policy.js';
export type {
  ConsentEvidence,
  ConsentLease,
  ConsentLeaseRequest,
  ConsentLeaseState,
  ConsentScope
} from './policy.js';

export {
  decideInboxWrite,
  decodePlatformEvent,
  platformPayloadDigest
} from './event-envelope.js';
export type {
  PlatformEventCorrelation,
  PlatformEventV2,
  PlatformInboxState,
  PlatformInboxWriteDecision
} from './event-envelope.js';

export {
  createEffectAuditLink,
  decideEffectReceiptAppend,
  effectNeedsReconcile
} from './effect-receipt.js';
export type {
  EffectAuditLink,
  EffectReceipt,
  EffectReceiptAppendDecision,
  EffectReceiptStage
} from './effect-receipt.js';

export {
  decideUsageAppend,
  platformBillingKey,
  reconstructUsage
} from './billing-ledger.js';
export type {
  AiRunUsage,
  BillableSource,
  DirectedMediaEdgeUsage,
  ExternalActionUsage,
  RecordingSegmentUsage,
  UsageAppendDecision,
  UsageBalance,
  UsageEntry
} from './billing-ledger.js';

export {
  assertSafeSecretSink,
  decideKeyTransition,
  evaluateCertificateBinding,
  evaluateNativeSourceGate,
  resolveKeyUsage
} from './key-lifecycle.js';
export type {
  CertificateBindingInput,
  KeyPurpose,
  KeyState,
  KeyTransitionCommand,
  KeyVersion,
  NativeSourceGateInput,
  SecretSink
} from './key-lifecycle.js';

export {
  assertMetricLabels,
  decideTelemetryExport,
  normalizeCorrelationContext,
  redactObservabilityValue
} from './correlation.js';
export type {
  PlatformCorrelationContext,
  PlatformMetricLabel,
  TelemetryDropReason
} from './correlation.js';

export { BoundedAdmissionGate } from './resilience.js';
export type { AdmissionLease } from './resilience.js';

export {
  ordinaryMediaPlatformDependencies,
  platformFaultPolicy
} from './fault-policy.js';
export type { PlatformFaultDependency } from './fault-policy.js';

export {
  PlatformFoundationStoreError,
  PostgresPlatformEventReceiptStore
} from './postgres-event-receipt-store.js';
export type {
  PlatformOutboxClaim,
  PlatformOutboxClaimInput
} from './postgres-event-receipt-store.js';

export {
  PlatformBillingStoreError,
  PostgresPlatformBillingLedgerStore
} from './postgres-billing-ledger-store.js';
