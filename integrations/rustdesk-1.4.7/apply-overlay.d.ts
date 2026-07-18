export const RUSTDESK_UPSTREAM_TAG: '1.4.7';
export const RUSTDESK_UPSTREAM_COMMIT: '0c86d4616298f09435f6236599b300964aa61460';
export function patchIveKitRustDeskSources(input: {
  lib: string;
  connectionManager: string;
}): {
  lib: string;
  connectionManager: string;
};
export function applyIveKitRustDeskOverlay(sourceRoot: string): {
  libPath: string;
  cmPath: string;
  modulePath: string;
  evidenceModulePath: string;
};
