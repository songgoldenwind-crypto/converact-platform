/**
 * Platform scoring + inquiry helpers (used by platform commands and call-center).
 * Implementations live in scoring-utils.ts.
 */
export { ensureTenant, getTenant } from './tenant-core.js';
export {
  badRequest,
  notFound,
  required,
  slugify,
  hoursFromNow,
  rate,
  eventCount,
  displayContact,
  clamp,
  buildScoreReason,
  scoreSource,
  statusFromScore,
  nextActionForStatus,
  scoreInquiry,
  upsertContact,
  enrichLead
} from './scoring-utils.js';
