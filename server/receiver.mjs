#!/usr/bin/env node
/**
 * 수신 서버 — 사무실 PC에서 상시 가동. 인터넷에 노출되는 유일한 지점.
 *
 *   node receiver.mjs [--port 8443] [--static ../spike/camera]
 *
 * ★ 이 서버는 사무실 개인키를 갖지 않습니다. ★
 *   하는 일은 "서명 검증 → 암호문 그대로 저장"이 전부입니다.
 *   따라서 이 서버가 통째로 털려도 지난 사진은 복호화되지 않습니다.
 *   복호화는 인터넷에 노출되지 않은 collector.mjs 가 담당합니다.
 *
 * 운영 시에는 앞단에 Caddy 를 두어 HTTPS(Let's Encrypt)를 맡깁니다.
 *   Caddyfile 예시는 README.md 참조.
 */
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { existsSync, createReadStream } from 'node:fs';
import { dirname, join, normalize, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const KEYS = join(HERE, 'keys');
const INBOX = join(HERE, 'inbox', 'enc');          // 암호문 보관소
const C = globalThis.crypto.subtle;

const argOf = (name, dflt) => {
  const i = process.argv.indexOf('--' + name);
  return i > -1 ? process.argv[i + 1] : dflt;
};
const PORT = Number(argOf('port', 8443));
const STATIC = join(HERE, argOf('static', '../spike/camera'));
const MAX_BODY = 12 * 1024 * 1024;                 // 12MB
const SKEW_MS = 5 * 60 * 1000;                     // 시각 허용 오차 5분
const RATE = { perMin: 30, perDay: 500 };

const b64d = s => new Uint8Array(Buffer.from(s, 'base64'));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

let devices = {};
async function loadDevices() {
  const p = join(KEYS, 'devices.json');
  if (!existsSync(p)) { console.error('\n기기가 없습니다. `node keygen.mjs device <이름>` 먼저 실행하세요.\n'); process.exit(1); }
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

/* ---- 서명 검증 (envelope.mjs 와 동일 규칙) ---- */
async function verifySig(env, secretB64) {
  if (!env.sig) return false;
  const ctHash = Buffer.from(await C.digest('SHA-256', b64d(env.enc.ct))).toString('hex');
  const key = await C.importKey('raw', b64d(secretB64), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  const base = new TextEncoder().encode(
    [env.id, env.created_at, env.device_id, env.key_id, ctHash].join('.'));
  return C.verify('HMAC', key, b64d(env.sig), base);
}

/* ---- 업로드 처리 ---- */
const seen = new Set();                            // 멱등성 (재시작 시 디스크로 보강)

async function handleUpload(body) {
  let env;
  try { env = JSON.parse(body); }
  catch { return [400, { ok: false, code: 'BAD_JSON' }]; }

  if (env.schema !== 'ssw-msg/2') return [400, { ok: false, code: 'BAD_SCHEMA' }];
  for (const f of ['id', 'created_at', 'device_id', 'key_id', 'enc', 'sig'])
    if (!env[f]) return [400, { ok: false, code: 'BAD_SCHEMA', message: 'missing ' + f }];
  for (const f of ['alg', 'epk', 'iv', 'ct'])
    if (!env.enc[f]) return [400, { ok: false, code: 'BAD_SCHEMA', message: 'missing enc.' + f }];

  const dev = devices[env.device_id];
  if (!dev || dev.revoked) return [401, { ok: false, code: 'UNAUTHORIZED' }];
  if (!rateOk(env.device_id)) return [429, { ok: false, code: 'RATE_LIMITED' }];

  const skew = Math.abs(Date.now() - Date.parse(env.created_at));
  if (!Number.isFinite(skew) || skew > SKEW_MS) return [401, { ok: false, code: 'STALE' }];
  if (!await verifySig(env, dev.secret)) return [401, { ok: false, code: 'BAD_SIGNATURE' }];

  const day = env.created_at.slice(0, 10);
  const dir = join(INBOX, day);
  const file = join(dir, env.id + '.json');
  if (seen.has(env.id) || existsSync(file)) {                 // 멱등: 재전송은 조용히 성공
    log('중복 무시  ' + env.id + '  ' + dev.name);
    return [200, { ok: true, id: env.id, duplicate: true }];
  }

  env.received_at = new Date().toISOString();
  await mkdir(dir, { recursive: true });
  await writeFile(file + '.part', JSON.stringify(env));
  const { rename } = await import('node:fs/promises');
  await rename(file + '.part', file);                          // 원자적 완결 신호
  seen.add(env.id);

  log('수신 ' + (b64d(env.enc.ct).length / 1024).toFixed(0).padStart(5) + 'KB  ' +
      env.id + '  ' + dev.name);
  return [200, { ok: true, id: env.id, received_at: env.received_at }];
}

/* ---- 정적 파일 (PWA 자체 서빙: 제3자 호스팅 제거) ---- */
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.webmanifest': 'application/manifest+json', '.ico': 'image/x-icon' };

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
if (existsSync(INBOX)) {                                       // 재시작 시 멱등성 복원
  for (const d of await readdir(INBOX))
    for (const f of await readdir(join(INBOX, d)))
      if (f.endsWith('.json')) seen.add(f.slice(0, -5));
  log('기존 암호문 ' + seen.size + '건 확인');
}

createServer((req, res) => {
  const send = (code, obj) => {
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(obj));
  };
  if (req.method === 'POST' && req.url === '/api/upload') {
    let size = 0; const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > MAX_BODY) { send(413, { ok: false, code: 'TOO_LARGE' }); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', async () => {
      if (res.writableEnded) return;
      try { const [code, body] = await handleUpload(Buffer.concat(chunks).toString('utf8')); send(code, body); }
      catch (e) { log('오류 ' + e.message); send(500, { ok: false, code: 'INTERNAL' }); }
    });
    return;
  }
  if (req.method === 'GET' && req.url === '/api/health') return send(200, { ok: true, ts: Date.now() });
  if (req.method === 'GET') return serveStatic(req, res);
  send(405, { ok: false, code: 'METHOD_NOT_ALLOWED' });
}).listen(PORT, () => {
  log('수신 서버 http://localhost:' + PORT);
  log('정적 파일 ' + STATIC);
  log('암호문 저장 ' + INBOX);
  log('개인키 미보유 — 이 서버는 사진을 복호화할 수 없습니다');
});
