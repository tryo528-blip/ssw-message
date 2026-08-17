import { useEffect, useRef, useState } from 'react';
import { compose, sendNow } from '../lib/api';
import { captureFrame, openCamera, photoCaptureAllowed, stopStream } from '../lib/camera';
import { getProvision, getSettings } from '../lib/store';
import { PHOTO_MAX, type Screen } from '../lib/types';

type Shot = { bytes: Uint8Array; w: number; h: number; thumb: HTMLCanvasElement };

function Thumb({ shot, onDel }: { shot: Shot; onDel: () => void }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    c.width = c.height = 128;
    c.getContext('2d')!.drawImage(shot.thumb, 0, 0);
  }, [shot]);
  return (
    <div className="shot">
      <canvas ref={ref} />
      <button className="x" onClick={onDel}>×</button>
    </div>
  );
}

export function Camera({ go }: { go: (s: Screen) => void }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [facing, setFacing] = useState<'environment' | 'user'>('environment');
  const [shots, setShots] = useState<Shot[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [ready, setReady] = useState(false);
  const [blocked, setBlocked] = useState(false);

  async function start(nextFacing = facing) {
    const allowed = photoCaptureAllowed((await getSettings()).iosVerdict);
    if (!allowed) {
      setBlocked(true);
      setReady(false);
      return;
    }
    stopStream(streamRef.current);
    streamRef.current = null;
    try {
      const s = await openCamera(nextFacing);
      streamRef.current = s;
      const v = videoRef.current;
      if (v) {
        v.setAttribute('playsinline', 'true');
        v.srcObject = s;
        await v.play().catch(() => {});
      }
      setReady(true);
      setErr('');
    } catch (e) {
      setReady(false);
      setErr('카메라 실패: ' + (e instanceof Error ? e.message : String(e)));
    }
  }

  useEffect(() => {
    void start();
    const hide = () => {
      if (document.hidden) {
        stopStream(streamRef.current);
        streamRef.current = null;
      }
    };
    addEventListener('visibilitychange', hide);
    addEventListener('pagehide', hide);
    return () => {
      removeEventListener('visibilitychange', hide);
      removeEventListener('pagehide', hide);
      stopStream(streamRef.current);
      streamRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function shoot() {
    const v = videoRef.current;
    if (!v || shots.length >= PHOTO_MAX) return;
    try {
      const settings = await getSettings();
      const shot = await captureFrame(v, settings.maxEdge, 0.8);
      setShots(s => [...s, shot]);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }

  function remove(i: number) {
    setShots(s => s.filter((_, j) => j !== i));
  }

  async function flip() {
    const next = facing === 'environment' ? 'user' : 'environment';
    setFacing(next);
    await start(next);
  }

  async function submit() {
    if (!shots.length) return;
    setBusy(true); setErr('');
    const photos = shots.map(s => s.bytes);
    setShots([]);
    try {
      const provision = await getProvision();
      if (!provision) { go('settings'); return; }
      const item = await compose({
        provision,
        settings: await getSettings(),
        photos
      });
      photos.forEach((_, i) => { photos[i] = new Uint8Array(0); });
      const next = await sendNow(item);
      if (next.status === 'rejected') setErr(next.error || '거부됨');
      else go('home');
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  }

  return (
    <div className="wrap">
      <div className="top">
        <button className="sec" onClick={() => { stopStream(streamRef.current); go('home'); }}>취소</button>
        <h1>카메라</h1>
        <span className="dim">촬영됨 {shots.length}장</span>
      </div>
      {blocked && (
        <div className="banner">
          아이폰을 <b>갤러리에 남음</b>으로 가정 중입니다. 웹에는 대체 촬영법이 없습니다.
          메모는 보낼 수 있습니다. 실측이 “안 남음”이면 설정에서 가정을 바꾸면 됩니다.
        </div>
      )}
      <video ref={videoRef} playsInline muted autoPlay hidden={blocked} />
      <div className="row" style={{ marginTop: 8 }}>
        <button className="sec" onClick={() => void start()} disabled={busy}>카메라 켜기</button>
        <button className="sec" onClick={() => void flip()} disabled={!ready || busy}>전/후면</button>
      </div>
      <div className="strip">
        {shots.map((s, i) => (
          <Thumb key={i} shot={s} onDel={() => remove(i)} />
        ))}
      </div>
      {err && <p className="err">{err}</p>}
      <div className="cam-actions">
        <button onClick={() => void shoot()} disabled={blocked || !ready || busy || shots.length >= PHOTO_MAX}>● 촬영</button>
        <button style={{ marginTop: 8 }} onClick={() => void submit()} disabled={blocked || !shots.length || busy}>
          {busy ? '암호화 · 전송 중…' : '전송 →'}
        </button>
        <p className="note">🔒 암호화 전송 · 기기에 저장 안 됨</p>
      </div>
    </div>
  );
}
