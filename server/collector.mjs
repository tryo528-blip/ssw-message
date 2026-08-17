#!/usr/bin/env node
/**
 * 수집기 — 암호문을 복호화해 ERP 투입용 평문으로 떨어뜨린다.
 *
 *   node collector.mjs           1회 실행 후 종료
 *   node collector.mjs --watch   10초마다 반복
 *
 * ★ 이 프로세스만 사무실 개인키를 가집니다. 인터넷에 노출하지 마세요. ★
 *
 * 입력  : inbox/enc/<날짜>/<id>.json         (receiver.mjs 가 저장한 암호문)
 * 출력  : inbox/ready/{memo|photo}/<날짜>/   (CONTRACT.md v1 구조 — ERP 투입 로직 변경 없음)
 * 처리후: inbox/_processed/<날짜>/           (암호문 원본 이동, 보존기간 후 삭제)
 * 실패  : inbox/_error/<날짜>/               (사람이 확인)
 */
import { mkdir, readFile, writeFile, readdir, rename, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { open as openEnvelope, sha256hex } from './lib/envelope.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ENC = join(HERE, 'inbox', 'enc');
const READY = join(HERE, 'inbox', 'ready');
const DONE = join(HERE, 'inbox', '_processed');
const ERR = join(HERE, 'inbox', '_error');
const PRIV = join(HERE, 'keys', 'office-private.jwk.json');

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

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

async function processOne(day, name, path) {
  const env = JSON.parse(await readFile(path, 'utf8'));

  if (env.key_id !== officeKey.key_id)
    throw new Error('키 불일치: 봉투=' + env.key_id + ' 보유=' + officeKey.key_id);

  const { inner, files } = await openEnvelope(env, officeKey.jwk);

  // 무결성 재확인 — 앱이 계산한 해시와 실제 바이트가 맞는지
  for (let i = 0; i < files.length; i++) {
    const meta = inner.files[i];
    if (files[i].length !== meta.bytes)
      throw new Error('파일 크기 불일치: ' + meta.name);
    const h = await sha256hex(files[i]);
    if (meta.sha256 && !h.startsWith(meta.sha256.replace(/…$/, '')))
      throw new Error('해시 불일치: ' + meta.name);
  }

  const kind = inner.type === 'photo' ? 'photo' : 'memo';
  const outDir = join(READY, kind, day);
  await mkdir(outDir, { recursive: true });

  // 이미지 먼저, JSON 나중 — JSON 존재가 곧 완결 신호 (CONTRACT 5절)
  for (let i = 0; i < files.length; i++)
    await writeFile(join(outDir, inner.files[i].name), files[i]);
  inner.received_at = env.received_at;
  await writeFile(join(outDir, env.id + '.json'), JSON.stringify(inner, null, 2));

  await moveTo(DONE, day, name, path);
  return { kind, files: files.length, bytes: files.reduce((s, f) => s + f.length, 0) };
}

async function sweep() {
  if (!existsSync(ENC)) return { done: 0, failed: 0 };
  let done = 0, failed = 0;
  for (const day of await readdir(ENC)) {
    const dayDir = join(ENC, day);
    if (!(await stat(dayDir)).isDirectory()) continue;
    for (const name of await readdir(dayDir)) {
      if (!name.endsWith('.json')) continue;              // .part 는 동기화 중
      const path = join(dayDir, name);
      try {
        const r = await processOne(day, name, path);
        log('복호화 ' + r.kind.padEnd(5) + ' ' + name.slice(0, -5) +
            (r.files ? '  파일 ' + r.files + '개 ' + (r.bytes / 1024).toFixed(0) + 'KB' : ''));
        done++;
      } catch (e) {
        log('실패   ' + name + '  → ' + e.message);
        await moveTo(ERR, day, name, path).catch(() => {});
        failed++;
      }
    }
  }
  return { done, failed };
}

const watch = process.argv.includes('--watch');
log('수집기 시작' + (watch ? ' (10초 주기)' : ' (1회)') + '  key_id=' + officeKey.key_id);
const run = async () => {
  const { done, failed } = await sweep();
  if (done || failed) log('처리 ' + done + '건, 실패 ' + failed + '건');
  else if (!watch) log('처리할 항목 없음');
};
await run();
if (watch) setInterval(run, 10_000);
