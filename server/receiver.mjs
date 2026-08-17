#!/usr/bin/env node
/**
 * 수신 서버 (CONTRACT v3) — 미니PC에서 상시 가동. 인터넷에 노출되는 유일한 지점.
 *
 *   node receiver.mjs [--port 8443] [--static ../spike/camera] [--data ./]
 *
 * ★ 이 서버는 사무실 개인키를 갖지 않습니다. ★
 *   하는 일은 "서명 검증 → 암호문 그대로 저장"이 전부입니다.
 *   따라서 이 서버가 통째로 털려도 지난 사진은 복호화되지 않습니다.
 *   복호화는 인터넷에 노출되지 않은 collector.mjs 가 담당합니다.
 *   상태 조회 API 도 collector 가 써둔 파일을 **읽기만** 합니다.
 *
 * 운영 시 앞단에 Caddy 를 두어 HTTPS(Let's Encrypt)를 맡깁니다. docs/SETUP.md 참조.
 */
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile, readdir, rename } from 'node:fs/promises';
import { existsSync, createReadStream } from 'node:fs';
import { dirname, join, normalize, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { unpackWire, verify, verifyStatus, SCHEMA } from './lib/envelope.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const argOf = (name, dflt) => {
  const i = process.argv.indexOf('--' + name);
  return i > -1 ? process.argv[i + 1] : dflt;
};

const PORT = Number(argOf('port', 8443));
const DATA = join(HERE, argOf('data', '.'));
const KEYS = join(DATA, 'keys');
const ENC = join(DATA, 'inbox', 'enc');            // 암호문 보관소 (여기만 쓰기)
const STATUS = join(DATA, 'inbox', 'status');      // collector 가 쓴 것을 읽기만
const STATIC = join(HERE, argOf('static', '../spike/camera'));

const MAX_BODY = 28 * 1024 * 1024;                 // 사진 총 25MiB + 봉투 여유
const MAX_STATUS_BODY = 4 * 1024;
const SKEW_MS = 5 * 60 * 1000;                     // 시각 허용 오차 ±5분
const RATE = { perMin: 30, perDay: 500 };

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

let devices = {};
async function loadDevices() {
  const p = join(KEYS, 'devices.json');
  if (!existsSync(p)) {
    console.error('\n기기가 없습니다. `node keygen.mjs device <이름>` 먼저 실행하세요.\n');
    process.exit(1);
  }
  devices = JSON.parse(await readFile(p, 'utf8'));
  log('기기 ' + Object.keys(devices).length + '대 로드');
}

/* ---- 레이트리밋 (메모리) ---- */
const hits = new Map();
function rateOk(id) {
  const now = Date.now();
  const h = hits.get(id) || { min: [], day: [] };
  h.min = h.min.filter(t => now - t < 60_000);
  h.day = h.day.filter(t => now - t < 86_400_000);
  if (h.min.length >= RATE.perMin || h.day.length >= RATE.perDay) { hits.set(id, h); return false; }
  h.min.push(now); h.day.push(now); hits.set(id, h);
  return true;
}

/* ---- 업로드 ---- */
const seen = new Set();                            // 멱등성 (재시작 시 디스크로 복원)

async function handleUpload(body) {
  let header, ct;
  try { ({ header, ct } = unpackWire(body)); }
  catch (e) { return [400, { ok: false, code: 'BAD_SCHEMA', message: e.message }]; }

  if (header.schema !== SCHEMA) return [400, { ok: false, code: 'BAD_SCHEMA', message: 'schema' }];
  for (const f of ['submission_id', 'content_digest', 'created_at', 'device_id', 'key_id', 'enc', 'sig'])
    if (!header[f]) return [400, { ok: false, code: 'BAD_SCHEMA', message: 'missing ' + f }];
  for (const f of ['alg', 'epk', 'iv'])
    if (!header.enc[f]) return [400, { ok: false, code: 'BAD_SCHEMA', message: 'missing enc.' + f }];
  if (!/^[0-9A-HJKMNP-TV-Z]{26}$/.test(header.submission_id))
    return [400, { ok: false, code: 'BAD_SCHEMA', message: 'submission_id 형식' }];
  if (!/^[0-9a-f]{64}$/.test(header.content_digest))
    return [400, { ok: false, code: 'BAD_SCHEMA', message: 'content_digest 형식' }];
  if (!ct.length) return [400, { ok: false, code: 'BAD_SCHEMA', message: '암호문 없음' }];

  const dev = devices[header.device_id];
  if (!dev || dev.revoked) return [401, { ok: false, code: 'UNAUTHORIZED' }];
  if (!rateOk(header.device_id)) return [429, { ok: false, code: 'RATE_LIMITED' }];

  const skew = Math.abs(Date.now() - Date.parse(header.created_at));
  if (!Number.isFinite(skew) || skew > SKEW_MS) return [401, { ok: false, code: 'STALE' }];
  if (!await verify(header, ct, dev.secret)) return [401, { ok: false, code: 'BAD_SIGNATURE' }];

  const day = header.created_at.slice(0, 10);
  const dir = join(ENC, day);
  const file = join(dir, header.submission_id + '.bin');

  if (seen.has(header.submission_id) || existsSync(file)) {   // 멱등: 재전송은 조용히 성공
    log('중복 무시  ' + header.submission_id + '  ' + dev.name);
    return [200, { ok: true, submission_id: header.submission_id, duplicate: true }];
  }

  header.received_at = new Date().toISOString();
  const wire = Buffer.concat([
    (() => { const b = Buffer.alloc(4); b.writeUInt32BE(Buffer.byteLength(JSON.stringify(header))); return b; })(),
    Buffer.from(JSON.stringify(header), 'utf8'),
    Buffer.from(ct)
  ]);

  await mkdir(dir, { recursive: true });
  await writeFile(file + '.part', wire);
  await rename(file + '.part', file);                          // 원자적 완결 신호
  seen.add(header.submission_id);

  log('수신 ' + (ct.length / 1024).toFixed(0).padStart(5) + 'KB  ' +
      header.submission_id + '  ' + dev.name);
  return [200, { ok: true, submission_id: header.submission_id, received_at: header.received_at }];
}

/* ---- 상태 조회 ----
 * 폰이 "내 사진이 검증까지 끝났나"를 확인하는 경로.
 * 개인키 없이 collector 가 써둔 상태 파일을 읽어 돌려줄 뿐이다.  CONTRACT §4.2
 */
async function handleStatus(body) {
  let q;
  try { q = JSON.parse(body.toString('utf8')); }
  catch { return [400, { ok: false, code: 'BAD_SCHEMA' }]; }

  const { submission_id, device_id, sig } = q;
  if (!submission_id || !device_id || !sig) return [400, { ok: false, code: 'BAD_SCHEMA' }];

  const dev = devices[device_id];
  if (!dev || dev.revoked) return [401, { ok: false, code: 'UNAUTHORIZED' }];
  if (!await verifyStatus(submission_id, device_id, sig, dev.secret))
    return [401, { ok: false, code: 'BAD_SIGNATURE' }];
  if (!/^[0-9A-HJKMNP-TV-Z]{26}$/.test(submission_id))
    return [400, { ok: false, code: 'BAD_SCHEMA' }];

  const f = join(STATUS, submission_id + '.json');
  if (existsSync(f)) {
    const st = JSON.parse(await readFile(f, 'utf8'));
    if (st.device_id !== device_id) return [401, { ok: false, code: 'UNAUTHORIZED' }];  // 남의 것
    return [200, {
      ok: true, submission_id,
      verified: !!st.verified,
      record_id: st.record_id || null,
      verified_at: st.verified_at || null,
      error: st.error || null,
      error_detail: st.error_detail || null
    }];
  }
  if (seen.has(submission_id))                                  // 도착했으나 아직 처리 전
    return [200, { ok: true, submission_id, verified: false }];
  return [404, { ok: false, code: 'NOT_FOUND' }];
}

/* ---- 정적 파일 (PWA 자체 서빙: 제3자 호스팅 제거) ---- */
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.webmanifest': 'application/manifest+json', '.ico': 'image/x-icon'
};

function serveStatic(req, res) {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p === '/') p = '/index.html';
  const full = join(STATIC, normalize(p).replace(/^(\.\.[/\\])+/, ''));
  if (!full.startsWith(STATIC) || !existsSync(full)) { res.writeHead(404); return res.end('not found'); }
  res.writeHead(200, {
    'content-type': MIME[extname(full)] || 'application/octet-stream',
    'cache-control': 'no-cache',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer'
  });
  createReadStream(full).pipe(res);
}

/* ---- 서버 ---- */
await loadDevices();
await mkdir(ENC, { recursive: true });
if (existsSync(ENC)) {                                          // 재시작 시 멱등성 복원
  for (const d of await readdir(ENC)) {
    const dd = join(ENC, d);
    if (!existsSync(dd)) continue;
    for (const f of await readdir(dd).catch(() => []))
      if (f.endsWith('.bin')) seen.add(f.slice(0, -4));
  }
  log('기존 암호문 ' + seen.size + '건 확인');
}

function readBody(req, limit, done) {
  let size = 0; const chunks = [];
  req.on('data', c => {
    size += c.length;
    if (size > limit) { done(null); req.destroy(); return; }
    chunks.push(c);
  });
  req.on('end', () => done(Buffer.concat(chunks)));
}

createServer((req, res) => {
  const send = (code, obj) => {
    if (res.writableEnded) return;
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(obj));
  };

  if (req.method === 'POST' && req.url === '/api/upload') {
    return readBody(req, MAX_BODY, async body => {
      if (!body) return send(413, { ok: false, code: 'TOO_LARGE' });
      try { const [c, b] = await handleUpload(body); send(c, b); }
      catch (e) { log('오류 ' + e.message); send(500, { ok: false, code: 'INTERNAL' }); }
    });
  }
  if (req.method === 'POST' && req.url === '/api/status') {
    return readBody(req, MAX_STATUS_BODY, async body => {
      if (!body) return send(413, { ok: false, code: 'TOO_LARGE' });
      try { const [c, b] = await handleStatus(body); send(c, b); }
      catch (e) { log('오류 ' + e.message); send(500, { ok: false, code: 'INTERNAL' }); }
    });
  }
  if (req.method === 'GET' && req.url === '/api/health')
    return send(200, { ok: true, schema: SCHEMA, ts: Date.now() });
  if (req.method === 'GET') return serveStatic(req, res);
  send(405, { ok: false, code: 'METHOD_NOT_ALLOWED' });
}).listen(PORT, () => {
  log('수신 서버 http://localhost:' + PORT + '  (' + SCHEMA + ')');
  log('정적 파일 ' + STATIC);
  log('암호문 저장 ' + ENC);
  log('개인키 미보유 — 이 서버는 사진을 복호화할 수 없습니다');
});
