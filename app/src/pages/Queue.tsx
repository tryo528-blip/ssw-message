import { useEffect, useState } from 'react';
import { sendNow } from '../lib/api';
import { getQueue, isStale, removeQueue } from '../lib/store';
import type { QueueItem, Screen } from '../lib/types';

export function Queue({ go }: { go: (s: Screen) => void }) {
  const [items, setItems] = useState<QueueItem[]>([]);
  const [busy, setBusy] = useState<string | null>(null);

  async function load() {
    const q = await getQueue();
    setItems(q.filter(x => x.status === 'queued' || x.status === 'sent' || x.status === 'rejected'));
  }
  useEffect(() => { void load(); }, []);

  async function retry(item: QueueItem) {
    if (!item.wire.byteLength) return;
    setBusy(item.submission_id);
    try {
      await sendNow(item);
      await load();
    } finally { setBusy(null); }
  }

  async function discard(id: string) {
    if (!confirm('확인 없이 이 암호문을 버립니다. 다시 찍을 수 없는 사진이면 취소하세요.')) return;
    await removeQueue(id);
    await load();
  }

  return (
    <div className="wrap">
      <div className="top">
        <button className="sec" onClick={() => go('home')}>←</button>
        <h1>대기함</h1>
        <span />
      </div>
      <p className="sub">확인될 때까지 암호문만 보관합니다. 7일이 지나도 자동으로 지우지 않습니다.</p>
      {items.length === 0 && <p className="dim">대기 중인 건이 없습니다.</p>}
      <ul className="list">
        {items.map(q => (
          <li key={q.submission_id} style={{ flexWrap: 'wrap' }}>
            <span>
              {isStale(q) && <span className="warn">7일+ </span>}
              {q.label}
              <span className="dim"> · {q.status}</span>
              {q.error && <span className="ng"> · {q.error}</span>}
            </span>
            <span className="row" style={{ width: 'auto', flex: '0 0 auto' }}>
              <button className="sec" style={{ width: 'auto', padding: '4px 10px' }} disabled={busy === q.submission_id || !q.wire.byteLength} onClick={() => void retry(q)}>재전송</button>
              <button className="sec" style={{ width: 'auto', padding: '4px 10px' }} onClick={() => void discard(q.submission_id)}>버림</button>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
