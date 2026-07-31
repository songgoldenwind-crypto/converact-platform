import {
  MEDIA_CONTROL_ACTIONS,
  MEDIA_CONTROL_RESULT_CLASSES,
  type MediaControlAction,
  type MediaControlResultClass
} from './protocol.js';

export type MediaControlCommandMetricResult = MediaControlResultClass;

export type MediaControlMetricSessionState =
  | 'pending'
  | 'prepared'
  | 'committed'
  | 'cancelled'
  | 'closed'
  | 'expired'
  | 'failed';

const ACTIONS: readonly MediaControlAction[] = MEDIA_CONTROL_ACTIONS;
const RESULTS: readonly MediaControlCommandMetricResult[] = [
  ...MEDIA_CONTROL_RESULT_CLASSES
];
const SESSION_STATES: readonly MediaControlMetricSessionState[] = [
  'pending',
  'prepared',
  'committed',
  'cancelled',
  'closed',
  'expired',
  'failed'
];

export class MediaControlMetrics {
  readonly #commands = new Map<string, number>();
  readonly #reconciliations = new Map<string, number>();
  readonly #sessions = new Map<MediaControlMetricSessionState, number>(
    SESSION_STATES.map((state) => [state, 0])
  );
  #reservations = 0;

  recordCommand(
    action: MediaControlAction,
    result: MediaControlCommandMetricResult
  ): void {
    this.#commands.set(
      `${action}:${result}`,
      (this.#commands.get(`${action}:${result}`) ?? 0) + 1
    );
  }

  recordReconciliation(
    result: MediaControlCommandMetricResult
  ): void {
    this.#reconciliations.set(
      result,
      (this.#reconciliations.get(result) ?? 0) + 1
    );
  }

  addSession(state: MediaControlMetricSessionState): void {
    this.#reservations += 1;
    this.#sessions.set(state, (this.#sessions.get(state) ?? 0) + 1);
  }

  transitionSession(
    previous: MediaControlMetricSessionState,
    next: MediaControlMetricSessionState
  ): void {
    if (previous === next) return;
    const previousCount = this.#sessions.get(previous) ?? 0;
    if (previousCount < 1) {
      throw new Error('media control metric session underflow');
    }
    this.#sessions.set(previous, previousCount - 1);
    this.#sessions.set(next, (this.#sessions.get(next) ?? 0) + 1);
  }

  removeSession(state: MediaControlMetricSessionState): void {
    const count = this.#sessions.get(state) ?? 0;
    if (count < 1 || this.#reservations < 1) {
      throw new Error('media control metric reservation underflow');
    }
    this.#sessions.set(state, count - 1);
    this.#reservations -= 1;
  }

  render(): string {
    const lines = [
      '# HELP ivekit_media_control_commands_total Media control commands by bounded action and result.',
      '# TYPE ivekit_media_control_commands_total counter'
    ];
    for (const action of ACTIONS) {
      for (const result of RESULTS) {
        lines.push(
          `ivekit_media_control_commands_total{action="${action}",result="${result}"} ` +
          `${this.#commands.get(`${action}:${result}`) ?? 0}`
        );
      }
    }
    lines.push(
      '# HELP ivekit_media_control_reconciliations_total Unknown command reconciliation outcomes.',
      '# TYPE ivekit_media_control_reconciliations_total counter'
    );
    for (const result of RESULTS) {
      lines.push(
        `ivekit_media_control_reconciliations_total{result="${result}"} ` +
        `${this.#reconciliations.get(result) ?? 0}`
      );
    }
    lines.push(
      '# HELP ivekit_media_control_sessions Current bounded media-control session records.',
      '# TYPE ivekit_media_control_sessions gauge'
    );
    for (const state of SESSION_STATES) {
      lines.push(
        `ivekit_media_control_sessions{state="${state}"} ` +
        `${this.#sessions.get(state) ?? 0}`
      );
    }
    lines.push(
      '# HELP ivekit_media_control_reservations Current media-control reservation records.',
      '# TYPE ivekit_media_control_reservations gauge',
      `ivekit_media_control_reservations ${this.#reservations}`
    );
    return `${lines.join('\n')}\n`;
  }
}
