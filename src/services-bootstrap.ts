/**
 * Services bootstrap.
 *
 * Historically this module wired the entire lead-acquisition internal
 * dependency graph (shared-deps injection, run-detail bridges, public-
 * source discover host, prospect outreach query services, ~150 builder
 * function bindings across 80+ files). That wiring has been retired
 * together with the lead-acquisition module (legacy, archived out of repo).
 *
 * The file is intentionally kept as a near-empty module so that
 * `import './services-bootstrap.js'` (called from services.ts) continues
 * to work without breaking callers. New call-center wiring lives in
 * src/agent-runtime/index.ts (createHarness) and the call-center
 * submodules themselves.
 *
 * If you need to wire platform-level services that don't belong to a
 * dedicated call-center submodule, add them here.
 */

// Intentionally empty. Lead-acquisition wiring has been archived.
export {};
