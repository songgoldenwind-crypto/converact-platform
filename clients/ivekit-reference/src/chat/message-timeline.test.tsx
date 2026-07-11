import assert from 'node:assert/strict';
import { after, afterEach, before, test } from 'node:test';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { installTestDom } from '../test-dom.js';
import type { ChatClientMessage } from './chat-reducer.js';
import { MessageTimeline } from './message-timeline.js';

let closeDom: () => void;
let observeCallback: IntersectionObserverCallback;

before(() => {
  closeDom = installTestDom();
  class TestObserver {
    constructor(callback: IntersectionObserverCallback) { observeCallback = callback; }
    observe() {}
    disconnect() {}
  }
  Object.assign(globalThis, { IntersectionObserver: TestObserver });
});
after(() => { cleanup(); closeDom?.(); });
afterEach(() => cleanup());

test('timeline marks a visible incoming message read only once', () => {
  let reads = 0;
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
  const view = render(<MessageTimeline
    messages={[message()]}
    identity="agent-1"
    canLoadOlder={false}
    onLoadOlder={() => undefined}
    onReply={() => undefined}
    onForward={() => undefined}
    onRetry={() => undefined}
    onReact={() => undefined}
    onPin={() => undefined}
    onEdit={() => undefined}
    onDelete={() => undefined}
    onRead={() => { reads += 1; }}
    onDownload={() => undefined}
  />);
  const article = view.container.querySelector('[data-message-id]') as Element;
  const entry = { isIntersecting: true, target: article } as IntersectionObserverEntry;

  observeCallback([entry], {} as IntersectionObserver);
  assert.equal(reads, 0);
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  document.dispatchEvent(new window.Event('visibilitychange'));
  document.dispatchEvent(new window.Event('visibilitychange'));
  assert.equal(reads, 1);
});

test('timeline shows how many other participants read an outgoing message', () => {
  const props = {
    messages: [{ ...message(), sender_identity: 'agent-1' }],
    identity: 'agent-1',
    receipts: [
      { id: 'receipt-1', message_id: 'message-1', identity: 'customer-1', read_at: '2026-07-11T09:00:00.000Z' },
      { id: 'receipt-2', message_id: 'message-1', identity: 'customer-2', read_at: null }
    ],
    canLoadOlder: false,
    onLoadOlder: () => undefined,
    onReply: () => undefined,
    onForward: () => undefined,
    onRetry: () => undefined,
    onReact: () => undefined,
    onPin: () => undefined,
    onEdit: () => undefined,
    onDelete: () => undefined,
    onRead: () => undefined,
    onDownload: () => undefined
  } as unknown as Parameters<typeof MessageTimeline>[0];
  const view = render(<MessageTimeline {...props} />);
  assert.ok(view.getByText('Read by 1'));
});

test('timeline groups consecutive messages and exposes rich relation, pin, and reaction controls', () => {
  let scrolled = 0;
  let reaction = '';
  const original = { ...message(), id: 'original', body: 'Original context', pinned: true };
  const firstReply = {
    ...message(), id: 'reply-1', sender_identity: 'agent-1', body: 'First reply',
    created_at: '2026-07-11T08:01:00.000Z', reply_to_message_id: 'original'
  };
  const continuation = {
    ...message(), id: 'reply-2', sender_identity: 'agent-1', body: 'Second reply',
    created_at: '2026-07-11T08:02:00.000Z'
  };
  const view = render(<MessageTimeline
    messages={[original, firstReply, continuation]}
    identity="agent-1"
    canLoadOlder={false}
    onLoadOlder={() => undefined}
    onReply={() => undefined}
    onForward={() => undefined}
    onRetry={() => undefined}
    onReact={(_id, emoji) => { reaction = emoji; }}
    onPin={() => undefined}
    onEdit={() => undefined}
    onDelete={() => undefined}
    onRead={() => undefined}
    onDownload={() => undefined}
  />);
  assert.ok(view.getByText('customer-1: Original context'));
  const articles = [...view.container.querySelectorAll('article')];
  assert.ok(articles[2].classList.contains('continuation'));
  Object.defineProperty(articles[0], 'scrollIntoView', { value: () => { scrolled += 1; } });
  fireClick(view.getByTitle('Go to pinned message'));
  assert.equal(scrolled, 1);
  fireClick(view.getAllByTitle('Add reaction')[0]);
  fireClick(view.getByTitle('React with ❤️'));
  assert.equal(reaction, '❤️');
});

function fireClick(element: Element) {
  fireEvent.click(element);
}

function message(): ChatClientMessage {
  return {
    id: 'message-1',
    session_id: 'session-1',
    sender_identity: 'customer-1',
    message_type: 'text',
    body: 'hello',
    mentions: [],
    attachments: [],
    reactions: [],
    created_at: '2026-07-11T08:00:00.000Z',
    deleted_at: null,
    edit_version: 0,
    reply_to_message_id: null,
    forwarded_from_message_id: null,
    provider_delivery: { status: 'delivered' }
  } as unknown as ChatClientMessage;
}
