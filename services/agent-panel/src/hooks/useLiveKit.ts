import { useEffect, useRef, useState } from 'react';
import { Room, RoomEvent, Track } from 'livekit-client';

export function useLiveKit(roomName: string | null, token: string | null) {
  const [connected, setConnected] = useState(false);
  const roomRef = useRef<Room | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);

  useEffect(() => {
    if (!roomName || !token) return;
    const room = new Room();
    roomRef.current = room;
    void room
      .connect(import.meta.env.VITE_LIVEKIT_URL || 'ws://localhost:7880', token)
      .then(async () => {
        await room.localParticipant.setMicrophoneEnabled(true);
        await room.localParticipant.setCameraEnabled(true);
        setConnected(true);
      })
      .catch(() => setConnected(false));

    room.on(RoomEvent.TrackSubscribed, (track) => {
      if (track.kind === Track.Kind.Video && videoRef.current) {
        track.attach(videoRef.current);
      }
    });

    return () => {
      void room.disconnect();
      roomRef.current = null;
      setConnected(false);
    };
  }, [roomName, token]);

  return { connected, videoRef, room: roomRef };
}
