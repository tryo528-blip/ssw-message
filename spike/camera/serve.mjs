#!/usr/bin/env node
/** P0-c 실기 검증용 정적 서버. HTTPS + 아이폰용 HTTP(인증서 배포). 외부 패키지 없음. */
import { createServer as createHttps } from 'node:https';
import { createServer as createHttp } from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { networkInterfaces } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const HTTPS_PORT = Number(process.argv.includes('--port')
  ? process.argv[process.argv.indexOf('--port') + 1]
  : 8443);
const HTTP_PORT = Number(process.argv.includes('--http-port')
  ? process.argv[process.argv.indexOf('--http-port') + 1]
  : 8081);
const CERTS = join(HERE, '.certs');
const keyPath = join(CERTS, 'key.pem');
const certPath = join(CERTS, 'cert.pem');
const caPath = join(CERTS, 'ca.pem');
if (!existsSync(keyPath) || !existsSync(certPath)) {
  console.error('인증서가 없습니다. spike/camera/.certs/ 에 key.pem, cert.pem 을 만드세요.');
  process.exit(1);
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.cer': 'application/x-x509-ca-cert',
  '.pem': 'application/x-x509-ca-cert',
  '.mobileconfig': 'application/x-apple-aspen-config',
};

const ALIAS = {
  '/ca.cer': join(CERTS, 'ca.cer'),
  '/ca.pem': join(CERTS, 'ca.pem'),
  '/ssw-camera.mobileconfig': join(CERTS, 'ssw-camera.mobileconfig'),
};

function handle(req, res) {
  let rel = decodeURIComponent((req.url || '/').split('?')[0]);
  if (rel === '/') rel = '/index.html';
  const aliased = ALIAS[rel];
  const file = aliased || join(HERE, rel.replace(/^\/+/, '').replace(/\.\./g, ''));
  if (!file.startsWith(HERE) || !existsSync(file) || !statSync(file).isFile()) {
    res.writeHead(404);
    res.end('not found');
    return;
  }
  res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' });
  res.end(readFileSync(file));
}

function lanIps() {
  const out = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const n of list || []) {
      if (n.family === 'IPv4' && !n.internal) out.push(n.address);
    }
  }
  return out;
}

const tls = { key: readFileSync(keyPath), cert: readFileSync(certPath) };
if (existsSync(caPath)) tls.cert = Buffer.concat([tls.cert, Buffer.from('\n'), readFileSync(caPath)]);

createHttps(tls, handle).listen(HTTPS_PORT, '0.0.0.0', () => {
  for (const ip of ['127.0.0.1', ...lanIps()])
    console.log('https://' + ip + ':' + HTTPS_PORT);
});
createHttp(handle).listen(HTTP_PORT, '0.0.0.0', () => {
  for (const ip of lanIps())
    console.log('iphone first: http://' + ip + ':' + HTTP_PORT + '/ios.html');
});
