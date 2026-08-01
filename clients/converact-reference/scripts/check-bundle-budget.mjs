import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const dist = new URL('../dist/', import.meta.url);
const assets = join(dist.pathname, 'assets');
const budgets = [
  [/^index-.*\.js$/, 334 * 1024, 'initial application'],
  [/^livekit-vendor-.*\.js$/, 520 * 1024, 'LiveKit vendor'],
  [/^media-workspace-.*\.js$/, 80 * 1024, 'media workspace'],
  [/^voice-workspace-.*\.js$/, 35 * 1024, 'voice workspace'],
  [/^play-.*\.js$/, 2 * 1024, 'shared workspace play icon'],
  [/^wifi-off-.*\.js$/, 4 * 1024, 'shared WebPhone status icon'],
  [/^sip-phone-panel-.*\.js$/, 250 * 1024, 'SIP WebPhone'],
  [/^tinode\..*\.js$/, 120 * 1024, 'Tinode provider'],
  [/^rustdesk-workspace-.*\.js$/, 64 * 1024, 'RustDesk workspace'],
  [/^quality-workspace-.*\.js$/, 25 * 1024, 'quality workspace'],
  [/^finding-panel-.*\.js$/, 8 * 1024, 'on-demand finding panel'],
  [/^circle-check-.*\.js$/, 1024, 'shared finding success icon'],
  [/^triangle-alert-.*\.js$/, 1024, 'shared finding warning icon'],
  [/^queue-monitor-workspace-.*\.js$/, 15 * 1024, 'Queue Monitor workspace'],
  [/^ivr-designer-browser-.*\.js$/, 220 * 1024, 'IVR Designer workspace']
];
const files = readdirSync(assets).filter((file) => file.endsWith('.js'));

for (const [pattern, limit, label] of budgets) {
  const matched = files.filter((file) => pattern.test(file));
  if (matched.length !== 1) throw new Error(`${label} chunk missing or duplicated: ${matched.join(', ') || 'none'}`);
  const size = statSync(join(assets, matched[0])).size;
  if (size > limit) throw new Error(`${label} chunk ${size} bytes exceeds ${limit} byte budget`);
}

const known = new Set(budgets.flatMap(([pattern]) => files.filter((file) => pattern.test(file))));
const unknown = files.filter((file) => !known.has(file));
if (unknown.length) throw new Error(`unbudgeted JavaScript chunks: ${unknown.join(', ')}`);

const html = readFileSync(join(dist.pathname, 'index.html'), 'utf8');
if (/livekit-vendor|tinode\.|media-workspace|voice-workspace|sip-phone-panel|wifi-off-|play-|rustdesk-workspace|quality-workspace|finding-panel|circle-check-|triangle-alert-|queue-monitor-workspace|ivr-designer-browser/.test(html)) {
  throw new Error('initial HTML must not preload provider or non-default workspace chunks');
}

process.stdout.write(`Converact Fabric bundle budget passed (${files.length} JavaScript chunks)\n`);
