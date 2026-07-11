import { CircleAlert, Volume2, WifiOff } from 'lucide-react';
import type { MediaConnectionState } from './media-reducer.js';
export { normalizeNetworkQuality } from './media-reducer.js';

export function NetworkStatus(props: {
  connection: MediaConnectionState;
  autoplayBlocked: boolean;
  fatalReason?: string;
  onStartAudio(): Promise<void>;
}) {
  if (props.connection === 'fatal') return <div className="network-banner fatal" role="alert"><CircleAlert size={15} />{props.fatalReason || 'Media connection failed'}</div>;
  if (props.connection === 'reconnecting' || props.connection === 'offline') return <div className="network-banner" role="status"><WifiOff size={15} />{props.connection === 'reconnecting' ? 'Reconnecting media' : 'Media offline'}{props.autoplayBlocked && <button onClick={() => void props.onStartAudio()}><Volume2 size={14} />Start audio</button>}</div>;
  if (props.autoplayBlocked) return <div className="network-banner" role="status"><Volume2 size={15} />Audio playback blocked<button onClick={() => void props.onStartAudio()}>Start audio</button></div>;
  return null;
}
