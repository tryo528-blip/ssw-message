#!/usr/bin/env node
/**
 * 사무실 네트워크 진단 — 직접 수신이 가능한 환경인지 확인합니다.
 *
 *   node check-network.mjs
 *
 * 하는 일: 이 PC의 내부 주소 확인, 인터넷에서 보이는 주소 조회,
 *          CGNAT(공유 주소) 여부 판정, 443 포트 사용 여부 확인.
 *
 * 외부 호출은 공인 IP 조회 1건뿐입니다 (api.ipify.org).
 * 이 주소는 인터넷에 접속하면 어느 사이트든 알게 되는 값이라 추가로 노출되는 정보는 없습니다.
 */
import { networkInterfaces } from 'node:os';
import { createServer } from 'node:net';

const 초록 = s => '\x1b[32m' + s + '\x1b[0m';
const 빨강 = s => '\x1b[31m' + s + '\x1b[0m';
const 노랑 = s => '\x1b[33m' + s + '\x1b[0m';

console.log('\n사무실 네트워크 진단\n' + '─'.repeat(46));

/* 1. 내부 주소 */
const locals = [];
for (const [name, addrs] of Object.entries(networkInterfaces()))
  for (const a of addrs || [])
    if (a.family === 'IPv4' && !a.internal) locals.push({ name, ip: a.address });

console.log('\n[1] 이 컴퓨터의 내부 주소');
if (!locals.length) console.log('    ' + 빨강('네트워크 연결 없음'));
for (const l of locals) console.log('    ' + l.ip.padEnd(16) + l.name);
console.log('    → 공유기 포트포워딩에서 "목적지"로 지정할 주소입니다.');
console.log('    ' + 노랑('※ 이 주소가 바뀌면 포워딩이 깨집니다. 공유기에서 고정 IP로 할당하세요.'));

/* 2. 공인 IP */
console.log('\n[2] 인터넷에서 보이는 주소');
let pub = null;
try {
  const res = await fetch('https://api.ipify.org?format=json', { signal: AbortSignal.timeout(8000) });
  pub = (await res.json()).ip;
  console.log('    ' + pub);
} catch (e) {
  console.log('    ' + 빨강('조회 실패') + ' — 인터넷 연결을 확인하세요 (' + e.message + ')');
}

/* 3. CGNAT 판정 */
console.log('\n[3] 밖에서 찾아올 수 있는 주소인가');
if (pub) {
  const [a, b] = pub.split('.').map(Number);
  const cgnat = a === 100 && b >= 64 && b <= 127;          // 100.64.0.0/10
  const priv = a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  if (cgnat || priv) {
    console.log('    ' + 빨강('불가 — 공유 주소(CGNAT)입니다'));
    console.log('    여러 가입자가 주소 하나를 나눠 쓰는 방식이라 밖에서 찾아올 수 없습니다.');
    console.log('    → 통신사에 "고정 IP 말고 공인 IP로 바꿔달라"고 요청하세요. 대개 무료입니다.');
    console.log('    → 안 되면 암호화를 유지한 채 다른 경로로 우회 설계합니다.');
  } else {
    console.log('    ' + 초록('가능해 보입니다') + ' — 일반 공인 주소 대역입니다.');
    console.log('    ' + 노랑('다만 공유기가 2대 연결된 경우(이중 NAT)는 이 검사로 못 잡습니다.'));
    console.log('    공유기 관리페이지의 "WAN IP" 가 위 주소와 같은지 확인하세요.');
    console.log('      같으면  → 공유기 1대. 포워딩 1번만 하면 됩니다.');
    console.log('      다르면  → 공유기가 2대입니다. 둘 다 포워딩해야 합니다.');
  }
} else console.log('    판정 불가 (공인 IP 조회 실패)');

/* 4. 443 포트 */
console.log('\n[4] 443 포트 사용 여부');
await new Promise(resolve => {
  const s = createServer();
  s.once('error', e => {
    console.log('    ' + (e.code === 'EADDRINUSE'
      ? 노랑('이미 사용 중') + ' — 다른 프로그램이 443을 쓰고 있습니다. 확인 후 정리하세요.'
      : e.code === 'EACCES'
        ? 노랑('권한 부족') + ' — 관리자 권한으로 실행해야 합니다.'
        : 빨강(e.code)));
    resolve();
  });
  s.once('listening', () => { console.log('    ' + 초록('비어 있음') + ' — Caddy가 쓸 수 있습니다.'); s.close(resolve); });
  s.listen(443, '0.0.0.0');
});

/* 5. 다음 할 일 */
console.log('\n' + '─'.repeat(46));
console.log('다음 순서는 docs/SETUP.md 를 따르세요.');
console.log('  1) 무료 DDNS 주소 만들기');
console.log('  2) 공유기에서 443 → 이 컴퓨터로 포워딩');
console.log('  3) Caddy 설치 후 HTTPS 자동 발급');
console.log('  4) 휴대폰 데이터(와이파이 끄고)로 접속해 최종 확인\n');
