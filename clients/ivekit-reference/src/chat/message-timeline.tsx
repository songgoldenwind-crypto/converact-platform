import type { IveKitChatMessage, IveKitChatReceipt } from '@opc/ivekit-sdk';
import { Download, Forward, Pencil, Pin, Reply, RotateCcw, SmilePlus, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { ChatClientMessage } from './chat-reducer.js';

export function MessageTimeline(props: {
  messages: ChatClientMessage[];
  identity: string;
  receipts?: IveKitChatReceipt[];
  canLoadOlder: boolean;
  onLoadOlder(): void;
  onReply(message: IveKitChatMessage): void;
  onForward(message: IveKitChatMessage): void;
  onRetry(id: string): void;
  onReact(id: string, emoji: string, remove?: boolean): void;
  onPin(id: string, remove?: boolean): void;
  onEdit(id: string, body: string): void;
  onDelete(id: string): void;
  onRead(id: string): void;
  onDownload(id: string): void;
}) {
  const root = useRef<HTMLDivElement>(null);
  const markedRead = useRef(new Set<string>());
  const visibleIncoming = useRef(new Set<string>());
  const [editing, setEditing] = useState('');
  const [draft, setDraft] = useState('');
  const [reactionFor, setReactionFor] = useState('');
  useEffect(() => {
    if (!root.current || typeof IntersectionObserver !== 'function') return;
    visibleIncoming.current.clear();
    const markVisibleReads = () => {
      if (document.visibilityState !== 'visible') return;
      for (const id of visibleIncoming.current) {
        if (markedRead.current.has(id)) continue;
        markedRead.current.add(id);
        props.onRead(id);
      }
    };
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        const id = (entry.target as HTMLElement).dataset.messageId;
        const sender = (entry.target as HTMLElement).dataset.sender;
        if (!id || sender === props.identity) continue;
        if (entry.isIntersecting) visibleIncoming.current.add(id);
        else visibleIncoming.current.delete(id);
      }
      markVisibleReads();
    }, { root: root.current, threshold: 0.7 });
    root.current.querySelectorAll('[data-message-id]').forEach((element) => observer.observe(element));
    document.addEventListener('visibilitychange', markVisibleReads);
    return () => {
      observer.disconnect();
      document.removeEventListener('visibilitychange', markVisibleReads);
    };
  }, [props.messages, props.identity, props.onRead]);

  let date = '';
  const byId = new Map(props.messages.map((message) => [message.id, message]));
  const pinned = props.messages.filter((message) => message.pinned && !message.deleted_at);
  return (
    <div className="timeline" ref={root}>
      {props.canLoadOlder && <button className="text-command history-command" onClick={props.onLoadOlder}>Load older messages</button>}
      {!!pinned.length && <div className="pinned-strip">
        <Pin size={13} />
        {pinned.map((message) => <button key={message.id} title="Go to pinned message" onClick={() => document.getElementById(messageElementId(message.id))?.scrollIntoView({ block: 'center', behavior: 'smooth' })}>{messageSnippet(message)}</button>)}
      </div>}
      {props.messages.map((message, index) => {
        const nextDate = new Date(message.created_at).toLocaleDateString();
        const separator = nextDate !== date;
        date = nextDate;
        const mine = message.sender_identity === props.identity;
        const previous = props.messages[index - 1];
        const continuation = !separator && isContinuation(previous, message);
        return <div key={message.id}>
          {separator && <div className="date-separator"><span>{nextDate}</span></div>}
          <article id={messageElementId(message.id)} className={`${mine ? 'message mine' : 'message'}${continuation ? ' continuation' : ''}`} data-message-id={message.id} data-sender={message.sender_identity}>
            {!continuation && <header><strong>{message.sender_identity}</strong><time>{new Date(message.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time>{message.pinned && <Pin size={12} />}</header>}
            {message.reply_to_message_id && <div className="relation">Reply · <span>{relationLabel(message.reply_to_message_id, byId)}</span></div>}
            {message.forwarded_from_message_id && <div className="relation">Forwarded · <span>{relationLabel(message.forwarded_from_message_id, byId)}</span></div>}
            {editing === message.id ? <div className="inline-edit"><textarea value={draft} onChange={(event) => setDraft(event.target.value)} /><button onClick={() => { props.onEdit(message.id, draft); setEditing(''); }}>Save</button><button onClick={() => setEditing('')}>Cancel</button></div> : <p className={message.deleted_at ? 'deleted' : ''}>{message.deleted_at ? 'Message deleted' : renderMentions(message.body, message.mentions)}</p>}
            {message.edited_at && !message.deleted_at && <small className="edited-label">Edited</small>}
            {message.attachments.map((attachment) => <div className="attachment-row" key={attachment.id}><span>{attachment.filename || attachment.kind}</span><small>{attachment.processing_status}</small><button className="icon-button light" title="Download attachment" onClick={() => props.onDownload(attachment.id)}><Download size={14} /></button></div>)}
            {!!message.reactions?.length && <div className="reactions">{aggregateReactions(message.reactions).map(([emoji, count]) => <button key={emoji} onClick={() => props.onReact(message.id, emoji, message.reactions?.some((item) => item.emoji === emoji && item.identity === props.identity))}>{emoji} {count}</button>)}</div>}
            <footer>
              {!message.deleted_at && <><button title="Reply" onClick={() => props.onReply(message)}><Reply size={14} /></button><button title="Forward" onClick={() => props.onForward(message)}><Forward size={14} /></button><button title="Add reaction" onClick={() => setReactionFor((current) => current === message.id ? '' : message.id)}><SmilePlus size={14} /></button><button title={message.pinned ? 'Unpin' : 'Pin'} onClick={() => props.onPin(message.id, message.pinned)}><Pin size={14} /></button>{reactionFor === message.id && <span className="reaction-picker" role="menu">{REACTION_EMOJIS.map((emoji) => <button key={emoji} title={`React with ${emoji}`} onClick={() => { props.onReact(message.id, emoji); setReactionFor(''); }}>{emoji}</button>)}</span>}</>}
              {mine && !message.deleted_at && !message.id.startsWith('local-') && <><button title="Edit" onClick={() => { setEditing(message.id); setDraft(message.body); }}><Pencil size={14} /></button><button title="Delete" onClick={() => props.onDelete(message.id)}><Trash2 size={14} /></button></>}
              {(message.client_state === 'retry_wait' || message.client_state === 'failed') && <button className="retry" title="Retry send" onClick={() => props.onRetry(message.id)}><RotateCcw size={14} /> Retry</button>}
              <span className={`delivery ${message.client_state || message.provider_delivery.status}`}>{deliveryLabel(message, props.receipts || [], props.identity)}</span>
            </footer>
          </article>
        </div>;
      })}
      {!props.messages.length && <p className="empty">No messages</p>}
    </div>
  );
}

const REACTION_EMOJIS = ['👍', '❤️', '😂', '🎉', '👀'];

function isContinuation(previous: ChatClientMessage | undefined, message: ChatClientMessage): boolean {
  if (!previous || previous.sender_identity !== message.sender_identity) return false;
  const gap = new Date(message.created_at).getTime() - new Date(previous.created_at).getTime();
  return gap >= 0 && gap <= 5 * 60_000;
}

function relationLabel(messageId: string, messages: Map<string, ChatClientMessage>): string {
  const target = messages.get(messageId);
  return target ? `${target.sender_identity}: ${messageSnippet(target)}` : 'Original message unavailable';
}

function messageSnippet(message: ChatClientMessage): string {
  if (message.deleted_at) return 'Message deleted';
  const body = message.body.trim() || `[${message.message_type}]`;
  return body.length > 80 ? `${body.slice(0, 77)}...` : body;
}

function messageElementId(messageId: string): string {
  return `message-${messageId}`;
}

function renderMentions(body: string, mentions: string[]) {
  if (!mentions.length) return body;
  const parts = body.split(/(@[\w.-]+)/g);
  return parts.map((part, index) => mentions.includes(part.slice(1)) ? <mark key={`${part}-${index}`}>{part}</mark> : part);
}

function aggregateReactions(reactions: NonNullable<IveKitChatMessage['reactions']>): Array<[string, number]> {
  const counts = new Map<string, number>();
  reactions.forEach((item) => counts.set(item.emoji, (counts.get(item.emoji) || 0) + 1));
  return [...counts];
}

function deliveryLabel(message: ChatClientMessage, receipts: IveKitChatReceipt[], identity: string): string {
  if (message.client_state === 'sending') return 'Sending';
  if (message.client_state === 'retry_wait') return 'Retry waiting';
  if (message.client_state === 'failed') return 'Failed';
  if (message.sender_identity === identity) {
    const readers = new Set(receipts
      .filter((receipt) => receipt.message_id === message.id && receipt.identity !== identity && receipt.read_at)
      .map((receipt) => receipt.identity));
    if (readers.size) return `Read by ${readers.size}`;
  }
  return message.provider_delivery.status.replaceAll('_', ' ');
}
