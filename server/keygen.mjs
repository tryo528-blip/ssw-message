#!/usr/bin/env node
/**
 * 키 생성 도구 — 외부 패키지 없음 (Node 내장 WebCrypto만 사용)
 *
 *   node keygen.mjs office            사무실 키쌍 생성 (최초 1회)
 *   node keygen.mjs device 김현장      직원 기기 등록 (기기마다 1회)
 *   node keygen.mjs list              등록된 기기 목록
 *   node keygen.mjs provision 김현장   기존 기기 JSON 재출력 (PWA 붙여넣기용)
 *
 * 사무실 개인키는 keys/office-private.jwk.json 에 저장됩니다.
 * 이 파일을 잃으면 미수집 데이터는 영구 복구 불가입니다. 반드시 백업하세요.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const KEYS = join(HERE, 'keys');
const OFFICE_PRIV = join(KEYS, 'office-private.jwk.json');
const OFFICE_PUB = join(KEYS, 'office-public.json');
const DEVICES = join(KEYS, 'devices.json');
const C = globalThis.crypto.subtle;

const b64 = buf => Buffer.from(buf).toString('base64');
const readJson = async p => JSON.parse(await readFile(p, 'utf8'));

async function genOffice() {
  if (existsSync(OFFICE_PRIV)) {
    console.error('\n[중단] 이미 사무실 키가 있습니다: ' + OFFICE_PRIV);
    console.error('       덮어쓰면 기존 암호문을 영원히 못 엽니다.');
    console.error('       정말 교체하려면 기존 파일을 다른 이름으로 옮긴 뒤 다시 실행하세요.\n');
    process.exit(1);
  }
  const kp = await C.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const priv = await C.exportKey('jwk', kp.privateKey);
  const pubRaw = await C.exportKey('raw', kp.publicKey);
  const keyId = 'office-' + new Date().toISOString().slice(0, 7);   // 예: office-2026-08

  await mkdir(KEYS, { recursive: true });
  await writeFile(OFFICE_PRIV, JSON.stringify({ key_id: keyId, jwk: priv }, null, 2), { mode: 0o600 });
  await writeFile(OFFICE_PUB, JSON.stringify({ key_id: keyId, pub: b64(pubRaw) }, null, 2));

  console.log('\n사무실 키쌍 생성 완료');
  console.log('  key_id      : ' + keyId);
  console.log('  개인키(비밀) : ' + OFFICE_PRIV);
  console.log('  공개키(배포) : ' + OFFICE_PUB);
  console.log('  공개키 값    : ' + b64(pubRaw));
  console.log('\n[필수] 개인키 파일을 USB 2개에 백업하고 최소 1벌은 사무실 밖에 보관하세요.');
  console.log('       이 파일이 없으면 수집 전 데이터는 아무도 못 엽니다.\n');
}

async function genDevice(name) {
  if (!name) { console.error('사용법: node keygen.mjs device <사용자명>'); process.exit(1); }
  await mkdir(KEYS, { recursive: true });
  const devices = existsSync(DEVICES) ? await readJson(DEVICES) : {};
  const deviceId = 'dev_' + b64(globalThis.crypto.getRandomValues(new Uint8Array(6)))
    .replace(/[+/=]/g, '').slice(0, 8);
  const secret = b64(globalThis.crypto.getRandomValues(new Uint8Array(32)));

  devices[deviceId] = { name, secret, created_at: new Date().toISOString(), revoked: false };
  await writeFile(DEVICES, JSON.stringify(devices, null, 2), { mode: 0o600 });

  const office = existsSync(OFFICE_PUB) ? await readJson(OFFICE_PUB) : null;
  if (!office) { console.error('\n먼저 `node keygen.mjs office` 를 실행하세요.\n'); process.exit(1); }

  // 폰 설정 QR에 넣을 프로비저닝 패킷
  const provision = {
    v: 1,
    url: process.env.SSW_URL || 'https://사무실주소.duckdns.org',
    device_id: deviceId,
    secret,
    key_id: office.key_id,
    pub: office.pub,
    user: name
  };
  console.log('\n기기 등록 완료 — ' + name);
  console.log('  device_id : ' + deviceId);
  console.log('\n아래 JSON을 QR로 만들어 해당 직원 폰에서 스캔하게 하세요.');
  console.log('(QR 생성기는 오프라인 도구를 쓰세요. 비밀값이 들어 있으므로 온라인 생성기 금지)\n');
  console.log(JSON.stringify(provision));
  writeQr(JSON.stringify(provision), name);
  console.log('\n분실 시: keys/devices.json 에서 "revoked": true 로 바꾸면 즉시 차단됩니다.\n');
}

function writeQr(text, name) {
  const svg = join(KEYS, name + '.svg');
  const script = join(HERE, '../app/scripts/provision-qr.mjs');
  if (!existsSync(script)) return;
  const r = spawnSync(process.execPath, [script, text, svg], { encoding: 'utf8' });
  if (r.status === 0) console.log('오프라인 QR: ' + svg + '  (온라인 생성기 쓰지 말 것)');
  else if (r.stderr) console.error(r.stderr);
}

async function printProvision(name) {
  if (!name) { console.error('사용법: node keygen.mjs provision <이름>'); process.exit(1); }
  if (!existsSync(DEVICES) || !existsSync(OFFICE_PUB)) {
    console.error('\n키가 없습니다. office / device 를 먼저 실행하세요.\n');
    process.exit(1);
  }
  const devices = await readJson(DEVICES);
  const office = await readJson(OFFICE_PUB);
  const found = Object.entries(devices).find(([, d]) => d.name === name && !d.revoked);
  if (!found) { console.error('\n등록된 기기가 없습니다: ' + name + '\n'); process.exit(1); }
  const [deviceId, dev] = found;
  const provision = {
    v: 1,
    url: process.env.SSW_URL || '',
    device_id: deviceId,
    secret: dev.secret,
    key_id: office.key_id,
    pub: office.pub,
    user: name
  };
  const text = JSON.stringify(provision);
  console.log(text);
  writeQr(text, name);
}

async function list() {
  if (!existsSync(DEVICES)) { console.log('등록된 기기가 없습니다.'); return; }
  const devices = await readJson(DEVICES);
  console.log('\n등록 기기 ' + Object.keys(devices).length + '대\n');
  for (const [id, d] of Object.entries(devices)) {
    console.log('  ' + (d.revoked ? '[폐기] ' : '       ') + id + '  ' + d.name +
      '  (' + d.created_at.slice(0, 10) + ')');
  }
  console.log();
}

const [cmd, arg] = process.argv.slice(2);
if (cmd === 'office') await genOffice();
else if (cmd === 'device') await genDevice(arg);
else if (cmd === 'provision') await printProvision(arg);
else if (cmd === 'list') await list();
else {
  console.log('\n사용법:');
  console.log('  node keygen.mjs office              사무실 키쌍 생성 (최초 1회)');
  console.log('  node keygen.mjs device <이름>        직원 기기 등록');
  console.log('  node keygen.mjs provision <이름>     기존 기기 JSON 다시 출력');
  console.log('  node keygen.mjs list                등록 기기 목록\n');
}
