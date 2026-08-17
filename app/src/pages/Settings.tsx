import { useEffect, useRef, useState } from 'react';
import { parseProvision } from '../lib/api';
import { openCamera, stopStream } from '../lib/camera';
import { scanQrOnce } from '../lib/qr-scan';
import { clearProvision, defaultSettings, getProvision, getSettings, setProvision, setSettings } from '../lib/store';
import type { IosVerdict, Screen, Settings as SettingsT } from '../lib/types';

export function Settings({ go }: { go: (s: Screen) => void }) {
  const [raw, setRaw] = useState('');
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const [user, setUser] = useState('');
  const [device, setDevice] = useState('');
  const [site, setSite] = useState('');
  const [maxEdge, setMaxEdge] = useState<SettingsT['maxEdge']>(1600);
  const [iosVerdict, setIosVerdict] = useState<IosVerdict>('assume-safe');
  const [url, setUrl] = useState('');
  const [scanning, setScanning] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const scanTimer = useRef<number | null>(null);

  useEffect(() => {
    void (async () => {
      const p = await getProvision();
      const s = await getSettings();
      if (p) {
        setUser(p.user);
        setDevice(p.device_id);
        setUrl(p.url);
      }
      setSite(s.site);
      setMaxEdge(s.maxEdge);
      setIosVerdict(s.iosVerdict || 'assume-safe');
    })();
  }, []);

  function stopScan() {
    if (scanTimer.current) cancelAnimationFrame(scanTimer.current);
    scanTimer.current = null;
    stopStream(streamRef.current);
    streamRef.current = null;
    setScanning(false);
  }

  useEffect(() => {
    if (!scanning) return;
    let cancelled = false;
    void (async () => {
      try {
        const s = await openCamera('environment');
        if (cancelled) { stopStream(s); return; }
        streamRef.current = s;
        const v = videoRef.current;
        if (!v) return;
        v.setAttribute('playsinline', 'true');
        v.srcObject = s;
        await v.play().catch(() => {});
        const tick = async () => {
          if (cancelled || !videoRef.current) return;
          const text = await scanQrOnce(videoRef.current);
          if (text) {
            try {
              const p = parseProvision(text.trim());
              await setProvision(p);
              setUser(p.user);
              setDevice(p.device_id);
              setUrl(p.url);
              setMsg('QR 등록됐습니다');
              stopScan();
              return;
            } catch (e) {
              setErr(e instanceof Error ? e.message : String(e));
            }
          }
          scanTimer.current = requestAnimationFrame(() => { void tick(); });
        };
        scanTimer.current = requestAnimationFrame(() => { void tick(); });
      } catch (e) {
        if (!cancelled) {
          setScanning(false);
          setErr('QR 카메라: ' + (e instanceof Error ? e.message : String(e)));
        }
      }
    })();
    return () => { cancelled = true; };
  }, [scanning]);

  useEffect(() => () => {
    if (scanTimer.current) cancelAnimationFrame(scanTimer.current);
    stopStream(streamRef.current);
  }, []);

  async function applyJson() {
    setErr(''); setMsg('');
    try {
      const p = parseProvision(raw.trim());
      await setProvision(p);
      setUser(p.user);
      setDevice(p.device_id);
      setUrl(p.url);
      setRaw('');
      setMsg('등록됐습니다');
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }

  async function savePrefs() {
    await setSettings({ site, maxEdge, iosVerdict });
    const p = await getProvision();
    if (p) await setProvision({ ...p, user, url });
    setMsg('저장됐습니다');
  }

  async function wipe() {
    await clearProvision();
    await setSettings(defaultSettings());
    setUser(''); setDevice(''); setUrl(''); setSite('');
    setMsg('등록을 지웠습니다');
  }

  return (
    <div className="wrap">
      <div className="top">
        <button className="sec" onClick={() => go('home')}>←</button>
        <h1>설정</h1>
        <span />
      </div>
      <p className="sub">관리자가 준 QR을 스캔하거나, keygen JSON을 붙여넣습니다.</p>

      {scanning && (
        <>
          <video ref={videoRef} playsInline muted autoPlay />
          <button className="sec" style={{ margin: '8px 0' }} onClick={stopScan}>스캔 중지</button>
        </>
      )}
      {!scanning && (
        <button className="sec" onClick={() => { setErr(''); setMsg(''); setScanning(true); }}>QR 스캔</button>
      )}

      <label>프로비저닝 JSON</label>
      <textarea
        value={raw}
        placeholder='{"v":1,"url":"...","device_id":"dev_…",…}'
        onChange={e => setRaw(e.target.value)}
        style={{ minHeight: 110 }}
      />
      <button style={{ marginTop: 8 }} onClick={() => void applyJson()} disabled={!raw.trim()}>등록</button>

      {device && (
        <>
          <p className="note">기기 <code>{device}</code></p>
          <label>사용자명</label>
          <input type="text" value={user} onChange={e => setUser(e.target.value)} />
          <label>기본 현장</label>
          <input type="text" value={site} onChange={e => setSite(e.target.value)} placeholder="SITE-021" />
          <label>서버 주소 (비우면 이 페이지 출처 · /api 프록시)</label>
          <input type="text" value={url} onChange={e => setUrl(e.target.value)} />
          <label>화질 (긴 변 px)</label>
          <select value={maxEdge} onChange={e => setMaxEdge(Number(e.target.value) as SettingsT['maxEdge'])}>
            <option value={1200}>1200 · 절약</option>
            <option value={1600}>1600 · 기본</option>
            <option value={2200}>2200 · 선명</option>
          </select>
          <button className="sec" style={{ marginTop: 8 }} onClick={() => void wipe()}>등록 해제</button>
        </>
      )}

      <label>아이폰 실기 가정 (실측 전)</label>
      <select value={iosVerdict} onChange={e => setIosVerdict(e.target.value as IosVerdict)}>
        <option value="assume-safe">안 남음 · getUserMedia 사용 (문헌·갤럭시와 동일)</option>
        <option value="assume-leak">남음 · 아이폰 사진 전송 차단 (웹 대체 없음)</option>
      </select>
      <p className="note">실패 가정을 켜도 메모·암호화·전송은 그대로입니다. 사진만 막힙니다.</p>
      <button style={{ marginTop: 14 }} onClick={() => void savePrefs()}>설정 저장</button>
      {msg && <p className="ok">{msg}</p>}
      {err && <p className="err">{err}</p>}
    </div>
  );
}
