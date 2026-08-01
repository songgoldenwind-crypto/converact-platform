import { useCallback, useRef, useState } from 'react';
import { getTenantId } from '../api/client';
import { readAuthStorage } from '../auth-storage';

export type ScreenRecordingStatus = 'idle' | 'recording' | 'uploading';

export function useScreenRecording() {
  const [status, setStatus] = useState<ScreenRecordingStatus>('idle');
  const [error, setError] = useState('');
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);
  const startedAtRef = useRef<number>(0);
  const contextRef = useRef<{ callSessionId?: string; seatId?: string }>({});

  const stopTracks = useCallback(() => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
  }, []);

  const uploadRecording = useCallback(async (blob: Blob, durationSec: number) => {
    const params = new URLSearchParams();
    if (contextRef.current.callSessionId) params.set('call_session_id', contextRef.current.callSessionId);
    if (contextRef.current.seatId) params.set('seat_id', contextRef.current.seatId);
    params.set('duration_sec', String(durationSec));
    const token = readAuthStorage('token');
    const apiKey = readAuthStorage('api_key');
    const headers: Record<string, string> = {
      'Content-Type': 'video/webm',
      'X-Filename': `screen-${Date.now()}.webm`
    };
    if (token) headers.Authorization = `Bearer ${token}`;
    else if (apiKey) headers['X-API-Key'] = apiKey;
    headers['X-Tenant-Id'] = getTenantId();

    const res = await fetch(`/api/call-center/screen-recordings/upload?${params.toString()}`, {
      method: 'POST',
      headers,
      body: blob
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(text || `upload failed: ${res.status}`);
    }
    return res.json();
  }, []);

  const startRecording = useCallback(
    async (opts: { callSessionId?: string; seatId?: string }) => {
      setError('');
      if (status === 'recording') return;
      if (!navigator.mediaDevices?.getDisplayMedia) {
        setError('当前浏览器不支持屏幕录制');
        return;
      }
      try {
        const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
        streamRef.current = stream;
        chunksRef.current = [];
        contextRef.current = opts;
        const recorder = new MediaRecorder(stream);
        mediaRecorderRef.current = recorder;
        recorder.ondataavailable = (event) => {
          if (event.data.size > 0) chunksRef.current.push(event.data);
        };
        recorder.onstop = () => {
          void (async () => {
            setStatus('uploading');
            const durationSec = Math.max(1, Math.round((Date.now() - startedAtRef.current) / 1000));
            const blob = new Blob(chunksRef.current, { type: 'video/webm' });
            try {
              await uploadRecording(blob, durationSec);
            } catch (e) {
              setError(e instanceof Error ? e.message : '上传录屏失败');
            } finally {
              stopTracks();
              mediaRecorderRef.current = null;
              setStatus('idle');
            }
          })();
        };
        stream.getVideoTracks()[0]?.addEventListener('ended', () => {
          if (mediaRecorderRef.current?.state === 'recording') mediaRecorderRef.current.stop();
        });
        startedAtRef.current = Date.now();
        recorder.start(1000);
        setStatus('recording');
      } catch (e) {
        stopTracks();
        setError(e instanceof Error ? e.message : '无法开始屏幕录制');
        setStatus('idle');
      }
    },
    [status, stopTracks, uploadRecording]
  );

  const stopRecording = useCallback(() => {
    if (mediaRecorderRef.current?.state === 'recording') {
      mediaRecorderRef.current.stop();
    } else {
      stopTracks();
      setStatus('idle');
    }
  }, [stopTracks]);

  return {
    screenRecordingStatus: status,
    screenRecordingError: error,
    startScreenRecording: startRecording,
    stopScreenRecording: stopRecording,
    isScreenRecording: status === 'recording'
  };
}
