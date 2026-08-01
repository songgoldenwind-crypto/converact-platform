export const RUSTDESK_WINDOWS_CAPABILITY_OPTIONS = [
  'access-mode',
  'allow-auto-record-incoming',
  'allow-remote-config-modification',
  'approve-mode',
  'disable-clipboard',
  'displays-as-individual-windows',
  'enable-audio',
  'enable-block-input',
  'enable-camera',
  'enable-clipboard',
  'enable-file-copy-paste',
  'enable-file-transfer',
  'enable-keyboard',
  'enable-perm-change-in-accept-window',
  'enable-privacy-mode',
  'enable-record-session',
  'enable-remote-printer',
  'enable-remote-restart',
  'enable-terminal',
  'enable-tunnel',
  'show-monitors-toolbar'
] as const;

export type RustDeskWindowsCapabilityOption = typeof RUSTDESK_WINDOWS_CAPABILITY_OPTIONS[number];

export interface RustDeskWindowsCapabilityPolicy {
  schema_version: 1;
  platform: 'windows';
  architecture: 'x86_64';
  client_version: '1.4.9';
  access_mode: 'attended';
  scopes: [
    'view_screen',
    'control_mouse_keyboard',
    'clipboard',
    'transfer_file',
    'record_screen'
  ];
  scope_option_map: {
    view_screen: ['access-mode', 'show-monitors-toolbar'];
    control_mouse_keyboard: ['enable-keyboard'];
    clipboard: ['enable-clipboard', 'disable-clipboard'];
    transfer_file: ['enable-file-transfer', 'enable-file-copy-paste'];
    record_screen: ['enable-record-session', 'allow-auto-record-incoming'];
  };
  options: Record<RustDeskWindowsCapabilityOption, string>;
  enforcement: {
    apply: 'rustdesk_cli_option';
    verify: 'rustdesk_cli_readback';
    drift: 'fail_closed';
    per_session_authority: 'converact_consent_authorization_and_control_lock';
  };
}

export function createRustDeskWindowsCapabilityPolicy(): RustDeskWindowsCapabilityPolicy {
  return {
    schema_version: 1,
    platform: 'windows',
    architecture: 'x86_64',
    client_version: '1.4.9',
    access_mode: 'attended',
    scopes: [
      'view_screen',
      'control_mouse_keyboard',
      'clipboard',
      'transfer_file',
      'record_screen'
    ],
    scope_option_map: {
      view_screen: ['access-mode', 'show-monitors-toolbar'],
      control_mouse_keyboard: ['enable-keyboard'],
      clipboard: ['enable-clipboard', 'disable-clipboard'],
      transfer_file: ['enable-file-transfer', 'enable-file-copy-paste'],
      record_screen: ['enable-record-session', 'allow-auto-record-incoming']
    },
    options: {
      'access-mode': 'custom',
      'allow-auto-record-incoming': 'N',
      'allow-remote-config-modification': 'N',
      'approve-mode': 'click',
      'disable-clipboard': 'N',
      'displays-as-individual-windows': 'N',
      'enable-audio': 'N',
      'enable-block-input': 'N',
      'enable-camera': 'N',
      'enable-clipboard': 'Y',
      'enable-file-copy-paste': 'Y',
      'enable-file-transfer': 'Y',
      'enable-keyboard': 'Y',
      'enable-perm-change-in-accept-window': 'N',
      'enable-privacy-mode': 'N',
      'enable-record-session': 'Y',
      'enable-remote-printer': 'N',
      'enable-remote-restart': 'N',
      'enable-terminal': 'N',
      'enable-tunnel': 'N',
      'show-monitors-toolbar': 'Y'
    },
    enforcement: {
      apply: 'rustdesk_cli_option',
      verify: 'rustdesk_cli_readback',
      drift: 'fail_closed',
      per_session_authority: 'converact_consent_authorization_and_control_lock'
    }
  };
}
