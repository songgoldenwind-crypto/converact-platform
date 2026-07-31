/** Provider-neutral IVR branch handles shared by runtimes and designers. */
export const IVR_BRANCH = {
  OUT: 'out',
  SUCCESS: 'success',
  ERROR: 'error',
  FAIL: 'fail',
  TIMEOUT: 'timeout',
  INVALID: 'invalid',
  MAX_RETRIES: 'max_retries',
  TRUE: 'true',
  FALSE: 'false',
  FOUND: 'found',
  NOT_FOUND: 'not_found',
  HIGH: 'high',
  LOW: 'low',
  CONTINUE: 'continue',
  AT_CAPACITY: 'at_capacity',
  DECLINED: 'declined',
  SKIPPED: 'skipped',
  DENIED: 'denied',
  SUBMITTED: 'submitted',
  digit: (digit: string) => `digit_${digit}`
} as const;

export interface GraphValidationError {
  nodeId: string;
  handle?: string;
  message: string;
}

export interface MenuOptionLike {
  digit: string;
  routeType?: string;
  routeTarget?: string;
}

export function menuRequiredDigitHandles(node: { data: Record<string, unknown> }): string[] {
  const options = (node.data.options as MenuOptionLike[]) ?? [];
  return options
    .filter((option) => !option.routeType || option.routeType === 'node')
    .map((option) => IVR_BRANCH.digit(option.digit));
}

export const REQUIRED_HANDLES_BY_TYPE: Record<
  string,
  {
    required: string[];
    dynamic?: (node: { type: string; data: Record<string, unknown> }) => string[];
  }
> = {
  start: { required: [IVR_BRANCH.OUT] },
  play: { required: [IVR_BRANCH.OUT] },
  flush_audio: { required: [IVR_BRANCH.OUT] },
  menu: {
    required: [IVR_BRANCH.TIMEOUT, IVR_BRANCH.INVALID, IVR_BRANCH.MAX_RETRIES],
    dynamic: menuRequiredDigitHandles
  },
  collect: {
    required: [IVR_BRANCH.OUT, IVR_BRANCH.TIMEOUT, IVR_BRANCH.INVALID]
  },
  survey: {
    required: [IVR_BRANCH.SUBMITTED, IVR_BRANCH.INVALID, IVR_BRANCH.TIMEOUT]
  },
  condition: { required: [IVR_BRANCH.TRUE, IVR_BRANCH.FALSE] },
  time_condition: { required: [IVR_BRANCH.TRUE, IVR_BRANCH.FALSE] },
  queue: {
    required: [IVR_BRANCH.OUT, IVR_BRANCH.TIMEOUT, IVR_BRANCH.AT_CAPACITY, IVR_BRANCH.ERROR]
  },
  http: { required: [IVR_BRANCH.SUCCESS, IVR_BRANCH.FAIL, IVR_BRANCH.TIMEOUT] },
  webhook: { required: [IVR_BRANCH.SUCCESS, IVR_BRANCH.FAIL, IVR_BRANCH.TIMEOUT] },
  knowledge_qa: {
    required: [IVR_BRANCH.FOUND],
    dynamic: (node) => {
      const action = (node.data.noAnswerAction as string) || 'continue';
      return action === 'continue' ? [IVR_BRANCH.NOT_FOUND] : [];
    }
  },
  intent: { required: [IVR_BRANCH.HIGH, IVR_BRANCH.LOW, IVR_BRANCH.CONTINUE] },
  compliance: {
    required: [IVR_BRANCH.OUT],
    dynamic: (node) => node.data.complianceType === 'recording_consent'
      ? ['acknowledged', IVR_BRANCH.DECLINED, IVR_BRANCH.TIMEOUT]
      : []
  },
  visual_menu: {
    required: [IVR_BRANCH.TIMEOUT, IVR_BRANCH.INVALID],
    dynamic: (node) => ((node.data.items as MenuOptionLike[]) ?? [])
      .map((item) => IVR_BRANCH.digit(item.digit))
  },
  subflow: { required: [IVR_BRANCH.OUT, IVR_BRANCH.ERROR] },
  ai_dialogue: { required: [IVR_BRANCH.OUT, IVR_BRANCH.TIMEOUT, IVR_BRANCH.ERROR] },
  avatar_switch: { required: [IVR_BRANCH.SUCCESS, IVR_BRANCH.DECLINED, IVR_BRANCH.ERROR] },
  video_play: { required: [IVR_BRANCH.OUT, IVR_BRANCH.SKIPPED, IVR_BRANCH.ERROR] },
  screen_share: { required: [IVR_BRANCH.OUT, IVR_BRANCH.DENIED, IVR_BRANCH.ERROR] },
  transfer: { required: [] },
  voicemail: { required: [] },
  sip: { required: [] },
  disconnect: { required: [] }
};
