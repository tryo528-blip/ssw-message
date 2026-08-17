/**
 * 봉투 규격 ssw-msg/2 — 암호화·복호화 참조 구현
 *
 * 브라우저(Web Crypto)와 Node(내장 WebCrypto)에서 동일한 API를 쓰므로
 * 이 파일의 로직은 PWA 쪽에 거의 그대로 이식됩니다.
 *
 * 평문 레이아웃 (암호화 대상):
 *   [4바이트 BE: JSON 길이][JSON(UTF-8)][파일1 바이트][파일2 바이트]...
 *   파일 경계는 JSON 의 files[].bytes 순서로 복원합니다.
 */
const C = globalThis.crypto.subtle;
const ALG = 'ECDH-P256+HKDF-SHA256+AES-256-GCM';
const HKDF_INFO = new TextEncoder().encode('ssw-msg/2');

export const b64e = buf => Buffer.from(buf).toString('base64');
export const b64d = s => new Uint8Array(Buffer.from(s, 'base64'));

export async function sha256hex(bytes) {
  return Buffer.from(await C.digest('SHA-256', bytes)).toString('hex');
}

/** 임시 개인키 + 상대 공개키 → AES-256-GCM 키 */
async function deriveAesKey(privateKey, peerPubRaw, usage) {
  const peer = await C.importKey('raw', peerPubRaw, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = await C.deriveBits({ name: 'ECDH', public: peer }, privateKey, 256);
  const hk = await C.importKey('raw', shared, 'HKDF', false, ['deriveKey']);
  return C.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: HKDF_INFO },
    hk, { name: 'AES-GCM', length: 256 }, false, [usage]);
}

/** 내부 봉투 + 파일들을 하나의 평문 버퍼로 직렬화 */
export function pack(innerEnvelope, files) {
  const json = new TextEncoder().encode(JSON.stringify(innerEnvelope));
  const total = 4 + json.length + files.reduce((s, f) => s + f.length, 0);
  const out = new Uint8Array(total);
  new DataView(out.buffer).setUint32(0, json.length, false);
  out.set(json, 4);
  let off = 4 + json.length;
  for (const f of files) { out.set(f, off); off += f.length; }
  return out;
}

export function unpack(plain) {
  const dv = new DataView(plain.buffer, plain.byteOffset, plain.byteLength);
  const jsonLen = dv.getUint32(0, false);
  if (jsonLen > plain.length - 4) throw new Error('평문 손상: JSON 길이 불일치');
  const inner = JSON.parse(new TextDecoder().decode(plain.subarray(4, 4 + jsonLen)));
  const files = [];
  let off = 4 + jsonLen;
  for (const meta of inner.files || []) {
    files.push(plain.subarray(off, off + meta.bytes));
    off += meta.bytes;
  }
  if (off !== plain.length) throw new Error('평문 손상: 파일 길이 합 불일치');
  return { inner, files };
}

/** [폰] 암호화 + 서명 → 전송할 봉투 */
export async function seal({ inner, files = [], officePubB64, keyId, deviceId, deviceSecret }) {
  const plain = pack(inner, files);
  const eph = await C.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const key = await deriveAesKey(eph.privateKey, b64d(officePubB64), 'encrypt');
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const aad = new TextEncoder().encode(inner.id);          // id 를 봉투에 결속
  const ct = new Uint8Array(await C.encrypt({ name: 'AES-GCM', iv, additionalData: aad }, key, plain));
  const epk = new Uint8Array(await C.exportKey('raw', eph.publicKey));

  const env = {
    schema: 'ssw-msg/2',
    id: inner.id,
    created_at: inner.created_at,
    device_id: deviceId,
    key_id: keyId,
    enc: { alg: ALG, epk: b64e(epk), iv: b64e(iv), ct: b64e(ct) }
  };
  env.sig = await sign(env, deviceSecret);
  return env;
}

/** [사무실] 복호화 */
export async function open(env, officePrivJwk) {
  if (env.schema !== 'ssw-msg/2') throw new Error('알 수 없는 schema: ' + env.schema);
  if (env.enc.alg !== ALG) throw new Error('알 수 없는 alg: ' + env.enc.alg);
  const priv = await C.importKey('jwk', officePrivJwk,
    { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
  const key = await deriveAesKey(priv, b64d(env.enc.epk), 'decrypt');
  const aad = new TextEncoder().encode(env.id);
  const plain = new Uint8Array(await C.decrypt(
    { name: 'AES-GCM', iv: b64d(env.enc.iv), additionalData: aad }, key, b64d(env.enc.ct)));
  return unpack(plain);
}

/* ---- 위조 방지 서명 (암호화와 별개) ---- */

async function hmacKey(secretB64) {
  return C.importKey('raw', b64d(secretB64), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}
function sigBase(env, ctHash) {
  return new TextEncoder().encode(
    [env.id, env.created_at, env.device_id, env.key_id, ctHash].join('.'));
}
export async function sign(env, secretB64) {
  const ctHash = await sha256hex(b64d(env.enc.ct));
  const k = await hmacKey(secretB64);
  return b64e(await C.sign('HMAC', k, sigBase(env, ctHash)));
}
export async function verify(env, secretB64) {
  if (!env.sig) return false;
  const ctHash = await sha256hex(b64d(env.enc.ct));
  const k = await hmacKey(secretB64);
  return C.verify('HMAC', k, b64d(env.sig), sigBase(env, ctHash));
}
