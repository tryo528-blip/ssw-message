# 수신 서버 프로토타입

외부 패키지 0개. Node 내장 모듈만 사용합니다 (`npm install` 불필요).

## 왜 프로세스를 둘로 나눴나

```
인터넷 ──▶ receiver.mjs ──▶ inbox/enc/     (암호문 그대로 저장)
           개인키 없음              │
                                    ▼
                          collector.mjs ──▶ inbox/ready/  ──▶ ERP
                          개인키 보유 · 인터넷 미노출
```

**수신 서버는 사무실 개인키를 갖지 않습니다.** 서명을 검증하고 암호문을 저장하는 것이
전부입니다. 인터넷에 노출된 프로세스가 통째로 털려도 사진은 복호화되지 않습니다.
복호화는 외부에서 접근할 수 없는 `collector.mjs` 가 담당합니다.

---

## 처음 한 번

```bash
node keygen.mjs office
```

사무실 키쌍을 만듭니다. **`keys/office-private.jwk.json` 을 USB 2개에 백업하고
최소 1벌은 사무실 밖에 보관하세요.** 이 파일을 잃으면 수집 전 데이터는 아무도 못 엽니다.

```bash
node keygen.mjs device 김현장
```

직원 기기를 등록하고 QR용 프로비저닝 JSON을 출력합니다. 이 JSON에는 기기 비밀값이
들어 있으므로 **QR 생성은 반드시 오프라인 도구로** 하세요.

분실 단말은 `keys/devices.json` 에서 `"revoked": true` 로 바꾸면 즉시 차단됩니다.

---

## 실행

```bash
node receiver.mjs --port 8443
```

```bash
node collector.mjs --watch
```

동작 확인 (폰 시뮬레이터):

```bash
node test-client.mjs --url http://localhost:8443
```

---

## 검증된 항목

`test-client.mjs` 9개 검사 전부 통과 (2026-08-17 실측):

| 검사 | 결과 |
|---|---|
| 메모 전송 | 통과 |
| 사진 2장(600KB) 전송 | 통과 — 암호화+직렬화 **5ms** |
| 같은 id 재전송 | 중복 무시 (멱등) |
| id 위조 | 서명 거부 |
| 암호문 1바이트 변조 | 서명 거부 |
| 30분 지난 요청 | 거부 (재전송 공격 방어) |
| 미등록 기기 | 거부 |
| 알 수 없는 schema | 거부 |
| 분당 30건 초과 | 429 차단 |

복호화 결과도 확인했습니다.

- 사진 2장이 **원본과 바이트 단위로 동일** (307,200B × 2), sha256 일치
- 메모의 줄바꿈·이모지 원문 보존
- **암호문 보관소에서 메모 내용을 검색하면 0건**, 복호화 산출물에서는 검색됨
  → 수신 서버 단계에서 실제로 읽을 수 없는 상태임이 확인됨

---

## 운영 배포 (HTTPS)

Caddy를 앞에 두면 Let's Encrypt 인증서를 자동으로 발급·갱신합니다.
무료 DDNS 주소를 그대로 쓸 수 있습니다.

```
사무실주소.duckdns.org {
    reverse_proxy localhost:8443
    header {
        Strict-Transport-Security "max-age=31536000"
        X-Content-Type-Options nosniff
        Referrer-Policy no-referrer
    }
}
```

공유기에서 **443 포트만** 사무실 PC로 포워딩합니다. 그 외 포트는 열지 않습니다.

---

## 다음 단계에서 손볼 것

- **base64 오버헤드 33%** — 600KB 사진이 801KB로 전송됩니다. PWA를 이 서버에서 직접
  서빙하면 동일 출처가 되어 CORS 우회용 `text/plain` 트릭이 불필요해지므로,
  암호문을 바이너리 본문으로 그대로 POST해 33%를 회수할 수 있습니다. 현장 회선에서 유의미합니다.
- 멱등성 캐시가 메모리 + 파일 존재 확인이라 대용량에서는 인덱스가 필요합니다 (현 규모에선 불필요).
- `_processed` / `_error` 보존기간 자동 삭제 스케줄러 미구현.
- 수신 실패 알림(메일/문자) 미구현.
