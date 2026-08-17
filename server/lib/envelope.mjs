/**
 * 봉투 규격 ssw-msg/3 — 암호화·복호화 참조 구현
 *
 * ★ 이 파일은 PWA 쪽에 그대로 이식됩니다. Node 전용 API(Buffer 등)를 쓰지 마세요. ★
 *   Web Crypto 와 표준 JS 만 사용합니다.
 *
 * 두 겹 구조:
 *   바깥 봉투(header) — 평문. 라우팅·멱등·서명에 필요한 최소 정보만
 *   속 봉투(inner)    — 암호문 안. 사용자·현장·메모·파일 목록
 *
 * 평문 레이아웃 (암호화 대상):
 *   [4바이트 BE: JSON 길이][JSON(UTF-8)][파일1 바이트][파일2 바이트]...
 *
 * 전송/저장 레이아웃 (wire):
 *   [4바이트 BE: 헤더 길이][헤더 JSON(UTF-8)][암호문 바이트]
 *   base64를 쓰지 않으므로 v2 대비 전송량이 33% 줄어듭니다.
 */
const C = globalThis.crypto.subtle;

export const SCHEMA = 'ssw-msg/3';
export const ALG = 'ECDH-P256+HKDF-SHA256+AES-256-GCM';
const HKDF_INFO = new TextEncoder().encode(SCHEMA);

/* ---- 인코딩 유틸 (브라우저·Node 공용) ---- */

const u8of = b => b instanceof Uint8Array ? b : new Uint8Array(b);

export function b64e(buf) {
  const u = u8of(buf);
  let s = '';
  for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]);
  return btoa(s);
}
export function b64d(str) {
  const s = atob(str);
  const u = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i);
  return u;
}
export function hex(buf) {
  const u = u8of(buf);
  let s = '';
  for (let i = 0; i < u.length; i++) s += u[i].toString(16).padStart(2, '0');
  return s;
}
export async function sha256hex(bytes) {
  return hex(await C.digest('SHA-256', u8of(bytes)));
}

/** 시각 정렬 가능한 충돌 없는 식별자. 기기가 만들고 멱등성 키로 씁니다. */
const ULID_CHARS = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export function ulid(now = Date.now()) {
  let t = '';
  for (let i = 9; i >= 0; i--) { t = ULID_CHARS[now % 32] + t; now = Math.floor(now / 32); }
  const rnd = globalThis.crypto.getRandomValues(new Uint8Array(16));
  let r = '';
  for (let i = 0; i < 16; i++) r += ULID_CHARS[rnd[i] % 32];
  return t + r;
}

/* ---- content_digest ----
 * wire(전송 당시) 바이트만으로 계산합니다.
 * 서버가 정규화·보정으로 재인코딩해도 이 값은 변하지 않으므로,
 * 같은 제출의 재전송이 항상 같은 판정을 받습니다.  CONTRACT §1.1
 */
export async function contentDigest(submissionId, fileMetas) {
  const parts = [submissionId];
  for (const f of fileMetas)
    parts.push([f.photo_id, f.mime, f.bytes, f.sha256].join(':'));
  return sha256hex(new TextEncoder().encode(parts.join('\n')));
}

/* ---- 키 유도 ---- */

async function deriveAesKey(privateKey, peerPubRaw, usage) {
  const peer = await C.importKey('raw', peerPubRaw, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = await C.deriveBits({ name: 'ECDH', public: peer }, privateKey, 256);
  const hk = await C.importKey('raw', shared, 'HKDF', false, ['deriveKey']);
  return C.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: HKDF_INFO },
    hk, { name: 'AES-GCM', length: 256 }, false, [usage]);
}

/* ---- 평문 직렬화 ---- */

export function pack(inner, files) {
  const json = new TextEncoder().encode(JSON.stringify(inner));
  const total = 4 + json.length + files.reduce((s, f) => s + f.length, 0);
  const out = new Uint8Array(total);
  new DataView(out.buffer).setUint32(0, json.length, false);
  out.set(json, 4);
  let off = 4 + json.length;
  for (const f of files) { out.set(f, off); off += f.length; }
  return out;
}

export function unpack(plain) {
  if (plain.length < 4) throw new Error('평문 손상: 너무 짧음');
  const dv = new DataView(plain.buffer, plain.byteOffset, plain.byteLength);
  const jsonLen = dv.getUint32(0, false);
  if (jsonLen > plain.length - 4) throw new Error('평문 손상: JSON 길이 불일치');
  const inner = JSON.parse(new TextDecoder().decode(plain.subarray(4, 4 + jsonLen)));
  const files = [];
  let off = 4 + jsonLen;
  for (const meta of inner.files || []) {
    if (off + meta.bytes > plain.length) throw new Error('평문 손상: 파일 경계 초과');
    files.push(plain.subarray(off, off + meta.bytes));
    off += meta.bytes;
  }
  if (off !== plain.length) throw new Error('평문 손상: 파일 길이 합 불일치');
  return { inner, files };
}

/* ---- wire 직렬화 (전송·저장 공용) ---- */

export function packWire({ header, ct }) {
  const json = new TextEncoder().encode(JSON.stringify(header));
  const out = new Uint8Array(4 + json.length + ct.length);
  new DataView(out.buffer).setUint32(0, json.length, false);
  out.set(json, 4);
  out.set(ct, 4 + json.length);
  return out;
}

export function unpackWire(buf) {
  const u = u8of(buf);
  if (u.length < 4) throw new Error('wire 손상: 너무 짧음');
  const dv = new DataView(u.buffer, u.byteOffset, u.byteLength);
  const len = dv.getUint32(0, false);
  if (len > u.length - 4 || len > 64 * 1024) throw new Error('wire 손상: 헤더 길이 불일치');
  const header = JSON.parse(new TextDecoder().decode(u.subarray(4, 4 + len)));
  return { header, ct: u.subarray(4 + len) };
}

/* ---- [폰] 암호화 + 서명 ---- */

export async function seal({ inner, files = [], officePubB64, keyId, deviceId, deviceSecret }) {
  const digest = await contentDigest(inner.submission_id, inner.files || []);

  const plain = pack(inner, files);
  const eph = await C.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const key = await deriveAesKey(eph.privateKey, b64d(officePubB64), 'encrypt');
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const aad = new TextEncoder().encode(inner.submission_id);   // 봉투와 암호문을 결속
  const ct = new Uint8Array(await C.encrypt(
    { name: 'AES-GCM', iv, additionalData: aad }, key, plain));
  const epk = new Uint8Array(await C.exportKey('raw', eph.publicKey));

  const header = {
    schema: SCHEMA,
    submission_id: inner.submission_id,
    content_digest: digest,
    created_at: inner.created_at,
    device_id: deviceId,
    key_id: keyId,
    enc: { alg: ALG, epk: b64e(epk), iv: b64e(iv) }
  };
  header.sig = await sign(header, ct, deviceSecret);
  return { header, ct };
}

/* ---- [사무실] 복호화 ---- */

export async function open({ header, ct }, officePrivJwk) {
  if (header.schema !== SCHEMA) throw new Error('알 수 없는 schema: ' + header.schema);
  if (header.enc.alg !== ALG) throw new Error('알 수 없는 alg: ' + header.enc.alg);
  const priv = await C.importKey('jwk', officePrivJwk,
    { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
  const key = await deriveAesKey(priv, b64d(header.enc.epk), 'decrypt');
  const aad = new TextEncoder().encode(header.submission_id);
  const plain = new Uint8Array(await C.decrypt(
    { name: 'AES-GCM', iv: b64d(header.enc.iv), additionalData: aad }, key, u8of(ct)));
  return unpack(plain);
}

/* ---- 위조 방지 서명 (암호화와 별개 목적) ---- */

async function hmacKey(secretB64, usage) {
  return C.importKey('raw', b64d(secretB64), { name: 'HMAC', hash: 'SHA-256' }, false, [usage]);
}

async function sigBase(header, ct) {
  const ctHash = await sha256hex(ct);
  return new TextEncoder().encode([
    header.submission_id, header.content_digest, header.created_at,
    header.device_id, header.key_id, ctHash
  ].join('.'));
}

export async function sign(header, ct, secretB64) {
  return b64e(await C.sign('HMAC', await hmacKey(secretB64, 'sign'), await sigBase(header, ct)));
}

export async function verify(header, ct, secretB64) {
  if (!header.sig) return false;
  return C.verify('HMAC', await hmacKey(secretB64, 'verify'),
    b64d(header.sig), await sigBase(header, ct));
}

/* ---- 상태 조회 서명 (POST /api/status) ---- */

export async function signStatus(submissionId, deviceId, secretB64) {
  const base = new TextEncoder().encode(['status', submissionId, deviceId].join('.'));
  return b64e(await C.sign('HMAC', await hmacKey(secretB64, 'sign'), base));
}

export async function verifyStatus(submissionId, deviceId, sig, secretB64) {
  if (!sig) return false;
  const base = new TextEncoder().encode(['status', submissionId, deviceId].join('.'));
  return C.verify('HMAC', await hmacKey(secretB64, 'verify'), b64d(sig), base);
}
