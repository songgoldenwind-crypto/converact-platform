import type { IveKitChatAttachmentUploadDescriptor, IveKitChatMessage, IveKitChatParticipant } from '@opc/ivekit-sdk';
import { AtSign, FilePlus2, RotateCcw, Send, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

type UploadItem = {
  id: string;
  file: File;
  preview: string;
  progress: number;
  state: 'uploading' | 'ready' | 'failed';
  descriptor?: IveKitChatAttachmentUploadDescriptor;
  abort?: () => void;
  error?: string;
};

export function MessageComposer(props: {
  disabled: boolean;
  participants: IveKitChatParticipant[];
  replyTo: IveKitChatMessage | null;
  forwardFrom: IveKitChatMessage | null;
  onClearRelation(): void;
  onUpload(file: File, onProgress: (percent: number) => void): { result: Promise<IveKitChatAttachmentUploadDescriptor>; abort(): void };
  onSend(input: { body: string; attachments: IveKitChatAttachmentUploadDescriptor[]; reply_to_message_id?: string; forwarded_from_message_id?: string; mentions?: string[] }): Promise<unknown>;
  onTyping(typing: boolean): Promise<void>;
}) {
  const [body, setBody] = useState('');
  const [uploads, setUploads] = useState<UploadItem[]>([]);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState('');
  const [mentionOpen, setMentionOpen] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const typingTimer = useRef<number | null>(null);
  const uploadsRef = useRef<UploadItem[]>([]);
  const typingRef = useRef(props.onTyping);
  const typingActive = useRef(false);
  uploadsRef.current = uploads;
  typingRef.current = props.onTyping;
  useEffect(() => () => {
    if (typingTimer.current) window.clearTimeout(typingTimer.current);
    uploadsRef.current.forEach(disposeUpload);
    if (typingActive.current) void typingRef.current(false).catch(() => undefined);
  }, []);

  const addFiles = (files: File[]) => files.forEach((file) => startUpload(file));
  const startUpload = (file: File, existingId?: string) => {
    const id = existingId || crypto.randomUUID();
    const preview = existingId ? uploads.find((item) => item.id === id)?.preview || '' : file.type.startsWith('image/') ? URL.createObjectURL(file) : '';
    const operation = props.onUpload(file, (percent) => setUploads((items) => items.map((item) => item.id === id ? { ...item, progress: percent } : item)));
    const item: UploadItem = { id, file, preview, progress: 0, state: 'uploading', abort: operation.abort };
    setUploads((items) => existingId ? items.map((old) => old.id === id ? item : old) : [...items, item]);
    operation.result.then((descriptor) => setUploads((items) => items.map((old) => old.id === id ? { ...old, state: 'ready', progress: 100, descriptor, abort: undefined } : old)))
      .catch((cause) => setUploads((items) => items.map((old) => old.id === id ? { ...old, state: 'failed', error: cause instanceof Error ? cause.message : String(cause), abort: undefined } : old)));
  };
  const changed = (value: string) => {
    setBody(value);
    setSendError('');
    emitTyping(Boolean(value.trim()));
    if (typingTimer.current) window.clearTimeout(typingTimer.current);
    typingTimer.current = value.trim() ? window.setTimeout(() => emitTyping(false), 2_000) : null;
  };
  const emitTyping = (typing: boolean) => {
    if (typingActive.current === typing) return;
    typingActive.current = typing;
    void typingRef.current(typing).catch(() => undefined);
  };
  const stopTyping = () => {
    if (typingTimer.current) window.clearTimeout(typingTimer.current);
    typingTimer.current = null;
    emitTyping(false);
  };
  const removeUpload = (id: string) => {
    setUploads((items) => {
      const removed = items.find((item) => item.id === id);
      if (removed) disposeUpload(removed);
      return items.filter((item) => item.id !== id);
    });
  };
  const send = async () => {
    const attachments = uploads.flatMap((item) => item.descriptor ? [item.descriptor] : []);
    if ((!body.trim() && !attachments.length) || uploads.some((item) => item.state !== 'ready')) return;
    setSending(true);
    setSendError('');
    try {
      const active = new Set(props.participants.filter((item) => !item.left_at).map((item) => item.identity));
      const mentions = [...body.matchAll(/@([\w.-]+)/g)].map((match) => match[1]).filter((identity) => active.has(identity));
      await props.onSend({ body: body.trim(), attachments, reply_to_message_id: props.replyTo?.id, forwarded_from_message_id: props.forwardFrom?.id, mentions: [...new Set(mentions)] });
      setBody('');
      uploads.forEach((item) => { if (item.preview) URL.revokeObjectURL(item.preview); });
      setUploads([]);
      props.onClearRelation();
      stopTyping();
    } catch (cause) {
      setSendError(cause instanceof Error ? cause.message : String(cause));
    } finally { setSending(false); }
  };
  const activeParticipants = props.participants.filter((item) => !item.left_at);
  return (
    <div className="composer" onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); if (!props.disabled) addFiles([...event.dataTransfer.files]); }}>
      {sendError && <div className="compose-error" role="alert">{sendError}</div>}
      {(props.replyTo || props.forwardFrom) && <div className="compose-relation"><span>{props.replyTo ? `Reply to ${props.replyTo.sender_identity}` : `Forward ${props.forwardFrom?.id}`}</span><button title="Clear reply or forward" onClick={props.onClearRelation}><X size={14} /></button></div>}
      {!!uploads.length && <div className="upload-list">{uploads.map((item) => <div className={`upload ${item.state}`} key={item.id}>{item.preview && <img src={item.preview} alt="" />}<span>{item.file.name}<small>{item.state === 'uploading' ? `${Math.round(item.progress)}%` : item.error || item.state}</small></span>{item.state === 'uploading' && <button title="Cancel upload" onClick={() => removeUpload(item.id)}><X size={14} /></button>}{item.state === 'failed' && <><button className="icon-button light" title="Retry upload" onClick={() => startUpload(item.file, item.id)}><RotateCcw size={14} /></button><button className="icon-button light" title="Remove attachment" onClick={() => removeUpload(item.id)}><X size={14} /></button></>}</div>)}</div>}
      <div className="compose-row">
        <button className="icon-button light" title="Attach file" disabled={props.disabled} onClick={() => fileInput.current?.click()}><FilePlus2 size={18} /></button>
        <button className="icon-button light" title="Mention participant" disabled={props.disabled || !activeParticipants.length} onClick={() => setMentionOpen((open) => !open)}><AtSign size={18} /></button>
        {mentionOpen && <div className="mention-menu" role="menu">{activeParticipants.map((participant) => <button key={participant.id} title={`Mention ${participant.identity}`} onClick={() => { changed(`${body}${body ? ' ' : ''}@${participant.identity} `); setMentionOpen(false); }}>{participant.display_name || participant.identity}<small>@{participant.identity}</small></button>)}</div>}
        <textarea value={body} disabled={props.disabled} aria-label="Message" placeholder="Write a message" onChange={(event) => changed(event.target.value)} onBlur={stopTyping} onPaste={(event) => { const files = [...event.clipboardData.files]; if (files.length && !props.disabled) { event.preventDefault(); addFiles(files); } }} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void send(); } }} />
        <button className="send-button" title="Send message" disabled={props.disabled || sending || uploads.some((item) => item.state !== 'ready')} onClick={() => void send()}><Send size={17} /><span>Send</span></button>
        <input ref={fileInput} hidden type="file" multiple onChange={(event) => addFiles([...(event.target.files || [])])} />
      </div>
    </div>
  );
}

function disposeUpload(item: UploadItem) {
  item.abort?.();
  if (item.preview) URL.revokeObjectURL(item.preview);
}
