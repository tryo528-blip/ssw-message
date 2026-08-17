#!/usr/bin/env node
/** keygen JSON → 오프라인 SVG QR. 온라인 생성기 쓰지 말 것. */
import { writeFile } from 'node:fs/promises';
import QRCode from 'qrcode';

const json = process.argv[2];
const out = process.argv[3];
if (!json || !out) {
  console.error('사용법: node provision-qr.mjs \'<json>\' out.svg');
  process.exit(1);
}
const svg = await QRCode.toString(json, { type: 'svg', errorCorrectionLevel: 'M', margin: 2, width: 360 });
await writeFile(out, svg);
console.log(out);
