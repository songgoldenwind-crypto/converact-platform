/**
 * Platform services barrel.
 *
 * Re-exports the platform module (tenant, channel, landing, tasks,
 * analytics, scoring, events, leads, script-efficacy) and triggers
 * services-bootstrap side effects.
 *
 * Lead-acquisition specific exports have been removed (module archived out of repo). Call-center voice
 * services are imported directly from their submodules.
 */
export * from './platform/index.js';
import './services-bootstrap.js';
