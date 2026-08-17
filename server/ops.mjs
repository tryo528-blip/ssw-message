#!/usr/bin/env node
/**
 * 운영 도구 — 외부 패키지 없음.
 *
 *   node ops.mjs disk              inbox 용량
 *   node ops.mjs gc [--days 14]    _processed / _error 에서 N일 지난 것 삭제
 */
import { readdir, rm, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const INBOX = join(HERE, 'inbox');
const argOf = (n, d) => { const i = process.argv.indexOf('--' + n); return i > -1 ? process.argv[i + 1] : d; };

async function walk(dir, acc = []) {
  if (!existsSync(dir)) return acc;
  for (const name of await readdir(dir)) {
    const p = join(dir, name);
    const s = await stat(p);
    if (s.isDirectory()) await walk(p, acc);
    else acc.push({ path: p, bytes: s.size, mtime: s.mtimeMs });
  }
  return acc;
}

function mb(n) { return (n / 1048576).toFixed(2) + ' MiB'; }

async function disk() {
  const roots = ['_processed', '_error', 'enc', 'ready', 'status'];
  let total = 0;
  console.log('\ninbox 사용량\n');
  for (const r of roots) {
    const files = await walk(join(INBOX, r));
    const sum = files.reduce((s, f) => s + f.bytes, 0);
    total += sum;
    console.log('  ' + r.padEnd(12) + mb(sum).padStart(12) + '  ' + files.length + ' files');
  }
  console.log('  ' + '합계'.padEnd(12) + mb(total).padStart(12) + '\n');
}

async function gc() {
  const days = Number(argOf('days', 14));
  const cutoff = Date.now() - days * 86400_000;
  let removed = 0, bytes = 0;
  for (const r of ['_processed', '_error']) {
    const files = await walk(join(INBOX, r));
    for (const f of files) {
      if (f.mtime >= cutoff) continue;
      await rm(f.path, { force: true });
      removed++;
      bytes += f.bytes;
    }
  }
  console.log('\n삭제 ' + removed + '개, ' + mb(bytes) + '  (' + days + '일 이전 _processed/_error)\n');
}

const cmd = process.argv[2];
if (cmd === 'disk') await disk();
else if (cmd === 'gc') await gc();
else {
  console.log('\n사용법:');
  console.log('  node ops.mjs disk');
  console.log('  node ops.mjs gc [--days 14]\n');
}
