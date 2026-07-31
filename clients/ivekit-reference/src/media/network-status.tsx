import { CircleAlert, Presentation, Volume2, WifiOff, X } from 'lucide-react';
import type { MediaConnectionState } from './media-reducer.js';
export { normalizeNetworkQuality } from './media-reducer.js';

export function NetworkStatus(props: {
  connection: MediaConnectionState;
  autoplayBlocked: boolean;
  fatalReason?: string;
  screenShareRecoveryRequired?: boolean;
  onStartAudio(): Promise<void>;
  onResumeScreenShare?: () => Promise<void>;
  onDismissScreenShareRecovery?: () => void;
}) {
  if (props.connection === 'fatal') return <div className="network-banner fatal" role="alert"><CircleAlert size={15} />{props.fatalReason || 'Media connection failed'}</div>;
  if (props.connection === 'reconnecting' || props.connection === 'offline') return <div className="network-banner" role="status"><WifiOff size={15} />{props.connection === 'reconnecting' ? 'Reconnecting media' : 'Media offline'}{props.autoplayBlocked && <button onClick={() => void props.onStartAudio()}><Volume2 size={14} />Start audio</button>}</div>;
  if (props.screenShareRecoveryRequired && props.onResumeScreenShare && props.onDismissScreenShareRecovery) return <div className="network-banner" role="status"><Presentation size={15} />Screen sharing stopped during reconnect<button onClick={() => void props.onResumeScreenShare?.()}>Resume sharing</button><button title="Dismiss screen sharing recovery" aria-label="Dismiss screen sharing recovery" onClick={props.onDismissScreenShareRecovery}><X size={14} /></button></div>;
  if (props.autoplayBlocked) return <div className="network-banner" role="status"><Volume2 size={15} />Audio playback blocked<button onClick={() => void props.onStartAudio()}>Start audio</button></div>;
  return null;
}
