import { resolveBrandEnv } from '../../config/converact-env.js';
import type {
  FeedbackActionRecommendation,
  FeedbackActionType,
  FeedbackDecision,
  FeedbackInput,
  FeedbackThresholds
} from './types.js';

/** Default feedback thresholds — overridable via env or config */
export const DEFAULT_FEEDBACK_THRESHOLDS: FeedbackThresholds = {
  min_reply_rate: Number(resolveBrandEnv(process.env, 'FEEDBACK_MIN_REPLY_RATE')) || 0.1,
  min_booking_rate: Number(resolveBrandEnv(process.env, 'FEEDBACK_MIN_BOOKING_RATE')) || 0.05,
  max_bounce_rate: Number(resolveBrandEnv(process.env, 'FEEDBACK_MAX_BOUNCE_RATE')) || 0.2
};

export function verifyAndTune(input: FeedbackInput): FeedbackDecision {
  const contacted = Math.max(input.receipt.contacted_leads, 1);
  const replyRate = input.receipt.replied_leads / contacted;
  const bookingRate = input.receipt.booked_calls / contacted;
  const bounceRate = input.receipt.bounce_rate;
  const metrics = {
    reply_rate: replyRate,
    booking_rate: bookingRate,
    bounce_rate: bounceRate
  };

  const actionRecommendations: FeedbackActionRecommendation[] = [];
  if (bookingRate < input.thresholds.min_booking_rate) {
    actionRecommendations.push(buildActionRecommendation(
      'tighten_lead_scoring',
      'Booking rate is below threshold; tighten lead scoring before the next outreach batch.',
      metrics
    ));
  }

  if (replyRate < input.thresholds.min_reply_rate) {
    actionRecommendations.push(buildActionRecommendation(
      'refresh_script_angles',
      'Reply rate is below threshold; refresh script angles before more follow-up.',
      metrics
    ));
  }

  if (bounceRate > input.thresholds.max_bounce_rate) {
    actionRecommendations.push(buildActionRecommendation(
      'prioritize_verified_channels',
      'Bounce rate is above threshold; prioritize verified channels and contact evidence.',
      metrics
    ));
  }

  const driftDetected = actionRecommendations.length > 0;
  return {
    goal: input.goal,
    stage: input.stage,
    quality_status: driftDetected ? 'warn' : 'pass',
    drift_detected: driftDetected,
    adjustment_actions: actionRecommendations.map((action) => action.action_type),
    action_recommendations: actionRecommendations,
    metrics
  };
}

function buildActionRecommendation(
  actionType: FeedbackActionType,
  reason: string,
  metrics: FeedbackActionRecommendation['metrics']
): FeedbackActionRecommendation {
  return {
    action_type: actionType,
    status: 'pending',
    scope: 'lead_acquisition_run',
    reason,
    metrics
  };
}
