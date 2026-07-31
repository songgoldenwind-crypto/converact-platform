import type { IveKitMediaCallParticipant } from '@converact/sdk';
import type { MediaLayout } from './media-reducer.js';
import { MediaTile } from './media-tile.js';
import { ScreenShareStage } from './screen-share-stage.js';
import type { MediaTrackHandle } from './types.js';

export function ParticipantGrid(props: {
  participants: readonly IveKitMediaCallParticipant[];
  tracks: Readonly<Record<string, MediaTrackHandle>>;
  activeSpeakerIdentities: readonly string[];
  networkQuality: Readonly<Record<string, string>>;
  layout: MediaLayout;
}) {
  const participants = orderParticipants(
    props.participants.filter((participant) => !['left', 'removed'].includes(participant.status)),
    props.activeSpeakerIdentities
  );
  const allTracks = Object.values(props.tracks);
  const share = allTracks.find((track) => track.source === 'screen_share');
  if (share) {
    return <ScreenShareStage
      share={share}
      shareAudio={allTracks.find((track) => track.source === 'screen_share_audio' && track.participantIdentity === share.participantIdentity)}
      participants={participants}
      tracks={props.tracks}
      activeSpeakerIdentities={props.activeSpeakerIdentities}
      networkQuality={props.networkQuality}
    />;
  }
  if (props.layout === 'speaker' && participants.length) {
    return (
      <div className="speaker-layout">
        <div className="speaker-stage">{tile(participants[0], props, false)}</div>
        <div className="speaker-rail">{participants.slice(1).map((participant) => tile(participant, props, true))}</div>
      </div>
    );
  }
  return (
    <div className="participant-grid" data-count={Math.min(9, participants.length)}>
      {participants.map((participant) => tile(participant, props, false))}
    </div>
  );
}

function tile(
  participant: IveKitMediaCallParticipant,
  props: Parameters<typeof ParticipantGrid>[0],
  compact: boolean
) {
  const tracks = Object.values(props.tracks).filter((track) => track.participantIdentity === participant.identity);
  return <MediaTile
    key={participant.identity}
    participant={participant}
    camera={tracks.find((track) => track.source === 'camera')}
    microphone={tracks.find((track) => track.source === 'microphone')}
    speaking={props.activeSpeakerIdentities.includes(participant.identity)}
    networkQuality={props.networkQuality[participant.identity]}
    compact={compact}
  />;
}

function orderParticipants(
  participants: readonly IveKitMediaCallParticipant[],
  activeSpeakers: readonly string[]
): IveKitMediaCallParticipant[] {
  const rank = new Map(activeSpeakers.map((identity, index) => [identity, index]));
  return participants.map((participant, index) => ({ participant, index }))
    .sort((left, right) => (rank.get(left.participant.identity) ?? Number.MAX_SAFE_INTEGER) - (rank.get(right.participant.identity) ?? Number.MAX_SAFE_INTEGER) || left.index - right.index)
    .map(({ participant }) => participant);
}
