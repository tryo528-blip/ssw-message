import { useEffect, useState } from 'react';
import { sendNow } from '../lib/api';
import { photoCaptureAllowed } from '../lib/camera';
import { getLog, getProvision, getQueue, getSettings, upsertQueue } from '../lib/store';
import type { IosVerdict, LogItem, QueueItem, Screen } from '../lib/types';

export function Home({ go }: { go: (s: Screen) => void }) {
  const [ready, setReady] = useState(false);
  const [user, setUser] = useState('');
  const [log, setLog] = useState<LogItem[]>([]);
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [iosVerdict, setIosVerdict] = useState<IosVerdict>('assume-safe');

  async function load() {
    const p = await getProvision();
    setReady(!!p);
    setUser(p?.user || '');
    setLog(await getLog());
    setQueue(await getQueue());
    setIosVerdict((await getSettings()).iosVerdict);
  }
  useEffect(() => { void load(); }, []);

  const pending = queue.filter(q => q.status === 'queued' || q.status === 'sent');

  async function retry() {
    setBusy(true);
    try {
      const p = await getProvision();
      if (!p) return;
      for (const item of pending) {
        if (!item.wire.byteLength) continue;
        await sendNow(item);
      }
      await load();
    } finally { setBusy(false); }
  }

  async function dismiss(id: string) {
    const q = await getQueue();
    const item = q.find(x => x.submission_id === id);
    if (item) await upsertQueue({ ...item, wire: new ArrayBuffer(0), status: 'expired', error: '사용자가 버림' });
    await load();
  }

  return (
    <div className="wrap">
      <div className="top">
        <h1>SSW Message</h1>
        <span className="row" style={{ width: 'auto', flex: '0 0 auto' }}>
          <button className="sec" onClick={() => go('queue')}>대기함{pending.length ? ` ${pending.length}` : ''}</button>
          <button className="sec" onClick={() => go('settings')}>설정</button>
        </span>
      </div>
      {!ready && (
        <div className="banner">기기가 등록되지 않았습니다. 설정에서 프로비저닝 JSON을 붙여넣으세요.</div>
      )}
      {ready && user && <p className="sub">{user}</p>}

      <button className="card" onClick={() => go(ready ? 'memo' : 'settings')} style={{ width: '100%' }}>
        <div className="ico">📝</div>
        <strong>메모 보내기</strong>
        <p>분류를 고르고 자유롭게 적습니다</p>
      </button>
      <button className="card" onClick={() => go(ready ? 'camera' : 'settings')} style={{ width: '100%' }}>
        <div className="ico">📷</div>
        <strong>사진 보내기</strong>
        <p>{photoCaptureAllowed(iosVerdict) ? '갤러리에 저장하지 않습니다' : '이 가정에서는 아이폰 사진 전송 불가'}</p>
      </button>

      {pending.length > 0 && (
        <section>
          <h2>대기 {pending.length}건 <span className="badge">미확인</span></h2>
          <ul className="list">
            {pending.map(q => (
              <li key={q.submission_id}>
                <span>⏳ {q.label}{q.error ? <span className="ng"> · {q.error}</span> : ''}</span>
                <button className="sec" style={{ width: 'auto', padding: '4px 10px' }} onClick={() => void dismiss(q.submission_id)}>버림</button>
              </li>
            ))}
          </ul>
          <button onClick={() => void retry()} disabled={busy}>{busy ? '전송 중…' : '대기 건 다시 보내기'}</button>
        </section>
      )}

      <section style={{ marginTop: 18 }}>
        <h2>최근 전송</h2>
        {log.length === 0 && <p className="dim">아직 없습니다</p>}
        <ul className="list">
          {log.map((x, i) => (
            <li key={x.at + i}>
              <span>
                {x.pending ? '⏳' : x.ok ? <span className="ok">✓</span> : <span className="ng">✗</span>}
                {' '}{fmt(x.at)} {x.label}
              </span>
              <span className="dim">{x.pending ? '대기' : x.ok ? '확인' : '실패'}</span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

function fmt(iso: string) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(11, 16);
  return d.toTimeString().slice(0, 5);
}
