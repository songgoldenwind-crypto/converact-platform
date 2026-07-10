export interface IvrMenuOption {
  digit: string;
  label: string;
  route_type: 'queue' | 'ai' | 'voicemail' | 'announcement';
  route_target: string;
}

export interface IvrMenuDefinition {
  id: string;
  greeting: string;
  options: IvrMenuOption[];
  timeout_route_type: 'queue' | 'ai' | 'voicemail';
  timeout_route_target: string;
}

const DEFAULT_MENUS: Record<string, IvrMenuDefinition> = {
  default: {
    id: 'default',
    greeting: '欢迎致电。按 1 转销售队列，按 2 转客服队列，按 0 转语音信箱。',
    options: [
      { digit: '1', label: '销售', route_type: 'queue', route_target: 'sales' },
      { digit: '2', label: '客服', route_type: 'queue', route_target: 'default' },
      { digit: '0', label: '语音信箱', route_type: 'voicemail', route_target: 'default' }
    ],
    timeout_route_type: 'queue',
    timeout_route_target: 'default'
  }
};

export function getIvrMenu(menuId: string): IvrMenuDefinition {
  return DEFAULT_MENUS[menuId] || DEFAULT_MENUS.default;
}

export function resolveIvrSelection(
  menuId: string,
  digit: string | null
): { route_type: string; route_target: string; label: string } {
  const menu = getIvrMenu(menuId);
  if (!digit) {
    return {
      route_type: menu.timeout_route_type,
      route_target: menu.timeout_route_target,
      label: 'timeout'
    };
  }
  const option = menu.options.find((item) => item.digit === digit);
  if (!option) {
    return {
      route_type: menu.timeout_route_type,
      route_target: menu.timeout_route_target,
      label: 'invalid'
    };
  }
  return {
    route_type: option.route_type,
    route_target: option.route_target,
    label: option.label
  };
}
