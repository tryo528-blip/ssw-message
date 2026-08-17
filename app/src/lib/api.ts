import { packWire, seal, sha256hex, signStatus, ulid } from '@ssw/envelope';
import type { Category, Provision, QueueItem, Settings } from './types';
import { APP_VER } from './types';
import { getProvision, markLog, pushLog, removeQueue, upsertQueue } from './store';

const PLACEHOLDER = '사무실주소';

export function apiBase(p: Provision): string {
  if (!p.url || p.url.includes(PLACEHOLDER)) return '';
  return p.url.replace(/\/$/, '');
}

export function parseProvision(raw: string): Provision {
  const o = JSON.parse(raw) as Partial<Provision>;
  if (!o || o.v !== 1) throw new Error('프로비저닝 v1 이 아닙니다');
  for (const k of ['device_id', 'secret', 'key_id', 'pub', 'user'] as const)
    if (!o[k] || typeof o[k] !== 'string') throw new Error('빠진 필드: ' + k);
  return {
    v: 1,
    url: typeof o.url === 'string' ? o.url : '',
    device_id: o.device_id!,
    secret: o.secret!,
    key_id: o.key_id!,
    pub: o.pub!,
    user: o.user!
  };
}

type MemoIn = { category: Category; body: string; priority?: 'NORMAL' | 'URGENT' };

export async function compose(opts: {
  provision: Provision;
  settings: Settings;
  memo?: MemoIn | null;
  photos?: Uint8Array[];
}): Promise<QueueItem> {
  const photos = opts.photos || [];
  const body = opts.memo?.body?.trim() || '';
  if (!body && photos.length === 0) throw new Error('메모나 사진이 필요합니다');
  if (photos.length > 5) throw new Error('사진은 최대 5장입니다');

  const submission_id = ulid();
  const created_at = new Date().toISOString();
  const metas = [];
  for (let i = 0; i < photos.length; i++) {
    metas.push({
      photo_id: i + 1,
      mime: 'image/jpeg',
      bytes: photos[i].length,
      sha256: await sha256hex(photos[i].slice())
    });
  }
  const inner = {
    schema: 'ssw-msg/1',
    submission_id,
    type: photos.length ? 'photo' : 'memo',
    created_at,
    user: opts.provision.user,
    site: opts.settings.site.trim() || null,
    app_ver: APP_VER,
    memo: body
      ? {
          category: opts.memo?.category || 'ETC',
          priority: opts.memo?.priority || 'NORMAL',
          body,
          body_len: body.length
        }
      : null,
    files: metas
  };
  const sealed = await seal({
    inner,
    files: photos,
    officePubB64: opts.provision.pub,
    keyId: opts.provision.key_id,
    deviceId: opts.provision.device_id,
    deviceSecret: opts.provision.secret
  });
  const wire = packWire(sealed);
  const copy = new ArrayBuffer(wire.byteLength);
  new Uint8Array(copy).set(wire);
  return {
    submission_id,
    created_at,
    kind: photos.length ? 'photo' : 'memo',
    label: photos.length ? `사진 ${photos.length}장` : '메모',
    wire: copy,
    status: 'queued'
  };
}

async function readJson(res: Response): Promise<{ ok?: boolean; code?: string; message?: string; verified?: boolean; error?: string; error_detail?: string; duplicate?: boolean }> {
  return res.json().catch(() => ({}));
}

export async function upload(item: QueueItem, provision: Provision): Promise<QueueItem> {
  const res = await fetch(apiBase(provision) + '/api/upload', {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream' },
    body: item.wire
  });
  const j = await readJson(res);
  if (!res.ok || !j.ok) {
    return { ...item, status: 'rejected', error: j.code || j.message || '전송 실패 ' + res.status };
  }
  return { ...item, status: 'sent' };
}

export async function askStatus(submissionId: string, provision: Provision): Promise<{
  found: boolean;
  verified: boolean;
  error?: string;
}> {
  const sig = await signStatus(submissionId, provision.device_id, provision.secret);
  const res = await fetch(apiBase(provision) + '/api/status', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      submission_id: submissionId,
      device_id: provision.device_id,
      sig
    })
  });
  if (res.status === 404) return { found: false, verified: false };
  const j = await readJson(res);
  if (!res.ok) return { found: false, verified: false, error: j.code || String(res.status) };
  if (j.error) return { found: true, verified: false, error: j.error + (j.error_detail ? ' · ' + j.error_detail : '') };
  return { found: true, verified: !!j.verified };
}

export async function waitVerified(item: QueueItem, provision: Provision): Promise<QueueItem> {
  const t0 = Date.now();
  while (Date.now() - t0 < 15_000) {
    await new Promise(r => setTimeout(r, 1000));
    const st = await askStatus(item.submission_id, provision);
    if (st.verified) {
      await removeQueue(item.submission_id);
      return { ...item, status: 'verified', wire: new ArrayBuffer(0) };
    }
    if (st.error) return { ...item, status: 'rejected', error: st.error };
  }
  return { ...item, status: 'sent' };
}

export async function resumeItem(item: QueueItem): Promise<QueueItem> {
  const provision = await getProvision();
  if (!provision) return item;
  if (item.status === 'sent') {
    const st = await askStatus(item.submission_id, provision);
    if (st.verified) {
      await removeQueue(item.submission_id);
      const next = { ...item, status: 'verified' as const, wire: new ArrayBuffer(0) };
      await markLog(item.created_at, { ok: true, pending: false });
      return next;
    }
    if (st.error) {
      const next = { ...item, status: 'rejected' as const, error: st.error };
      await upsertQueue(next);
      await markLog(item.created_at, { ok: false, pending: false });
      return next;
    }
    if (!st.found && item.wire.byteLength) return sendNow(item);
    return item;
  }
  if (item.status === 'queued' && item.wire.byteLength) return sendNow(item);
  return item;
}

/** 평문은 호출 전에 버린다. 여기 들어가는 건 이미 암호문. */
export async function sendNow(item: QueueItem): Promise<QueueItem> {
  const provision = await getProvision();
  if (!provision) throw new Error('기기가 등록되지 않았습니다');
  await upsertQueue(item);
  await pushLog({ at: item.created_at, kind: item.kind, label: item.label, ok: false, pending: true });
  let next = item;
  try {
    next = await upload(item, provision);
    if (next.status === 'sent') next = await waitVerified(next, provision);
  } catch (e) {
    next = { ...item, status: 'queued', error: e instanceof Error ? e.message : String(e) };
  }
  if (next.status === 'verified') {
    await removeQueue(next.submission_id);
    await markLog(item.created_at, { ok: true, pending: false });
  } else {
    await upsertQueue(next);
    if (next.status === 'rejected' || next.status === 'expired')
      await markLog(item.created_at, { ok: false, pending: false });
  }
  return next;
}
