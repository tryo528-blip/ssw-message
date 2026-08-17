# ERP 연동 규격 (CONTRACT) v2

> 앱 ↔ 수신 서버 ↔ 수집기 ↔ ERP 가 공유하는 **유일한 진실**.
> 앱과 ERP는 서로를 모릅니다. 이 문서의 폴더 구조와 스키마만 압니다.
> 스키마 변경 시 `schema` 버전을 올리고, 수집기는 구버전도 당분간 함께 처리합니다.

| | |
|---|---|
| 개정 | v2 — E2E 암호화 도입에 따른 봉투 구조 변경 |
| 참조 구현 | [server/lib/envelope.mjs](../server/lib/envelope.mjs) |
| **ERP 투입 로직** | **변경 없음.** 수집기가 복호화하면 v1과 동일한 평문이 나옵니다 |

---

## 1. 두 겹의 봉투

암호화 도입으로 봉투가 두 겹이 됐습니다. 헷갈리기 쉬우니 먼저 정리합니다.

```
┌─ 바깥 봉투 (ssw-msg/2) ── 네트워크로 전송되는 것 ──────────┐
│  id, created_at, device_id, key_id   ← 평문 (라우팅·멱등·정렬용)│
│  sig                                 ← 위조 방지 서명          │
│  enc { alg, epk, iv, ct }                                      │
│        └─ ct 안에 ↓                                            │
│     ┌─ 속 봉투 (ssw-msg/1) ── 암호화됨 ──────────────┐         │
│     │  user, site, type, memo, files[]  + 이미지 바이트│         │
│     └────────────────────────────────────────────────┘         │
└────────────────────────────────────────────────────────────────┘
```

**평문으로 남는 건 개인 식별 정보가 아닙니다.** 전송 id, 시각, 기기 id, 키 id뿐입니다.
사용자명·현장·메모 본문·사진은 전부 암호문 안에 있습니다.

---

## 2. 바깥 봉투 (전송 규격)

```jsonc
{
  "schema": "ssw-msg/2",
  "id": "01M07PX1K1E1JSW2R23F8D68EH",   // ULID. 멱등성 키 (ERP 유니크 인덱스)
  "created_at": "2026-08-17T09:12:33+09:00",  // 기기 로컬 시각. 5분 윈도우 검사 대상
  "device_id": "dev_a1b2c3d4",          // 서명 검증할 기기 식별
  "key_id": "office-2026-08",           // 어느 사무실 키로 암호화했는지 (키 교체 대비)
  "enc": {
    "alg": "ECDH-P256+HKDF-SHA256+AES-256-GCM",
    "epk": "BE3lrCuP…",                 // 임시 공개키 (raw 65B, base64)
    "iv":  "9f2c…",                     // 12바이트
    "ct":  "…"                          // 암호문 (속 봉투 + 이미지 전체)
  },
  "sig": "…",                           // HMAC-SHA256, 아래 규칙
  "received_at": "2026-08-17T09:12:35+09:00"  // 서버가 수신 시 기록
}
```

### 암호화 규칙

```
공유비밀 = ECDH(임시개인키, 사무실공개키)                    // P-256, 256비트
AES키    = HKDF-SHA256(공유비밀, salt=0x00×32, info="ssw-msg/2")
암호문   = AES-256-GCM(AES키, iv, 평문, AAD = id)
```

AAD에 `id`를 넣어 봉투와 암호문을 결속합니다. id만 바꿔치기하면 복호화가 실패합니다.

### 평문 레이아웃 (암호화 대상)

```
[4바이트 BE: JSON 길이][JSON(UTF-8)][파일1 바이트][파일2 바이트]…
```

파일 경계는 JSON의 `files[].bytes` 순서로 복원합니다. base64 이중 인코딩을 피합니다.

### 서명 규칙

```
sig = HMAC-SHA256(기기비밀값, "id.created_at.device_id.key_id.sha256hex(ct)")
```

암호화와 별개입니다. 암호화는 기밀성만 주고, 위조 방지는 이 서명이 담당합니다.

---

## 3. 속 봉투 (복호화 결과 = ERP가 보는 것)

**v1에서 바뀌지 않았습니다.** ERP 투입 로직을 고칠 필요가 없습니다.

```jsonc
{
  "schema": "ssw-msg/1",
  "id": "01M07PX1K1E1JSW2R23F8D68EH",
  "type": "memo",                      // "memo" | "photo"
  "created_at": "2026-08-17T09:12:33+09:00",
  "received_at": "2026-08-17T09:12:35+09:00",   // 수집기가 채움
  "device_id": "dev_a1b2c3d4",
  "user": "김현장",
  "site": "SITE-021",                  // 없으면 null
  "app_ver": "0.1.0",
  "memo": {
    "category": "TODO",                // 아래 코드표. 미선택 시 "ETC"
    "priority": "NORMAL",              // "URGENT" | "NORMAL"
    "body": "3층 화장실 배관 누수 재확인 필요.\n자재 미리 준비할 것.",
    "body_len": 34
  },
  "files": []                          // memo 는 빈 배열
}
```

사진이면 `type: "photo"` 이고 `files[]` 가 채워집니다.

```jsonc
"files": [
  {
    "name": "01M07PX1N5DZXKDF6M3FSB1S5D_1.jpg",
    "bytes": 307200,
    "sha256": "9f2c…",                 // 수집기가 복호화 후 재검증
    "width": 1600, "height": 1200,
    "mime": "image/jpeg",
    "exif_stripped": true              // 항상 true (canvas 재인코딩)
  }
]
```

- `body`는 **가공하지 않습니다.** 줄바꿈·이모지 포함 원문 그대로 (자유 메모가 목적)
- 최대 2,000자. 초과 시 앱에서 전송 차단

### 분류 코드표 (ERP 코드와 맞춰 확정 필요)

| 코드 | 화면 표기 |
|---|---|
| `TODO` | 할일 |
| `AS` | AS |
| `QUOTE` | 견적 |
| `PURCHASE` | 구매 |
| `ETC` | 기타 |

---

## 4. 업로드 API

```
POST https://{사무실주소}/api/upload
Content-Type: text/plain;charset=utf-8    ← 현재. 동일 출처 확정 시 바이너리로 교체 예정
본문: 바깥 봉투 JSON
```

응답:

```jsonc
{ "ok": true,  "id": "01M07…", "received_at": "…" }
{ "ok": true,  "id": "01M07…", "duplicate": true }        // 재전송 — 정상 처리
{ "ok": false, "code": "UNAUTHORIZED" | "BAD_SIGNATURE" | "STALE"
             | "RATE_LIMITED" | "TOO_LARGE" | "BAD_SCHEMA" | "BAD_JSON" }
```

| 규칙 | 값 |
|---|---|
| 본문 상한 | 12MB → 초과 시 `413 TOO_LARGE` |
| 시각 허용 오차 | ±5분 → 벗어나면 `401 STALE` |
| 레이트리밋 | 기기별 분당 30건 / 일 500건 → `429` |
| 멱등성 | 같은 `id` 재전송은 덮어쓰지 않고 `ok:true, duplicate:true` |

> **base64 오버헤드 33%** — 600KB 사진이 801KB로 전송됩니다. PWA를 수신 서버에서
> 직접 서빙하면 동일 출처가 되어 CORS 우회용 `text/plain` 이 불필요해지므로,
> 암호문을 바이너리 본문으로 POST해 회수할 수 있습니다. P2에서 반영.

---

## 5. 사무실 폴더 구조

```
server/inbox/
├─ enc/                          ← 수신 서버가 암호문 그대로 저장
│  └─ 2026-08-17/
│     └─ 01M07PX1K1E1JSW2R23F8D68EH.json
├─ ready/                        ← 수집기가 복호화한 평문. ERP가 읽는 곳 ★
│  ├─ memo/2026-08-17/
│  │  └─ 01M07PX1K1E1JSW2R23F8D68EH.json
│  └─ photo/2026-08-17/
│     ├─ 01M07PX1N5DZXKDF6M3FSB1S5D.json      ← 완결 신호
│     ├─ 01M07PX1N5DZXKDF6M3FSB1S5D_1.jpg
│     └─ 01M07PX1N5DZXKDF6M3FSB1S5D_2.jpg
├─ _processed/2026-08-17/        ← 복호화 완료된 암호문 (보존 후 삭제)
└─ _error/2026-08-17/            ← 실패분 (사람이 확인)
```

날짜 폴더는 **KST 기준**. 파일명은 `{ULID}[_{n}].{ext}`.
ULID는 앱이 생성하며 시간순 정렬·충돌 방지·멱등성 키를 겸합니다.

### 쓰기 순서 (중요)

- 수신 서버: `.json.part` 로 쓴 뒤 `rename` → **원자적 완결 신호**
- 수집기: **이미지 먼저, JSON 나중**. JSON의 존재가 곧 "이 건은 완결됨"

---

## 6. 수집기 규격

```
1) inbox/enc/*/*.json 감시 (.part 는 무시)
2) key_id 가 보유 키와 일치하는지 확인
3) 복호화 → 속 봉투 + 파일 바이트 복원
4) files[].bytes 와 실제 길이 일치 확인, sha256 재검증
5) inbox/ready/{memo|photo}/{날짜}/ 에 기록 (이미지 → JSON 순)
6) 원본 암호문을 _processed/{날짜}/ 로 이동
7) 어느 단계든 실패하면 _error/{날짜}/ 로 이동 + 로그
8) ERP insert 는 id 유니크 인덱스 → 중복이면 조용히 skip
```

보존 정책:

- `_processed/` — 30일 후 삭제. **개인정보 사진은 7일 권장**
- `_error/` — 원인 확인 후 수동 처리
- 삭제 이력은 로그에 남김 (감사 대응)

---

## 7. 인수 조건 (검사 결과)

`server/test-client.mjs` — **9/9 통과** (2026-08-17 실측)

| # | 상황 | 기대 | 결과 |
|---|---|---|---|
| T1 | 정상 메모 1건 | 수신 → 복호화 → ready 생성 | ✅ |
| T2 | 사진 2장 600KB | 원본과 바이트 동일, sha256 일치 | ✅ |
| T3 | 같은 id 2회 전송 | 1건만 생성, `duplicate:true` | ✅ |
| T4 | id 위조 | 서명 거부 401 | ✅ |
| T5 | 암호문 1바이트 변조 | 서명 거부 401 | ✅ |
| T6 | 30분 지난 요청 | `STALE` 401 | ✅ |
| T7 | 미등록 기기 | `UNAUTHORIZED` 401 | ✅ |
| T8 | 알 수 없는 schema | `BAD_SCHEMA` 400 (버림 금지, 보존) | ✅ |
| T9 | 분당 30건 초과 | 429 | ✅ |
| T10 | body 줄바꿈·이모지 | 원문 그대로 보존 | ✅ |
| T11 | 암호문 보관소 평문 검색 | 0건 (읽을 수 없음) | ✅ |

미검증 — 실기 필요:

| # | 상황 | 기대 |
|---|---|---|
| T12 | 오프라인 3건 대기 후 복귀 | 3건 모두 도착, 순서 무관, 중복 없음 |
| T13 | 사무실 PC 다운 중 전송 시도 | 암호화 대기열 보관 → 복구 후 자동 전송 |
| T14 | 키 교체 후 구 키 암호문 | 구 키로 복호화 성공 (키 보존 규칙) |
