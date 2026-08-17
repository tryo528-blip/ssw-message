import { useState } from 'react';
import { compose, sendNow } from '../lib/api';
import { getProvision, getSettings } from '../lib/store';
import { CATEGORIES, MEMO_MAX, type Category, type Screen } from '../lib/types';

export function Memo({ go }: { go: (s: Screen) => void }) {
  const [cat, setCat] = useState<Category>('TODO');
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  async function submit() {
    const text = body.trim();
    if (!text) { setErr('내용을 입력하세요'); return; }
    if (text.length > MEMO_MAX) { setErr(`최대 ${MEMO_MAX}자`); return; }
    setBusy(true); setErr('');
    try {
      const provision = await getProvision();
      if (!provision) { go('settings'); return; }
      const item = await compose({
        provision,
        settings: await getSettings(),
        memo: { category: cat, body: text }
      });
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
        <button className="sec" onClick={() => go('home')}>←</button>
        <h1>메모</h1>
        <span />
      </div>
      <div className="chips">
        {CATEGORIES.map(c => (
          <button key={c.id} className={cat === c.id ? 'on' : ''} onClick={() => setCat(c.id)}>{c.label}</button>
        ))}
      </div>
      <textarea
        value={body}
        maxLength={MEMO_MAX}
        placeholder="자유롭게 입력…"
        onChange={e => setBody(e.target.value)}
      />
      <p className="hint">{body.length} / {MEMO_MAX}</p>
      {err && <p className="err">{err}</p>}
      <button onClick={() => void submit()} disabled={busy || !body.trim()}>
        {busy ? '암호화 · 전송 중…' : '전송'}
      </button>
    </div>
  );
}
