#!/usr/bin/env node
/**
 * 폰 시뮬레이터 (CONTRACT v3) — 실기 없이 서버 전체 경로를 검사한다.
 *
 *   node receiver.mjs --port 8443        (다른 터미널에서 먼저 실행)
 *   node test-client.mjs --url http://localhost:8443
 *
 * 검사는 두 층으로 나뉜다.
 *   1층 전송   — 수신 서버가 판정. 서명·시각·기기·레이트리밋
 *   2층 내용   — 수집기가 판정. 복호화해야 알 수 있는 것(미디어·용량·구성)
 *              수신 서버는 복호화를 못 하므로 일단 200 을 주고, 거부는 상태 파일에 남는다.
 */
import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  seal, packWire, sign, sha256hex, ulid, b64e, b64d, signStatus, SCHEMA
} from './lib/envelope.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const KEYS = join(HERE, 'keys');
const READY = join(HERE, 'inbox', 'ready');
const STATUS = join(HERE, 'inbox', 'status');

const argOf = (n, d) => { const i = process.argv.indexOf('--' + n); return i > -1 ? process.argv[i + 1] : d; };
const URL_BASE = argOf('url', 'http://localhost:8443');

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { console.log('  통과  ' + name); pass++; }
  else { console.log('  실패  ' + name + (extra ? '   ← ' + extra : '')); fail++; }
};

/* ---- 준비 ---- */
if (!existsSync(join(KEYS, 'office-public.json')) || !existsSync(join(KEYS, 'devices.json'))) {
  console.error('\n키가 없습니다. 먼저 실행하세요:\n  node keygen.mjs office\n  node keygen.mjs device 테스트\n');
  process.exit(1);
}
const office = JSON.parse(await readFile(join(KEYS, 'office-public.json'), 'utf8'));
const devices = JSON.parse(await readFile(join(KEYS, 'devices.json'), 'utf8'));
const [deviceId, dev] = Object.entries(devices).find(([, d]) => !d.revoked) || [];
if (!deviceId) { console.error('\n사용 가능한 기기가 없습니다.\n'); process.exit(1); }

const CTX = { officePubB64: office.pub, keyId: office.key_id, deviceId, deviceSecret: dev.secret };

/* ---- 최소 JPEG 생성기 (디코딩 없이 검사만 하므로 구조만 맞으면 됨) ---- */
function bytes(...parts) {
  const out = [];
  const push = x => {
    if (x instanceof Uint8Array) { for (const b of x) out.push(b); }
    else if (Array.isArray(x)) { for (const y of x) push(y); }
    else out.push(x);
  };
  parts.forEach(push);
  return Uint8Array.from(out);
}
const segment = (marker, payload) => {
  const p = bytes(payload);
  return bytes([0xFF, marker, (p.length + 2) >> 8, (p.length + 2) & 0xFF], p);
};

function makeJpeg({ w = 1600, h = 1200, padTo = 0, withExif = true } = {}) {
  const parts = [[0xFF, 0xD8]];
  if (withExif) {
    // GPS 가 들어갈 자리에 EXIF orientation=1 을 넣어둔다. strip 대상.
    parts.push(segment(0xE1, bytes([0x45, 0x78, 0x69, 0x66, 0, 0], [
      0x49, 0x49, 0x2A, 0x00, 0x08, 0x00, 0x00, 0x00, 0x01, 0x00,
      0x12, 0x01, 0x03, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00,
      0x00, 0x00, 0x00, 0x00])));
  }
  parts.push(segment(0xDB, [0, ...Array(64).fill(1)]));
  parts.push(segment(0xC0, [8, (h >> 8) & 0xFF, h & 0xFF, (w >> 8) & 0xFF, w & 0xFF,
    3, 1, 0x11, 0, 2, 0x11, 1, 3, 0x11, 1]));
  parts.push(segment(0xDA, [3, 1, 0, 2, 0x11, 3, 0x11, 0, 0x3F, 0]));

  const head = bytes(...parts);
  const tailLen = Math.max(8, padTo - head.length - 2);
  const entropy = new Uint8Array(tailLen);
  for (let o = 0; o < tailLen; o += 65536)                      // getRandomValues 는 64KB 상한
    crypto.getRandomValues(entropy.subarray(o, Math.min(o + 65536, tailLen)));
  for (let i = 0; i < entropy.length; i++) if (entropy[i] === 0xFF) entropy[i] = 0xFE;  // 바이트 스터핑 회피
  return bytes(head, entropy, [0xFF, 0xD9]);
}

/* ---- 봉투 만들기 ---- */
async function makeInner({ submissionId = ulid(), type, memo = null, files = [], createdAt = null }) {
  const metas = [];
  for (let i = 0; i < files.length; i++)
    metas.push({ photo_id: i + 1, mime: 'image/jpeg', bytes: files[i].length, sha256: await sha256hex(files[i]) });
  return {
    schema: 'ssw-msg/1',
    submission_id: submissionId,
    type,
    created_at: createdAt || new Date().toISOString(),
    user: '테스트',
    site: 'SITE-021',
    app_ver: '0.1.0',
    memo: memo ? { category: 'TODO', priority: 'NORMAL', body: memo, body_len: memo.length } : null,
    files: metas
  };
}

async function post(path, body, contentType) {
  const res = await fetch(URL_BASE + path, {
    method: 'POST',
    headers: { 'content-type': contentType },
    body
  });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}

async function send(inner, files, mutate = null) {
  const sealed = await seal({ inner, files, ...CTX });
  if (mutate) await mutate(sealed);
  return post('/api/upload', packWire(sealed), 'application/octet-stream');
}

/* ==================== 1층 · 전송 ==================== */
console.log('\n대상 ' + URL_BASE + '   기기 ' + deviceId + ' (' + dev.name + ')   ' + SCHEMA);
console.log('\n[1층] 전송 — 수신 서버 판정\n');

const memoText = '3층 화장실 배관 누수 재확인 필요.\n자재 미리 준비할 것. 🔧';
const idMemo = ulid();
{
  const r = await send(await makeInner({ submissionId: idMemo, type: 'memo', memo: memoText }), []);
  ok('T1  정상 메모', r.status === 200 && r.json.ok, JSON.stringify(r.json));
}

const idPhoto = ulid();
{
  const p1 = makeJpeg({ padTo: 300 * 1024 }), p2 = makeJpeg({ padTo: 300 * 1024 });
  const inner = await makeInner({ submissionId: idPhoto, type: 'photo', memo: '현장 서류', files: [p1, p2] });
  const t0 = performance.now();
  const sealed = await seal({ inner, files: [p1, p2], ...CTX });
  const encMs = performance.now() - t0;
  const wire = packWire(sealed);
  const r = await post('/api/upload', wire, 'application/octet-stream');
  ok('T2  사진 2장 (600KB)', r.status === 200 && r.json.ok, JSON.stringify(r.json));
  const raw = p1.length + p2.length;
  console.log('        암호화 ' + encMs.toFixed(1) + 'ms   원본 ' + (raw / 1024).toFixed(0) +
    'KB → 전송 ' + (wire.length / 1024).toFixed(0) + 'KB  (+' +
    ((wire.length / raw - 1) * 100).toFixed(1) + '%)');
}

{
  const r = await send(await makeInner({ submissionId: idMemo, type: 'memo', memo: memoText }), []);
  ok('T3  같은 id 재전송 → 중복 무시', r.status === 200 && r.json.duplicate === true, JSON.stringify(r.json));
}
{
  const r = await send(await makeInner({ type: 'memo', memo: '위조' }), [],
    s => { s.header.submission_id = ulid(); });
  ok('T4  submission_id 위조 거부', r.status === 401 && r.json.code === 'BAD_SIGNATURE', JSON.stringify(r.json));
}
{
  const r = await send(await makeInner({ type: 'memo', memo: '변조' }), [],
    s => { s.ct[Math.floor(s.ct.length / 2)] ^= 0x01; });
  ok('T5  암호문 1비트 변조 거부', r.status === 401 && r.json.code === 'BAD_SIGNATURE', JSON.stringify(r.json));
}
{
  const old = new Date(Date.now() - 30 * 60 * 1000).toISOString();
  const r = await send(await makeInner({ type: 'memo', memo: '지연', createdAt: old }), []);
  ok('T6  30분 지난 요청 거부', r.status === 401 && r.json.code === 'STALE', JSON.stringify(r.json));
}
{
  const inner = await makeInner({ type: 'memo', memo: '미등록' });
  const sealed = await seal({ inner, files: [], ...CTX });
  sealed.header.device_id = 'dev_00000000';
  sealed.header.sig = await sign(sealed.header, sealed.ct, CTX.deviceSecret);
  const r = await post('/api/upload', packWire(sealed), 'application/octet-stream');
  ok('T7  미등록 기기 거부', r.status === 401 && r.json.code === 'UNAUTHORIZED', JSON.stringify(r.json));
}
{
  const inner = await makeInner({ type: 'memo', memo: '구버전' });
  const sealed = await seal({ inner, files: [], ...CTX });
  sealed.header.schema = 'ssw-msg/2';
  const r = await post('/api/upload', packWire(sealed), 'application/octet-stream');
  ok('T8  알 수 없는 schema 거부', r.status === 400 && r.json.code === 'BAD_SCHEMA', JSON.stringify(r.json));
}
{
  const r = await post('/api/upload', Buffer.from([1, 2, 3]), 'application/octet-stream');
  ok('T11 wire 손상 거부', r.status === 400 && r.json.code === 'BAD_SCHEMA', JSON.stringify(r.json));
}

/* ==================== 2층 · 내용 ==================== */
console.log('\n[2층] 내용 — 수집기 판정 (수신 서버는 복호화를 못 하므로 200 을 준다)\n');

const idEmpty = ulid(), idSix = ulid(), idNotJpeg = ulid(), idBadHash = ulid(), idHuge = ulid();
{
  const r = await send(await makeInner({ submissionId: idEmpty, type: 'memo', memo: '   ' }), []);
  ok('T12 빈 제출 — 수신은 통과', r.status === 200, JSON.stringify(r.json));
}
{
  const six = Array.from({ length: 6 }, () => makeJpeg({ padTo: 2048 }));
  const r = await send(await makeInner({ submissionId: idSix, type: 'photo', files: six }), six);
  ok('T13 사진 6장 — 수신은 통과', r.status === 200, JSON.stringify(r.json));
}
{
  const junk = new Uint8Array(2048); crypto.getRandomValues(junk);
  const r = await send(await makeInner({ submissionId: idNotJpeg, type: 'photo', files: [junk] }), [junk]);
  ok('T14 JPEG 아님 — 수신은 통과', r.status === 200, JSON.stringify(r.json));
}
{
  const p = makeJpeg({ padTo: 4096 });
  const inner = await makeInner({ submissionId: idBadHash, type: 'photo', files: [p] });
  inner.files[0].sha256 = 'f'.repeat(64);                       // 해시만 거짓말
  const sealed = await seal({ inner, files: [p], ...CTX });
  const r = await post('/api/upload', packWire(sealed), 'application/octet-stream');
  ok('T15 해시 불일치 — 수신은 통과', r.status === 200, JSON.stringify(r.json));
}
{
  const big = makeJpeg({ w: 5000, h: 4000, padTo: 4096 });
  const r = await send(await makeInner({ submissionId: idHuge, type: 'photo', files: [big] }), [big]);
  ok('T16 5000px — 수신은 통과', r.status === 200, JSON.stringify(r.json));
}

/* ---- 수집기 실행 ---- */
console.log('\n수집기 실행...\n');
const col = spawnSync(process.execPath, [join(HERE, 'collector.mjs')], { encoding: 'utf8' });
process.stdout.write(col.stdout.split('\n').map(l => l ? '        ' + l : '').join('\n'));
if (col.status !== 0) console.error(col.stderr);

const statusOf = async id => {
  const f = join(STATUS, id + '.json');
  return existsSync(f) ? JSON.parse(await readFile(f, 'utf8')) : null;
};

console.log('\n[2층] 수집기 판정 결과\n');
{
  const s = await statusOf(idMemo);
  ok('T1b 메모 검증 완료', s && s.verified === true, JSON.stringify(s));
}
{
  const s = await statusOf(idPhoto);
  ok('T2b 사진 검증 완료', s && s.verified === true && s.files.length === 2, JSON.stringify(s));
}
for (const [id, code, label] of [
  [idEmpty, 'INVALID_SUBMISSION', 'T12 빈 제출 거부'],
  [idSix, 'RESOURCE_LIMIT_EXCEEDED', 'T13 사진 6장 거부'],
  [idNotJpeg, 'INVALID_MEDIA', 'T14 JPEG 아님 거부'],
  [idBadHash, 'CONTENT_DIGEST_MISMATCH', 'T15 해시 불일치 거부'],
  [idHuge, 'RESOURCE_LIMIT_EXCEEDED', 'T16 4096px 초과 거부']
]) {
  const s = await statusOf(id);
  ok(label, s && s.verified === false && s.error === code,
    s ? s.error + ' / ' + s.error_detail : '상태 없음');
}

/* ---- 산출물 확인 ---- */
{
  const day = new Date().toISOString().slice(0, 10);
  const dir = join(READY, 'photo', day);
  const s = await statusOf(idPhoto);
  const files = existsSync(dir) ? await readdir(dir) : [];
  const jsonName = s ? s.record_id + '.json' : '';
  ok('T10 결과 JSON 생성', files.includes(jsonName), files.slice(0, 4).join(', '));

  if (files.includes(jsonName)) {
    const out = JSON.parse(await readFile(join(dir, jsonName), 'utf8'));
    ok('T10b 파일명이 record_id 기반', out.files.every(f => f.name.startsWith(out.record_id)));
    ok('T10c 크기 기록 1600×1200', out.files[0].width === 1600 && out.files[0].height === 1200,
      out.files[0].width + '×' + out.files[0].height);
    ok('T10d EXIF 제거됨', out.files[0].metadata_stripped === true);
    ok('T10e wire 해시 보존', /^[0-9a-f]{64}$/.test(out.files[0].wire_sha256));

    const memoDay = join(READY, 'memo', day);
    const ms = await statusOf(idMemo);
    const mj = JSON.parse(await readFile(join(memoDay, ms.record_id + '.json'), 'utf8'));
    ok('T10f 메모 원문 보존 (줄바꿈·이모지)', mj.memo.body === memoText, JSON.stringify(mj.memo.body));
  }
}

/* ---- 상태 조회 API ---- */
console.log('\n[상태 조회 API]\n');
{
  const sig = await signStatus(idPhoto, deviceId, dev.secret);
  const r = await post('/api/status', JSON.stringify({ submission_id: idPhoto, device_id: deviceId, sig }),
    'application/json');
  ok('T17 검증 완료 조회', r.status === 200 && r.json.verified === true && r.json.record_id,
    JSON.stringify(r.json));
}
{
  const r = await post('/api/status', JSON.stringify({
    submission_id: idPhoto, device_id: deviceId, sig: b64e(new Uint8Array(32))
  }), 'application/json');
  ok('T18 서명 없이 조회 거부', r.status === 401, JSON.stringify(r.json));
}
{
  const unknown = ulid();
  const sig = await signStatus(unknown, deviceId, dev.secret);
  const r = await post('/api/status', JSON.stringify({ submission_id: unknown, device_id: deviceId, sig }),
    'application/json');
  ok('T18b 없는 건 조회 → 404', r.status === 404, JSON.stringify(r.json));
}
{
  const s = await statusOf(idNotJpeg);
  const sig = await signStatus(idNotJpeg, deviceId, dev.secret);
  const r = await post('/api/status', JSON.stringify({ submission_id: idNotJpeg, device_id: deviceId, sig }),
    'application/json');
  ok('T19 거부된 건은 사유까지 조회',
    r.status === 200 && r.json.verified === false && r.json.error === 'INVALID_MEDIA',
    JSON.stringify(r.json));
}

/* ---- 기밀성 확인 ---- */
console.log('\n[기밀성]\n');
{
  const encDir = join(HERE, 'inbox', '_processed');
  let hitEnc = 0;
  const needle = Buffer.from('화장실', 'utf8');
  for (const day of existsSync(encDir) ? await readdir(encDir) : []) {
    for (const f of await readdir(join(encDir, day))) {
      const b = await readFile(join(encDir, day, f));
      if (b.includes(needle)) hitEnc++;
    }
  }
  ok('암호문에서 메모 내용 검색 0건', hitEnc === 0, hitEnc + '건 발견');

  const day = new Date().toISOString().slice(0, 10);
  const memoDir = join(READY, 'memo', day);
  let hitPlain = 0;
  for (const f of existsSync(memoDir) ? await readdir(memoDir) : [])
    if ((await readFile(join(memoDir, f))).includes(needle)) hitPlain++;
  ok('복호화 산출물에서는 검색됨 (대조군)', hitPlain > 0, hitPlain + '건');
}

/* ---- 레이트리밋 (마지막 — 이후 전송을 막으므로) ---- */
console.log('\n[레이트리밋]\n');
{
  let limited = 0;
  for (let i = 0; i < 35; i++) {
    const r = await send(await makeInner({ type: 'memo', memo: '부하 ' + i }), []);
    if (r.status === 429) limited++;
  }
  ok('T9  분당 30건 초과 차단', limited > 0, limited + '건 차단됨');
}

console.log('\n' + (fail ? '── 실패 ' + fail + '건 / 전체 ' + (pass + fail) : '── 전부 통과 (' + pass + ')') + '\n');
process.exit(fail ? 1 : 0);
