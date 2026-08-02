import assert from 'node:assert/strict';
import test from 'node:test';

import * as foundation from '../src/agent-runtime/converact/platform-foundation/index.js';

test('platform foundation exposes one explicit public module boundary', () => {
  assert.deepEqual(Object.keys(foundation).sort(), [
    'BoundedAdmissionGate',
    'PLATFORM_DRAIN_AUTHORITIES',
    'PlatformBillingStoreError',
    'PlatformDrainCoordinator',
    'PlatformDrainError',
    'PlatformFoundationStoreError',
    'PostgresPlatformBillingLedgerStore',
    'PostgresPlatformEventReceiptStore',
    'SystemPlatformClock',
    'assertMetricLabels',
    'assertSafeSecretSink',
    'createEffectAuditLink',
    'createMetricLabelPolicy',
    'createPlatformDeadline',
    'decideEffectReceiptAppend',
    'decideInboxWrite',
    'decideKeyTransition',
    'decideTelemetryExport',
    'decideUsageAppend',
    'decodePlatformEvent',
    'effectNeedsReconcile',
    'evaluateCertificateBinding',
    'evaluateConsentLease',
    'evaluateNativeSourceGate',
    'evaluatePlatformAccess',
    'issueConsentLease',
    'normalizeCorrelationContext',
    'ordinaryMediaPlatformDependencies',
    'platformBillingKey',
    'platformDeadlineState',
    'platformFaultPolicy',
    'platformPayloadDigest',
    'reconstructUsage',
    'redactObservabilityValue',
    'resolveKeyUsage',
    'signPlatformDrainReceipt',
    'systemMonotonicNowMs'
  ].sort());
});
