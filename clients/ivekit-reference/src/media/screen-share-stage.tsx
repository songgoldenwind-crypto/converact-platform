import type { IveKitMediaCallParticipant } from '@opc/ivekit-sdk';
import { AttachedTrack, MediaTile } from './media-tile.js';
import type { MediaTrackHandle } from './types.js';

export function ScreenShareStage(props: {
  share: MediaTrackHandle;
  shareAudio?: MediaTrackHandle;
  participants: readonly IveKitMediaCallParticipant[];
  tracks: Readonly<Record<string, MediaTrackHandle>>;
  activeSpeakerIdentities: readonly string[];
  networkQuality: Readonly<Record<string, string>>;
}) {
  return (
    <div className="screen-share-layout">
      <div className="screen-share-stage" aria-label={`Screen shared by ${props.share.participantIdentity}`}>
        <AttachedTrack track={props.share} label={`Shared screen video from ${props.share.participantIdentity}`} />
        {props.shareAudio && <AttachedTrack track={props.shareAudio} label={`Screen audio from ${props.share.participantIdentity}`} />}
      </div>
      <div className="screen-share-rail">
        {props.participants.map((participant) => {
          const participantTracks = tracksFor(props.tracks, participant.identity);
          return <MediaTile
            key={participant.identity}
            participant={participant}
            camera={participantTracks.find((track) => track.source === 'camera')}
            microphone={participantTracks.find((track) => track.source === 'microphone')}
            speaking={props.activeSpeakerIdentities.includes(participant.identity)}
            networkQuality={props.networkQuality[participant.identity]}
            compact
          />;
        })}
      </div>
    </div>
  );
}

function tracksFor(tracks: Readonly<Record<string, MediaTrackHandle>>, identity: string): MediaTrackHandle[] {
  return Object.values(tracks).filter((track) => track.participantIdentity === identity);
}
