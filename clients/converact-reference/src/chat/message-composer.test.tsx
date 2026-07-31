import assert from 'node:assert/strict';
import { after, afterEach, test } from 'node:test';
import { installTestDom } from '../test-dom.js';

const closeDom = installTestDom();
const { cleanup, fireEvent, render, waitFor } = await import('@testing-library/react');
const { MessageComposer } = await import('./message-composer.js');

after(() => { cleanup(); closeDom(); });
afterEach(() => cleanup());

test('composer blocks send until every attachment is ready and failed uploads can be removed', async () => {
  let rejectUpload!: (cause: Error) => void;
  const uploadResult = new Promise<never>((_, reject) => { rejectUpload = reject; });
  const view = render(<MessageComposer
    disabled={false}
    participants={[]}
    replyTo={null}
    forwardFrom={null}
    onClearRelation={() => undefined}
    onUpload={() => ({ result: uploadResult, abort: () => undefined })}
    onSend={async () => undefined}
    onTyping={async () => undefined}
  />);

  const fileInput = view.container.querySelector('input[type="file"]') as HTMLInputElement;
  fireEvent.change(fileInput, { target: { files: [new File(['x'], 'proof.txt', { type: 'text/plain' })] } });
  fireEvent.change(view.getByLabelText('Message'), { target: { value: 'hello' } });
  assert.equal((view.getByTitle('Send message') as HTMLButtonElement).disabled, true);

  rejectUpload(new Error('upload failed'));
  await waitFor(() => assert.ok(view.getByText('upload failed')));
  assert.equal((view.getByTitle('Send message') as HTMLButtonElement).disabled, true);
  fireEvent.click(view.getByTitle('Remove attachment'));
  await waitFor(() => assert.equal(view.queryByText('proof.txt'), null));
  assert.equal((view.getByTitle('Send message') as HTMLButtonElement).disabled, false);
});

test('composer aborts active uploads and revokes previews when unmounted', async () => {
  const originalCreate = URL.createObjectURL;
  const originalRevoke = URL.revokeObjectURL;
  const revoked: string[] = [];
  let aborted = 0;
  URL.createObjectURL = () => 'blob:preview';
  URL.revokeObjectURL = (value) => { revoked.push(value); };
  try {
    const view = render(<MessageComposer
      disabled={false}
      participants={[]}
      replyTo={null}
      forwardFrom={null}
      onClearRelation={() => undefined}
      onUpload={() => ({ result: new Promise(() => undefined), abort: () => { aborted += 1; } })}
      onSend={async () => undefined}
      onTyping={async () => undefined}
    />);
    const fileInput = view.container.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(fileInput, { target: { files: [new File(['x'], 'photo.png', { type: 'image/png' })] } });
    await waitFor(() => assert.ok(view.getByText('photo.png')));
    view.unmount();
    assert.equal(aborted, 1);
    assert.deepEqual(revoked, ['blob:preview']);
  } finally {
    URL.createObjectURL = originalCreate;
    URL.revokeObjectURL = originalRevoke;
  }
});

test('composer lets the user choose which active participant to mention', () => {
  const view = render(<MessageComposer
    disabled={false}
    participants={[
      { id: 'p1', identity: 'agent-1', display_name: 'Agent', left_at: null },
      { id: 'p2', identity: 'customer-1', display_name: 'Customer', left_at: null }
    ] as never}
    replyTo={null}
    forwardFrom={null}
    onClearRelation={() => undefined}
    onUpload={() => ({ result: new Promise(() => undefined), abort: () => undefined })}
    onSend={async () => undefined}
    onTyping={async () => undefined}
  />);
  fireEvent.click(view.getByTitle('Mention participant'));
  fireEvent.click(view.getByTitle('Mention customer-1'));
  assert.equal((view.getByLabelText('Message') as HTMLTextAreaElement).value, '@customer-1 ');
});

test('composer displays send errors and keeps the draft', async () => {
  const view = render(<MessageComposer
    disabled={false}
    participants={[]}
    replyTo={null}
    forwardFrom={null}
    onClearRelation={() => undefined}
    onUpload={() => ({ result: new Promise(() => undefined), abort: () => undefined })}
    onSend={async () => { throw new Error('message rejected'); }}
    onTyping={async () => undefined}
  />);
  fireEvent.input(view.getByLabelText('Message'), { target: { value: 'keep this' } });
  fireEvent.click(view.getByTitle('Send message'));
  await waitFor(() => assert.ok(view.getByRole('alert').textContent?.includes('message rejected')));
  assert.equal((view.getByLabelText('Message') as HTMLTextAreaElement).value, 'keep this');
});

test('composer emits typing true once and clears it on blur', async () => {
  const typing: boolean[] = [];
  const view = render(<MessageComposer
    disabled={false}
    participants={[]}
    replyTo={null}
    forwardFrom={null}
    onClearRelation={() => undefined}
    onUpload={() => ({ result: new Promise(() => undefined), abort: () => undefined })}
    onSend={async () => undefined}
    onTyping={async (value) => { typing.push(value); }}
  />);
  const input = view.getByLabelText('Message');
  fireEvent.input(input, { target: { value: 'h' } });
  fireEvent.input(input, { target: { value: 'he' } });
  fireEvent.blur(input);
  await waitFor(() => assert.deepEqual(typing, [true, false]));
});
