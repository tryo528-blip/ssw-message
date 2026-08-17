# 수신 서버 (CONTRACT v3)

외부 패키지 0개. Node 내장 모듈만 사용합니다 (`npm install` 불필요).

문서 보정(2단계)은 아직 미구현입니다. Python + OpenCV로 별도 구현 예정 — [PIPELINE.md](../docs/PIPELINE.md) §3.

## 왜 프로세스를 둘로 나눴나

```
인터넷 ──▶ receiver.mjs ──▶ inbox/enc/     (암호문 그대로 저장)
           개인키 없음              │
                                    ▼
                          collector.mjs ──▶ inbox/ready/  ──▶ ERP
                          개인키 보유 · 인터넷 미노출     │
                                    │                     │
                                    └──▶ inbox/status/ ◀──┘
                                         (폰이 조회 · receiver 는 읽기만)
```

**수신 서버는 사무실 개인키를 갖지 않습니다.** 서명을 검증하고 암호문을 저장하는 것이
전부입니다. 인터넷에 노출된 프로세스가 통째로 털려도 사진은 복호화되지 않습니다.
복호화는 외부에서 접근할 수 없는 `collector.mjs` 가 담당합니다.

상태 조회 API(`POST /api/status`)도 마찬가지입니다. collector가 써둔 상태 파일을
**읽어서 돌려줄 뿐** 복호화하지 않습니다.

리눅스에서는 이 분리가 파일 권한으로 강제됩니다 — [SETUP.md](../docs/SETUP.md) 5단계.

## 파일 구성

| 파일 | 역할 |
|---|---|
| `receiver.mjs` | 인터넷 수신. 서명 검증 → 암호문 저장. 상태 조회. PWA 정적 서빙 |
| `collector.mjs` | 1단계 검증. 복호화 → 입력 검사 → 메타데이터 제거 → `ready/` |
| `keygen.mjs` | 사무실 키쌍 생성, 기기 등록 |
| `lib/envelope.mjs` | 봉투 규격 참조 구현. **PWA에 그대로 이식됨** (Node 전용 API 없음) |
| `lib/jpeg.mjs` | JPEG 구조 검사 + 메타데이터 제거 (디코딩 없이 바이트 수준) |
| `test-client.mjs` | 폰 시뮬레이터. 검사 34종 |
| `check-network.mjs` | 설치 전 네트워크 진단 |

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

`--watch` 는 `fs.watch` 로 도착 즉시 처리하고, 5초 안전주기를 함께 돕니다.
리눅스에서는 inotify라 지연이 거의 없습니다.

동작 확인 (폰 시뮬레이터 — 수신 서버를 켜둔 채로):

```bash
node test-client.mjs --url http://localhost:8443
```

---

## 검증된 항목

`test-client.mjs` **34/34 통과** (2026-08-17 실측, v3).
검사는 두 층으로 나뉩니다. 수신 서버는 복호화를 못 하므로 내용 위반은 수집기가 판정합니다.

**1층 · 전송 (수신 서버)**

| 검사 | 결과 |
|---|---|
| 정상 메모 / 사진 2장 | 통과 |
| 같은 `submission_id` 재전송 | 중복 무시 (멱등) |
| `submission_id` 위조 | 서명 거부 |
| 암호문 1비트 변조 | 서명 거부 |
| 30분 지난 요청 | 거부 (재전송 공격 방어) |
| 미등록 기기 | 거부 |
| 알 수 없는 schema / wire 손상 | 거부 |
| 분당 30건 초과 | 429 차단 |

**2층 · 내용 (수집기)**

| 검사 | 판정 |
|---|---|
| 메모·사진 모두 빈 제출 | `INVALID_SUBMISSION` |
| 사진 6장 | `RESOURCE_LIMIT_EXCEEDED` |
| JPEG 아닌 바이트 | `INVALID_MEDIA` |
| 선언 해시와 실제 불일치 | `CONTENT_DIGEST_MISMATCH` |
| 5000×4000 (한도 초과) | `RESOURCE_LIMIT_EXCEEDED` — **축소하지 않고 거부** |

**산출물·기밀성**

- 저장 파일명이 서버 생성 `record_id` 기반 (기기가 만든 값이 경로에 안 들어감)
- EXIF 실제 제거 확인 — `wire_bytes 307200 → bytes 307164`, 픽셀은 무손실
- 메모 줄바꿈·이모지 원문 보존
- **암호문 보관소를 평문 검색하면 0건**, 복호화 산출물에서는 검색됨
  → 수신 서버 단계에서 실제로 읽을 수 없는 상태임이 확인됨
- 상태 조회: 검증 완료 조회 / 서명 없이 거부 / 없는 건 404 / 거부 사유까지 조회

**성능 (실측)**

| 항목 | v2 | v3 |
|---|---|---|
| 사진 2장 600KB 전송량 | 801KB (+33%) | **601KB (+0.2%)** |
| 암호화 소요 | 5ms | 2ms |

base64를 걷어내고 바이너리 본문으로 보내면서 33% 오버헤드가 사라졌습니다.
현장 회선에서 체감되는 차이입니다.

---

## 운영 배포 (HTTPS)

Caddy를 앞에 두면 Let's Encrypt 인증서를 자동으로 발급·갱신합니다.
무료 DDNS 주소를 그대로 쓸 수 있습니다. 상세는 [SETUP.md](../docs/SETUP.md).

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

공유기에서 **80·443만** 미니PC로 포워딩합니다. 80은 인증서 발급용입니다.

---

## 아직 안 한 것

- **2단계 문서 보정** — Python + OpenCV. `scan_status` 가 `pending` 으로 남습니다
- **EXIF 방향의 픽셀 적용** — 메타데이터는 1단계에서 제거되지만 방향 적용은
  디코딩이 필요해 2단계 몫입니다. `orientation_pending` 에 값을 남겨둡니다
- ERP DB 투입 — 현재는 `inbox/ready/` 에 파일만 떨굽니다
- `_processed` / `_error` 보존기간 자동 삭제
- 수신 실패 알림(메일/텔레그램)
- 멱등성 캐시가 메모리 + 파일 존재 확인 — 대용량에서는 인덱스 필요 (현 규모에선 불필요)
