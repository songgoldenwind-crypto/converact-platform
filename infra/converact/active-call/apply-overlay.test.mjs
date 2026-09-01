import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  patchAppState,
  patchCallHandler,
  patchEventJournalAppState,
  patchEventJournalCallHandler,
  patchEventStream,
  patchHandlerModule,
  patchInvitationHandler,
  patchPlaybookHandler,
  patchPlaybookRunner,
  patchRouter
} from './apply-overlay.mjs';

const sourceRoot = '/Users/songjinfeng/Projects/converact-sources/active-call/src';
const source = (path) => readFileSync(`${sourceRoot}/${path}`, 'utf8');
const eventJournal = readFileSync(
  new URL('./platform-event-journal.rs', import.meta.url),
  'utf8'
);

test('platform reservation is bound to the SIP leg and not a static Playbook', () => {
  const patched = patchInvitationHandler(source('useragent/playbook_handler.rs'));

  assert.match(patched, /X-Converact-Agent-Session/);
  assert.match(patched, /platform_session_identity/);
  assert.match(patched, /if platform_owned \{ None \} else \{ Some\(playbook\) \}/);
  assert.match(patched, /reserved Playbook is consumed by session identity/);
});

test('platform reservation has an attached then explicitly started gate', () => {
  const app = patchAppState(source('app.rs'));
  const handler = patchPlaybookHandler(source('handler/playbook.rs'));
  const call = patchCallHandler(source('handler/handler.rs'));
  const runner = patchPlaybookRunner(source('playbook/runner.rs'));
  const router = patchRouter(source('handler/handler.rs'));

  assert.match(app, /platform_playbook_gates/);
  assert.match(handler, /PlatformPlaybookState::Attached/);
  assert.match(handler, /PlatformPlaybookState::MediaReady/);
  assert.match(handler, /PlatformPlaybookState::DisclosureCompleted/);
  assert.match(handler, /claim_platform_playbook/);
  assert.match(handler, /observe_platform_lifecycle/);
  assert.match(handler, /start_playbook_conversation/);
  assert.match(call, /new_with_start_gate/);
  assert.match(runner, /wait_for_platform_start/);
  assert.match(router, /reservations\/\{session_id\}\/start/);
});

test('platform event journal provides bounded resumable semantic events', () => {
  const app = patchEventJournalAppState(patchAppState(source('app.rs')));
  const call = patchEventStream(
    patchEventJournalCallHandler(patchCallHandler(source('handler/handler.rs')))
  );
  const module = patchHandlerModule(source('handler/mod.rs'));

  assert.match(app, /platform_event_journals/);
  assert.match(app, /retain_platform_event_journals/);
  assert.match(call, /attach_platform_event_journal/);
  assert.match(call, /Last-Event-ID/);
  assert.match(call, /stream_platform_events/);
  assert.match(module, /platform_event_journal/);
  assert.match(eventJournal, /StatusCode::GONE/);
  assert.match(eventJournal, /PLATFORM_EVENT_CAPACITY/);
  assert.match(eventJournal, /mark_coverage_gap/);
});

test('all new transforms are idempotent', () => {
  const transforms = [
    [patchAppState, 'app.rs'],
    [patchHandlerModule, 'handler/mod.rs'],
    [patchPlaybookHandler, 'handler/playbook.rs'],
    [patchCallHandler, 'handler/handler.rs'],
    [patchInvitationHandler, 'useragent/playbook_handler.rs'],
    [patchPlaybookRunner, 'playbook/runner.rs'],
    [patchRouter, 'handler/handler.rs']
  ];

  for (const [transform, path] of transforms) {
    const once = transform(source(path));
    assert.equal(transform(once), once, path);
  }

  const appWithGates = patchAppState(source('app.rs'));
  const appWithJournal = patchEventJournalAppState(appWithGates);
  assert.equal(patchEventJournalAppState(appWithJournal), appWithJournal);

  const callWithGates = patchCallHandler(source('handler/handler.rs'));
  const callWithJournal = patchEventJournalCallHandler(callWithGates);
  assert.equal(patchEventJournalCallHandler(callWithJournal), callWithJournal);
  const callWithStream = patchEventStream(callWithJournal);
  assert.equal(patchEventStream(callWithStream), callWithStream);
});
