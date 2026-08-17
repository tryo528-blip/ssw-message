/**
 * JPEG 검사 + 메타데이터 제거 — 디코딩 없이 바이트 수준에서 처리
 *
 * 왜 디코딩을 안 하나:
 *   Node 에는 JPEG 디코더가 없습니다. 픽셀을 건드리는 작업(방향 적용, 재인코딩,
 *   문서 보정)은 2단계 Python+OpenCV 가 맡습니다.
 *   하지만 개인정보가 실제로 들어있는 곳은 픽셀이 아니라 **메타데이터 세그먼트**이고,
 *   그건 디코딩 없이 잘라낼 수 있습니다. 그래서 1단계에서 즉시 제거합니다.
 *
 * 제거 대상 — GPS·촬영시각·기기모델·썸네일·설명문이 들어가는 곳
 *   APP1 (EXIF, XMP) · APP13 (IPTC/Photoshop) · COM · 기타 벤더 APPn
 * 보존 대상 — 개인정보가 없고 없으면 색이 틀어지는 것
 *   APP0 (JFIF) · APP2 (ICC 색프로파일) · APP14 (Adobe 색변환)
 *
 * ★ EXIF 썸네일이 APP1 안에 통째로 들어있습니다. 원본을 축소해 보내도
 *   썸네일에 원본 정보가 남는 사고가 흔합니다. 그래서 APP1 제거가 중요합니다.
 */

const SOI = 0xD8, EOI = 0xD9, SOS = 0xDA, TEM = 0x01;
const isRST = m => m >= 0xD0 && m <= 0xD7;
const isSOF = m => m >= 0xC0 && m <= 0xCF && m !== 0xC4 && m !== 0xC8 && m !== 0xCC;

/** 잘라낼 세그먼트인가 */
function isStrippable(marker) {
  if (marker === 0xFE) return true;                    // COM
  if (marker < 0xE0 || marker > 0xEF) return false;    // APPn 아님
  const n = marker - 0xE0;
  return !(n === 0 || n === 2 || n === 14);            // APP0/APP2/APP14 만 보존
}

/**
 * 구조를 훑어 크기·방향·이상 여부를 확인한다. 픽셀은 건드리지 않는다.
 * @returns {{ok:boolean, error?:string, width?:number, height?:number,
 *            components?:number, progressive?:boolean, orientation?:number,
 *            hasMetadata?:boolean}}
 */
export function probe(bytes) {
  const u = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (u.length < 4) return { ok: false, error: 'JPEG 아님: 너무 짧음' };
  if (u[0] !== 0xFF || u[1] !== SOI) return { ok: false, error: 'JPEG 아님: SOI 없음' };

  let i = 2, sof = null, orientation = 0, hasMetadata = false, progressive = false;

  while (i < u.length) {
    if (u[i] !== 0xFF) return { ok: false, error: '손상: 마커 위치 오류 @' + i };
    while (i < u.length && u[i] === 0xFF) i++;          // 채움 바이트 건너뜀
    if (i >= u.length) return { ok: false, error: '손상: 마커 없이 끝남' };
    const marker = u[i++];

    if (marker === SOI || marker === EOI || marker === TEM || isRST(marker)) continue;

    if (i + 2 > u.length) return { ok: false, error: '손상: 길이 필드 잘림' };
    const segLen = (u[i] << 8) | u[i + 1];
    if (segLen < 2 || i + segLen > u.length) return { ok: false, error: '손상: 세그먼트 길이 이상' };
    const payload = u.subarray(i + 2, i + segLen);

    if (isStrippable(marker)) hasMetadata = true;

    if (marker === 0xE1 && !orientation) {
      const o = readExifOrientation(payload);
      if (o === -1) return { ok: false, error: 'EXIF 손상' };
      if (o) orientation = o;
    }

    if (isSOF(marker)) {
      if (payload.length < 6) return { ok: false, error: '손상: SOF 페이로드 부족' };
      progressive = marker === 0xC2;
      sof = {
        height: (payload[1] << 8) | payload[2],
        width: (payload[3] << 8) | payload[4],
        components: payload[5]
      };
    }

    i += segLen;
    if (marker === SOS) break;                          // 이후는 엔트로피 데이터
  }

  if (!sof) return { ok: false, error: '손상: 프레임 헤더(SOF) 없음' };
  if (!sof.width || !sof.height) return { ok: false, error: '손상: 크기 0' };

  return {
    ok: true,
    width: sof.width, height: sof.height, components: sof.components,
    progressive, orientation: orientation || 1, hasMetadata
  };
}

/**
 * APP1(Exif) 페이로드에서 Orientation(0x0112) 을 읽는다.
 * @returns 1~8, 없으면 0, 손상이면 -1
 */
function readExifOrientation(p) {
  // "Exif\0\0"
  if (p.length < 14) return 0;
  if (!(p[0] === 0x45 && p[1] === 0x78 && p[2] === 0x69 && p[3] === 0x66 && p[4] === 0 && p[5] === 0))
    return 0;                                            // XMP 등 다른 APP1
  const t = p.subarray(6);
  const le = t[0] === 0x49 && t[1] === 0x49;
  const be = t[0] === 0x4D && t[1] === 0x4D;
  if (!le && !be) return -1;

  const r16 = o => o + 2 > t.length ? -1 : (le ? t[o] | (t[o + 1] << 8) : (t[o] << 8) | t[o + 1]);
  const r32 = o => o + 4 > t.length ? -1
    : (le ? (t[o] | (t[o + 1] << 8) | (t[o + 2] << 16) | (t[o + 3] << 24)) >>> 0
          : ((t[o] << 24) | (t[o + 1] << 16) | (t[o + 2] << 8) | t[o + 3]) >>> 0);

  if (r16(2) !== 42) return -1;
  const ifd = r32(4);
  if (ifd < 8 || ifd + 2 > t.length) return -1;
  const count = r16(ifd);
  if (count < 0 || ifd + 2 + count * 12 > t.length) return -1;

  for (let k = 0; k < count; k++) {
    const e = ifd + 2 + k * 12;
    if (r16(e) !== 0x0112) continue;
    const v = r16(e + 8);
    return v >= 1 && v <= 8 ? v : -1;                    // 범위 밖이면 손상으로 본다
  }
  return 0;
}

/**
 * 메타데이터 세그먼트를 제거한 새 JPEG 바이트를 만든다.
 * 픽셀 데이터는 한 바이트도 건드리지 않으므로 무손실이다.
 */
export function strip(bytes) {
  const u = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const keep = [];                                       // [start, end) 구간들
  let i = 2, run = 0;                                    // run: 유지 구간 시작

  keep.push([0, 2]);                                     // SOI
  run = 2;

  while (i < u.length) {
    if (u[i] !== 0xFF) break;
    let j = i;
    while (j < u.length && u[j] === 0xFF) j++;
    if (j >= u.length) break;
    const marker = u[j];
    const after = j + 1;

    if (marker === SOI || marker === EOI || marker === TEM || isRST(marker)) { i = after; continue; }
    if (after + 2 > u.length) break;
    const segLen = (u[after] << 8) | u[after + 1];
    if (segLen < 2 || after + segLen > u.length) break;
    const segEnd = after + segLen;

    if (isStrippable(marker)) {
      if (i > run) keep.push([run, i]);                  // 여기까지 유지
      run = segEnd;                                      // 세그먼트 통째로 건너뜀
    }

    i = segEnd;
    if (marker === SOS) { i = u.length; break; }         // 이후는 전부 유지
  }
  if (run < u.length) keep.push([run, u.length]);

  const total = keep.reduce((s, [a, b]) => s + (b - a), 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const [a, b] of keep) { out.set(u.subarray(a, b), off); off += b - a; }
  return out;
}
