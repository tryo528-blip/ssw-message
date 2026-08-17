#!/usr/bin/env node
/**
 * 폰 시뮬레이터 + 수신 서버 검사
 *
 *   node test-client.mjs [--url http://localhost:8443]
 *
 * 정상 전송뿐 아니라 "막혀야 하는 것들"이 실제로 막히는지도 확인합니다.
 * 이 스크립트가 전부 통과해야 폰 쪽 구현을 시작합니다.
 */
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { seal, sha256hex, b64e } from './lib/envelope.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const KEYS = join(HERE, 'keys');
const i = process.argv.indexOf('--url');
const URL_ = (i > -1 ? process.argv[i + 1] : 'http://localhost:8443') + '/api/upload';

const office = JSON.parse(await readFile(join(KEYS, 'office-public.json'), 'utf8'));
const devices = JSON.parse(await readFile(join(KEYS, 'devices.json'), 'utf8'));
const [deviceId, dev] = Object.entries(devices).find(([, d]) => !d.revoked);
console.log('기기: ' + dev.name + ' (' + deviceId + ')   키: ' + office.key_id + '\n');

/* ULID 유사 — 시간순 정렬 + 충돌 방지 */
const B32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
function ulid() {
  let t = Date.now(), s = '';
  for (let i = 9; i >= 0; i--) { s = B32[t % 32] + s; t = Math.floor(t / 32); }
  const r = globalThis.crypto.getRandomValues(new Uint8Array(16));
  return s + [...r].map(b => B32[b % 32]).join('');
}
const rand = n => {
  const a = new Uint8Array(n);
  for (let o = 0; o < n; o += 65536) globalThis.crypto.getRandomValues(a.subarray(o, Math.min(o + 65536, n)));
  return a;
};

async function post(env) {
  const res = await fetch(URL_, {
    method: 'POST',
    headers: { 'content-type': 'text/plain;charset=utf-8' },   // CORS preflight 회피
    body: JSON.stringify(env)
  });
  return { status: res.status, body: await res.json() };
}

const base = () => ({
  schema: 'ssw-msg/1',
  id: ulid(),
  created_at: new Date().toISOString(),
  device_id: deviceId,
  user: dev.name,
  site: 'SITE-021',
  app_ver: '0.1.0-proto'
});

async function makeMemo() {
  const inner = { ...base(), type: 'memo',
    memo: { category: 'TODO', priority: 'NORMAL',
      body: '3층 화장실 배관 누수 재확인 필요.\n자재 미리 준비할 것. 이모지 테스트 🔧', body_len: 0 } };
  inner.memo.body_len = inner.memo.body.length;
  inner.files = [];
  return seal({ inner, files: [], officePubB64: office.pub, keyId: office.key_id,
    deviceId, deviceSecret: dev.secret });
}

async function makePhoto(count = 2) {
  const inner = { ...base(), type: 'photo',
    memo: { category: 'AS', body: '계량기 검침 사진' }, files: [] };
  const files = [];
  for (let n = 1; n <= count; n++) {
    const bytes = rand(300 * 1024);
    files.push(bytes);
    inner.files.push({
      name: inner.id + '_' + n + '.jpg', bytes: bytes.length,
      sha256: await sha256hex(bytes), width: 1600, height: 1200,
      mime: 'image/jpeg', exif_stripped: true
    });
  }
  return { env: await seal({ inner, files, officePubB64: office.pub, keyId: office.key_id,
    deviceId, deviceSecret: dev.secret }), inner };
}

/* ---------------- 검사 ---------------- */
let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  console.log((ok ? '  PASS  ' : '  FAIL  ') + name + (detail ? '   ' + detail : ''));
  ok ? pass++ : fail++;
};

console.log('[정상 전송]');
const memo = await makeMemo();
let r = await post(memo);
check('메모 전송', r.status === 200 && r.body.ok, r.status + ' ' + JSON.stringify(r.body));

const t0 = Date.now();
const { env: photo, inner: photoInner } = await makePhoto(2);
const encMs = Date.now() - t0;
r = await post(photo);
check('사진 2장(600KB) 전송', r.status === 200 && r.body.ok,
  '암호화+직렬화 ' + encMs + 'ms, 전송본 ' + (JSON.stringify(photo).length / 1024).toFixed(0) + 'KB');

console.log('\n[막혀야 하는 것들]');
r = await post(memo);
check('같은 id 재전송 → 중복 무시', r.status === 200 && r.body.duplicate === true,
  JSON.stringify(r.body));

const forged = structuredClone(photo);
forged.id = ulid();                                    // id만 바꿔치기 (AAD 불일치 유발)
r = await post(forged);
check('id 위조 → 서명 거부', r.status === 401 && r.body.code === 'BAD_SIGNATURE', r.body.code);

const tampered = structuredClone(await makeMemo());
const ct = Buffer.from(tampered.enc.ct, 'base64'); ct[10] ^= 1;
tampered.enc.ct = ct.toString('base64');
r = await post(tampered);
check('암호문 변조 → 서명 거부', r.status === 401 && r.body.code === 'BAD_SIGNATURE', r.body.code);

const stale = await makeMemo();
stale.created_at = new Date(Date.now() - 30 * 60_000).toISOString();
r = await post(stale);
check('30분 지난 요청 → 거부', r.status === 401, r.body.code);

const unknown = structuredClone(await makeMemo());
unknown.device_id = 'dev_UNKNOWN';
r = await post(unknown);
check('미등록 기기 → 거부', r.status === 401 && r.body.code === 'UNAUTHORIZED', r.body.code);

r = await post({ schema: 'ssw-msg/9', id: 'x' });
check('알 수 없는 schema → 거부', r.status === 400 && r.body.code === 'BAD_SCHEMA', r.body.code);

console.log('\n[레이트리밋]');
let limited = 0;
for (let n = 0; n < 35; n++) { const e = await makeMemo(); if ((await post(e)).status === 429) limited++; }
check('분당 30건 초과 → 429', limited > 0, limited + '건 차단됨');

console.log('\n' + (fail === 0 ? '전체 통과' : fail + '건 실패') + '  (' + pass + '/' + (pass + fail) + ')');
console.log('\n다음: node collector.mjs  → inbox/ready/ 에 평문이 떨어지는지 확인');
process.exit(fail === 0 ? 0 : 1);
