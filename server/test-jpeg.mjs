import { probe, strip } from './lib/jpeg.mjs';

/** 중첩 배열 + Uint8Array 를 모두 펼쳐 이어붙인다 (flat() 은 TypedArray 를 안 펼침) */
function B(...parts) {
  const out = [];
  const push = x => {
    if (x instanceof Uint8Array) { for (const b of x) out.push(b); }
    else if (Array.isArray(x)) { for (const y of x) push(y); }
    else out.push(x);
  };
  parts.forEach(push);
  return Uint8Array.from(out);
}
const seg = (marker, payload) => {
  const p = B(payload);
  return B([0xFF, marker, (p.length + 2) >> 8, (p.length + 2) & 0xFF], p);
};

// EXIF orientation=6 (little endian TIFF)
const tiff = [
  0x49, 0x49, 0x2A, 0x00, 0x08, 0x00, 0x00, 0x00,
  0x01, 0x00,
  0x12, 0x01, 0x03, 0x00, 0x01, 0x00, 0x00, 0x00, 0x06, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00
];
const app0  = seg(0xE0, [0x4A, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]);   // JFIF
const app1  = seg(0xE1, B([0x45, 0x78, 0x69, 0x66, 0, 0], tiff));                  // Exif
const app13 = seg(0xED, [...Array(20).keys()]);                                    // IPTC 흉내
const com   = seg(0xFE, [0x68, 0x69]);
const dqt   = seg(0xDB, [0, ...Array(64).fill(1)]);
const sof   = seg(0xC0, [8, 0x00, 0x64, 0x00, 0xC8, 3, 1, 0x11, 0, 2, 0x11, 1, 3, 0x11, 1]);
const sos   = seg(0xDA, [3, 1, 0, 2, 0x11, 3, 0x11, 0, 0x3F, 0]);
const entropy = [0x12, 0x34, 0x56, 0x78, 0x9A];
const eoi = [0xFF, 0xD9];

const jpg = B([0xFF, 0xD8], app0, app1, app13, com, dqt, sof, sos, entropy, eoi);

let pass = 0, fail = 0;
const t = (name, cond, extra = '') => {
  if (cond) { console.log('  ok   ' + name); pass++; }
  else { console.log('  FAIL ' + name + '  ' + extra); fail++; }
};

console.log('\n원본 ' + jpg.length + '바이트');

console.log('\n[probe]');
const p = probe(jpg);
t('유효 판정', p.ok, JSON.stringify(p));
t('가로 200', p.width === 200, 'got ' + p.width);
t('세로 100', p.height === 100, 'got ' + p.height);
t('3채널', p.components === 3, 'got ' + p.components);
t('orientation 6 읽음', p.orientation === 6, 'got ' + p.orientation);
t('메타데이터 있음 감지', p.hasMetadata === true);
t('baseline 판정', p.progressive === false);

console.log('\n[strip]');
const s = strip(jpg);
const p2 = probe(s);
t('제거 후에도 유효', p2.ok, JSON.stringify(p2));
t('크기 유지', p2.width === 200 && p2.height === 100);
t('메타데이터 사라짐', p2.hasMetadata === false);
t('orientation 사라짐(1)', p2.orientation === 1, 'got ' + p2.orientation);
t('APP1 실제 제거', !hasMarker(s, 0xE1));
t('APP13 실제 제거', !hasMarker(s, 0xED));
t('COM 실제 제거', !hasMarker(s, 0xFE));
t('APP0 보존', hasMarker(s, 0xE0));
t('용량 줄어듦', s.length < jpg.length, jpg.length + ' -> ' + s.length);
t('엔트로피 데이터 무손실', endsWith(s, [0x12, 0x34, 0x56, 0x78, 0x9A, 0xFF, 0xD9]));
t('두 번 제거해도 동일 (멱등)', strip(s).length === s.length);

console.log('\n[progressive]');
const sofP = seg(0xC2, [8, 0x01, 0x00, 0x02, 0x00, 3, 1, 0x11, 0, 2, 0x11, 1, 3, 0x11, 1]);
const pj = probe(B([0xFF, 0xD8], dqt, sofP, sos, entropy, eoi));
t('progressive 감지', pj.ok && pj.progressive === true, JSON.stringify(pj));
t('progressive 크기', pj.width === 512 && pj.height === 256, pj.width + 'x' + pj.height);

console.log('\n[거부]');
t('JPEG 아님', !probe(B([1, 2, 3, 4])).ok);
t('SOI만 있고 잘림', !probe(B([0xFF, 0xD8])).ok);
t('SOF 없음', !probe(B([0xFF, 0xD8], dqt, eoi)).ok);
t('세그먼트 길이 이상', !probe(B([0xFF, 0xD8, 0xFF, 0xE1, 0xFF, 0xFF, 1, 2])).ok);
const badOri = seg(0xE1, B([0x45, 0x78, 0x69, 0x66, 0, 0],
  [0x49, 0x49, 0x2A, 0x00, 0x08, 0x00, 0x00, 0x00, 0x01, 0x00,
   0x12, 0x01, 0x03, 0x00, 0x01, 0x00, 0x00, 0x00, 0x63, 0x00, 0x00, 0x00,   // 99 = 범위 밖
   0x00, 0x00, 0x00, 0x00]));
t('EXIF orientation 범위 밖', !probe(B([0xFF, 0xD8], badOri, dqt, sof, sos, entropy, eoi)).ok);

function hasMarker(u, m) {
  for (let i = 2; i < u.length - 1; i++) {
    if (u[i] !== 0xFF) continue;
    if (u[i + 1] === m) return true;
    if (u[i + 1] === 0xDA) return false;
  }
  return false;
}
function endsWith(u, arr) {
  if (u.length < arr.length) return false;
  return arr.every((v, k) => u[u.length - arr.length + k] === v);
}

console.log('\n' + (fail ? '실패 ' + fail + '건' : '전부 통과 (' + pass + ')') + '\n');
process.exit(fail ? 1 : 0);
