#!/usr/bin/env node
/**
 * 수집기 (CONTRACT v3) — 1단계 검증. 암호문을 복호화해 ERP 투입용 평문을 만든다.
 *
 *   node collector.mjs           1회 실행 후 종료
 *   node collector.mjs --watch   변경 감시 + 5초 안전주기
 *
 * ★ 이 프로세스만 사무실 개인키를 가집니다. 인터넷에 노출하지 마세요. ★
 *
 * 입력   : inbox/enc/<날짜>/<submission_id>.bin
 * 출력   : inbox/ready/{memo|photo}/<날짜>/<record_id>*
 * 상태   : inbox/status/<submission_id>.json     ← 폰이 이걸 보고 로컬 삭제
 * 처리후 : inbox/_processed/<날짜>/
 * 실패   : inbox/_error/<날짜>/
 *
 * 이 파일은 **1단계(검증)** 만 합니다. 문서 보정은 2단계(Python+OpenCV)이며
 * 정규화본이 항상 남으므로 보정이 실패해도 데이터 손실이 없습니다. PIPELINE.md 참조.
 */
import { mkdir, readFile, writeFile, readdir, rename, stat } from 'node:fs/promises';
import { existsSync, watch } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { open as openEnvelope, unpackWire, sha256hex, contentDigest } from './lib/envelope.mjs';
import { probe, strip } from './lib/jpeg.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const argOf = (n, d) => { const i = process.argv.indexOf('--' + n); return i > -1 ? process.argv[i + 1] : d; };
const DATA = join(HERE, argOf('data', '.'));

const ENC = join(DATA, 'inbox', 'enc');
const READY = join(DATA, 'inbox', 'ready');
const STATUS = join(DATA, 'inbox', 'status');
const DONE = join(DATA, 'inbox', '_processed');
const ERR = join(DATA, 'inbox', '_error');
const PRIV = join(DATA, 'keys', 'office-private.jwk.json');

/* ---- 한도 (CONTRACT §2.1) — 초과 시 축소하지 않고 거부한다 ---- */
const LIMIT = {
  photos: 5,
  fileBytes: 5 * 1024 * 1024,
  totalBytes: 25 * 1024 * 1024,
  dim: 4096,
  pixels: 12_000_000,
  memoChars: 2000
};

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

class Reject extends Error {
  constructor(code, detail) { super(code + ': ' + detail); this.code = code; this.detail = detail; }
}

if (!existsSync(PRIV)) {
  console.error('\n사무실 개인키가 없습니다: ' + PRIV);
  console.error('`node keygen.mjs office` 를 먼저 실행하세요.\n');
  process.exit(1);
}
const officeKey = JSON.parse(await readFile(PRIV, 'utf8'));

async function moveTo(base, day, name, srcPath) {
  const dir = join(base, day);
  await mkdir(dir, { recursive: true });
  await rename(srcPath, join(dir, name));
}

async function writeStatus(submissionId, obj) {
  await mkdir(STATUS, { recursive: true });
  const p = join(STATUS, submissionId + '.json');
  await writeFile(p + '.part', JSON.stringify(obj, null, 2));
  await rename(p + '.part', p);
}

/* ---- 입력 검사 (CONTRACT §2.1) ---- */
async function validate(inner, files) {
  const metas = inner.files || [];

  // 구성 — 메모만 / 사진 1~5장 / 메모+사진. 둘 다 비면 거부
  const hasMemo = !!(inner.memo && inner.memo.body && inner.memo.body.trim());
  if (!hasMemo && metas.length === 0)
    throw new Reject('INVALID_SUBMISSION', '메모와 사진이 모두 비어 있음');
  if (metas.length !== files.length)
    throw new Reject('INVALID_SUBMISSION', 'files 메타 수와 실제 수 불일치');
  if (metas.length > LIMIT.photos)
    throw new Reject('RESOURCE_LIMIT_EXCEEDED', '사진 ' + metas.length + '장 (최대 ' + LIMIT.photos + ')');
  if (hasMemo && inner.memo.body.length > LIMIT.memoChars)
    throw new Reject('RESOURCE_LIMIT_EXCEEDED', '메모 ' + inner.memo.body.length + '자');

  // content_digest — wire 메타데이터 기준이므로 재인코딩과 무관하게 불변
  const digest = await contentDigest(inner.submission_id, metas);
  if (inner.__headerDigest && digest !== inner.__headerDigest)
    throw new Reject('CONTENT_DIGEST_MISMATCH', '헤더와 내부 메타 불일치');

  let total = 0;
  const probes = [];

  for (let i = 0; i < metas.length; i++) {
    const m = metas[i], b = files[i], tag = '#' + (m.photo_id ?? i + 1);

    if (m.mime !== 'image/jpeg') throw new Reject('INVALID_MEDIA', tag + ' mime=' + m.mime);
    if (b.length !== m.bytes)
      throw new Reject('CONTENT_DIGEST_MISMATCH', tag + ' 크기 선언 ' + m.bytes + ' 실제 ' + b.length);

    const h = await sha256hex(b);
    if (h !== m.sha256)
      throw new Reject('CONTENT_DIGEST_MISMATCH', tag + ' 해시 불일치');

    if (b.length > LIMIT.fileBytes)
      throw new Reject('RESOURCE_LIMIT_EXCEEDED', tag + ' ' + (b.length / 1048576).toFixed(1) + 'MiB');
    total += b.length;

    const p = probe(b);
    if (!p.ok) throw new Reject('INVALID_MEDIA', tag + ' ' + p.error);
    if (p.width > LIMIT.dim || p.height > LIMIT.dim)
      throw new Reject('RESOURCE_LIMIT_EXCEEDED', tag + ' ' + p.width + '×' + p.height);
    if (p.width * p.height > LIMIT.pixels)
      throw new Reject('RESOURCE_LIMIT_EXCEEDED', tag + ' ' + (p.width * p.height / 1e6).toFixed(1) + 'MP');
    probes.push(p);
  }

  if (total > LIMIT.totalBytes)
    throw new Reject('RESOURCE_LIMIT_EXCEEDED', '전체 ' + (total / 1048576).toFixed(1) + 'MiB');

  return probes;
}

/* ---- 1건 처리 ---- */
async function processOne(day, name, path) {
  const wire = await readFile(path);
  const { header, ct } = unpackWire(wire);

  if (header.key_id !== officeKey.key_id)
    throw new Reject('KEY_MISMATCH', '봉투=' + header.key_id + ' 보유=' + officeKey.key_id);

  const { inner, files } = await openEnvelope({ header, ct }, officeKey.jwk);
  inner.__headerDigest = header.content_digest;
  const probes = await validate(inner, files);
  delete inner.__headerDigest;

  const recordId = crypto.randomUUID();
  const kind = files.length ? 'photo' : 'memo';
  const outDir = join(READY, kind, day);
  await mkdir(outDir, { recursive: true });

  // 메타데이터 제거 — 픽셀은 건드리지 않으므로 무손실.
  // 방향 적용·재인코딩은 2단계(Python)가 한다.
  const outFiles = [];
  for (let i = 0; i < files.length; i++) {
    const m = inner.files[i], p = probes[i];
    const clean = strip(files[i]);
    const fname = recordId + '_' + (m.photo_id ?? i + 1) + '.jpg';
    await writeFile(join(outDir, fname), clean);
    outFiles.push({
      photo_id: m.photo_id ?? i + 1,
      name: fname,
      bytes: clean.length,
      sha256: await sha256hex(clean),
      width: p.width, height: p.height,
      orientation_applied: null,          // 2단계에서 픽셀에 적용 후 기록
      orientation_pending: p.orientation,
      progressive: p.progressive,
      mime: 'image/jpeg',
      wire_bytes: m.bytes,
      wire_sha256: m.sha256,
      metadata_stripped: p.hasMetadata,
      scan: null,
      scan_status: 'pending',             // 2단계 미구현. PIPELINE.md §3
      scan_reason: null
    });
  }

  const verifiedAt = new Date().toISOString();
  const out = {
    ...inner,
    record_id: recordId,
    type: kind,
    received_at: header.received_at || null,
    verified_at: verifiedAt,
    device_id: header.device_id,
    content_digest: header.content_digest,
    files: outFiles
  };

  // 이미지 먼저, JSON 나중 — JSON 존재가 곧 완결 신호 (CONTRACT §5)
  await writeFile(join(outDir, recordId + '.json'), JSON.stringify(out, null, 2));

  await writeStatus(inner.submission_id, {
    submission_id: inner.submission_id,
    device_id: header.device_id,
    verified: true,
    verified_at: verifiedAt,
    record_id: recordId,
    files: outFiles.map(f => ({ photo_id: f.photo_id, bytes: f.bytes, sha256: f.sha256 }))
  });

  await moveTo(DONE, day, name, path);
  return { kind, count: files.length, bytes: outFiles.reduce((s, f) => s + f.bytes, 0), recordId };
}

/* ---- 실패 처리 ---- */
async function failOne(day, name, path, e) {
  const sid = name.replace(/\.bin$/, '');
  let deviceId = null;
  try { deviceId = unpackWire(await readFile(path)).header.device_id; } catch { /* 헤더도 못 읽음 */ }

  await writeStatus(sid, {
    submission_id: sid,
    device_id: deviceId,
    verified: false,
    failed_at: new Date().toISOString(),
    error: e.code || 'INTERNAL',
    error_detail: e.detail || e.message
  }).catch(() => {});
  await moveTo(ERR, day, name, path).catch(() => {});
}

/* ---- 순회 ---- */
async function sweep() {
  if (!existsSync(ENC)) return { done: 0, failed: 0 };
  let done = 0, failed = 0;
  for (const day of await readdir(ENC)) {
    const dayDir = join(ENC, day);
    if (!existsSync(dayDir) || !(await stat(dayDir)).isDirectory()) continue;
    for (const name of await readdir(dayDir)) {
      if (!name.endsWith('.bin')) continue;                  // .part 는 수신 중
      const path = join(dayDir, name);
      try {
        const r = await processOne(day, name, path);
        log('검증 ' + r.kind.padEnd(5) + ' ' + name.slice(0, -4) +
            (r.count ? '  사진 ' + r.count + '장 ' + (r.bytes / 1024).toFixed(0) + 'KB' : '') +
            '  → ' + r.recordId.slice(0, 8));
        done++;
      } catch (e) {
        log('거부   ' + name.slice(0, -4) + '  → ' + (e.code || 'INTERNAL') + ' ' + (e.detail || e.message));
        await failOne(day, name, path, e);
        failed++;
      }
    }
  }
  return { done, failed };
}

/* ---- 실행 ---- */
const isWatch = process.argv.includes('--watch');
log('수집기 시작' + (isWatch ? ' (감시)' : ' (1회)') + '  key_id=' + officeKey.key_id);

let running = false, queued = false;
const run = async () => {
  if (running) { queued = true; return; }
  running = true;
  try {
    const { done, failed } = await sweep();
    if (done || failed) log('처리 ' + done + '건, 거부 ' + failed + '건');
    else if (!isWatch) log('처리할 항목 없음');
  } finally {
    running = false;
    if (queued) { queued = false; setTimeout(run, 50); }
  }
};

await run();

if (isWatch) {
  await mkdir(ENC, { recursive: true });
  let timer = null;
  try {
    watch(ENC, { recursive: true }, () => {            // 리눅스는 inotify — 거의 즉시
      clearTimeout(timer);
      timer = setTimeout(run, 120);                    // 쓰기 완료 대기 (rename 직후)
    });
    log('변경 감시 중 — 도착 즉시 처리');
  } catch {
    log('재귀 감시 미지원 — 주기 폴링으로 대체');
  }
  setInterval(run, 5000);                              // 감시 실패 대비 안전망
}
