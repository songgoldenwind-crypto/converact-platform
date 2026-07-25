export const RUSTDESK_UPSTREAM_TAG: '1.4.9';
export const RUSTDESK_UPSTREAM_COMMIT: '6c578292e8ebbbec708b76986ba8c4bc7c509747';
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
