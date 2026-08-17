# ERP 연동 규격 (CONTRACT) v3

> 앱 ↔ 수신 서버 ↔ 수집기 ↔ ERP 가 공유하는 **유일한 진실**.
> 앱과 ERP는 서로를 모릅니다. 이 문서의 폴더 구조와 스키마만 압니다.

| | |
|---|---|
| 개정 | v3 — 식별자 분리, 오류 코드, 상태 조회, 검증/보정 2단계 |
| 참조 구현 | [server/lib/envelope.mjs](../server/lib/envelope.mjs) |
| 처리 상세 | [PIPELINE.md](PIPELINE.md) |
| 선행 프로젝트 | WorkCadenceTransfer 의 정규화 정책·오류 코드를 흡수 |

**v2에서 바뀐 것**

- `id` → `submission_id`(기기 생성) + `record_id`(서버 생성)로 **분리**
- `content_digest` 도입 — 재인코딩과 멱등성을 분리
- 오류 코드 체계 도입
- 상태 조회 API 추가 (전달 확인 후 삭제)
- 산출물이 정규화본 + 보정본 2종

---

## 1. 두 겹의 봉투

```
┌─ 바깥 봉투 (ssw-msg/3) ── 네트워크로 전송되는 것 ──────────────┐
│  submission_id, created_at, device_id, key_id, content_digest   │
│                                        ← 평문 (라우팅·멱등·정렬)│
│  sig                                   ← 위조 방지 서명         │
│  enc { alg, epk, iv, ct }                                       │
│        └─ ct 안에 ↓                                             │
│     ┌─ 속 봉투 (ssw-msg/1) ── 암호화됨 ──────────────┐          │
│     │  user, site, type, memo, files[] + 이미지 바이트│          │
│     └─────────────────────────────────────────────────┘         │
└─────────────────────────────────────────────────────────────────┘
```

**평문으로 남는 건 개인 식별 정보가 아닙니다.** 제출 id, 시각, 기기 id, 키 id, 내용 해시뿐입니다.
사용자명·현장·메모 본문·사진은 전부 암호문 안에 있습니다.

## 1.1 식별자 세 가지

혼동하기 쉬우므로 먼저 구분합니다.

| 이름 | 만드는 곳 | 형식 | 쓰임 |
|---|---|---|---|
| `submission_id` | **기기** | ULID | 멱등성 키. 재전송 판별. 상태 조회 |
| `content_digest` | **기기** | SHA-256 hex | 내용 동일성. 재인코딩해도 불변 |
| `record_id` | **서버** | UUIDv4 | **저장 경로와 파일명** |

**저장 경로에는 `record_id` 만 씁니다.** 기기가 만든 값, 원본 파일명, 기기 모델명을
경로에 쓰지 않습니다. 멱등성은 `submission_id` 가 담당하므로 둘을 나눠도 문제가 없습니다.

`content_digest` 는 **전송된(wire) 바이트** 기준입니다. 서버가 재인코딩한 저장본의 해시는
digest 계산에 들어가지 않습니다. 따라서 같은 제출을 다시 보내면 저장본이 달라져도
같은 판정을 받습니다.

---

## 2. 바깥 봉투 (전송 규격)

```jsonc
{
  "schema": "ssw-msg/3",
  "submission_id": "01M07PX1K1E1JSW2R23F8D68EH",   // ULID. 기기 생성
  "content_digest": "9f2c…",                        // SHA-256 hex 64자
  "created_at": "2026-08-17T09:12:33+09:00",        // ±5분 윈도우 검사 대상
  "device_id": "dev_a1b2c3d4",
  "key_id": "office-2026-08",
  "enc": {
    "alg": "ECDH-P256+HKDF-SHA256+AES-256-GCM",
    "epk": "BE3lrCuP…",                             // 임시 공개키 (raw 65B, base64)
    "iv":  "9f2c…",                                 // 12바이트
    "ct":  "…"                                      // 암호문
  },
  "sig": "…",
  "received_at": "2026-08-17T09:12:35+09:00"        // 서버가 기록
}
```

### 암호화 규칙

```
공유비밀 = ECDH(임시개인키, 사무실공개키)                    // P-256, 256비트
AES키    = HKDF-SHA256(공유비밀, salt=0x00×32, info="ssw-msg/3")
암호문   = AES-256-GCM(AES키, iv, 평문, AAD = submission_id)
```

AAD에 `submission_id` 를 넣어 봉투와 암호문을 결속합니다. id만 바꿔치기하면 복호화가 실패합니다.

### 평문 레이아웃 (암호화 대상)

```
[4바이트 BE: JSON 길이][JSON(UTF-8)][파일1 바이트][파일2 바이트]…
```

파일 경계는 JSON의 `files[].bytes` 순서로 복원합니다.

### content_digest 계산

```
content_digest = SHA-256( submission_id ‖ "\n" ‖
                          각 파일의 "photo_id:mime:bytes:sha256" 을 순서대로 "\n" 결합 )
```

wire 메타데이터만 들어갑니다. 저장본 정보는 들어가지 않습니다.

### 서명 규칙

```
sig = HMAC-SHA256(기기비밀값,
      "submission_id.content_digest.created_at.device_id.key_id.sha256hex(ct)")
```

암호화는 기밀성만 주고, 위조 방지는 이 서명이 담당합니다.

### 허용 조합

| 구성 | 허용 |
|---|---|
| 메모만 | O |
| 사진 1~5장만 | O |
| 메모 + 사진 1~5장 | O |
| 둘 다 비어 있음 | **거부** (`INVALID_SUBMISSION`) |
| 사진 6장 이상 | **거부** (`RESOURCE_LIMIT_EXCEEDED`) |

---

## 3. 속 봉투 (복호화 결과 = ERP가 보는 것)

```jsonc
{
  "schema": "ssw-msg/1",
  "submission_id": "01M07PX1K1E1JSW2R23F8D68EH",
  "record_id": "7f3a91c2-4d5e-4a1b-9c3d-2e8f0a6b4c17",  // 서버가 채움
  "type": "photo",                     // "memo" | "photo"
  "created_at": "2026-08-17T09:12:33+09:00",
  "received_at": "2026-08-17T09:12:35+09:00",
  "verified_at": "2026-08-17T09:12:36+09:00",           // 1단계 완료 시각
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
  "files": [ /* 아래 */ ]
}
```

### files[] — 정규화본 + 보정본

```jsonc
{
  "photo_id": 1,                       // 제출 내 순번
  "name": "7f3a91c2-…_1.jpg",          // 정규화본. 항상 존재
  "bytes": 284531,                     // 저장본 크기
  "sha256": "…",                       // 저장본 해시
  "width": 2200, "height": 1650,
  "orientation_applied": 6,            // 픽셀에 적용한 EXIF Orientation
  "mime": "image/jpeg",
  "wire_bytes": 307200,                // 전송 당시 크기 (digest 계산에 쓰인 값)
  "wire_sha256": "…",                  // 전송 당시 해시
  "scan": "7f3a91c2-…_1_scan.jpg",     // 보정본. 실패 시 null
  "scan_status": "ok",                 // "ok" | "skipped" | "failed"
  "scan_reason": null,                 // 건너뜀·실패 사유
  "scan_ms": 2140
}
```

**ERP는 `scan` 이 있으면 그걸 쓰고, 없으면 정규화본(`name`)을 씁니다.**
보정 실패는 데이터 손실이 아닙니다.

- `body`는 **가공하지 않습니다.** 줄바꿈·이모지 포함 원문 그대로
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

## 4. API

### 4.1 업로드

```
POST https://{사무실주소}/api/upload
Content-Type: application/octet-stream     ← 바이너리. base64 33% 오버헤드 제거
```

동일 출처에서 서빙하므로 CORS 사전요청이 없습니다. 봉투는 다음 형식으로 담습니다.

```
[4바이트 BE: 헤더 길이][헤더 JSON(UTF-8)][암호문 바이트]
```

헤더 JSON은 2장의 바깥 봉투에서 `enc.ct` 를 뺀 것입니다.

응답:

```jsonc
{ "ok": true, "submission_id": "01M07…", "received_at": "…" }
{ "ok": true, "submission_id": "01M07…", "duplicate": true }   // 재전송 — 정상
{ "ok": false, "code": "…", "message": "…" }
```

### 4.2 상태 조회 (전달 확인)

```
POST https://{사무실주소}/api/status
본문: { submission_id, device_id, sig }
```

자기 기기가 보낸 것만 조회할 수 있습니다.

| 응답 | 의미 | 폰의 행동 |
|---|---|---|
| `{ verified: true, record_id, verified_at }` | 1단계 완료 | **로컬 삭제** |
| `{ verified: false }` | 처리 중 | 계속 폴링 |
| `{ verified: false, error: "…" }` | 1단계 실패 | 보유 유지 + 재전송 안내 |
| `404` | 도착 기록 없음 | 재전송 |

폴링: 1초 간격, 최대 15초. 그 안에 확인되지 않으면 대기함에 남기고 앱 재실행 시 재확인합니다.

**Receiver는 개인키 없이 이 API를 제공합니다.** Collector가 써둔 상태 파일을 읽어 돌려줄 뿐입니다.

### 4.3 오류 코드

| 코드 | HTTP | 의미 |
|---|---|---|
| `UNAUTHORIZED` | 401 | 미등록 기기 또는 폐기된 기기 |
| `BAD_SIGNATURE` | 401 | 서명 불일치 (위조·변조) |
| `STALE` | 401 | 시각이 ±5분을 벗어남 (재전송 공격 방어) |
| `RATE_LIMITED` | 429 | 분당 30건 / 일 500건 초과 |
| `TOO_LARGE` | 413 | 요청 본문 상한 초과 |
| `BAD_SCHEMA` | 400 | 필수 필드 누락 또는 알 수 없는 schema |
| `INVALID_SUBMISSION` | 400 | 허용되지 않는 구성 (메모·사진 모두 비었음 등) |
| `INVALID_MEDIA` | 400 | JPEG가 아니거나 헤더 손상, Orientation 값 이상 |
| `CONTENT_DIGEST_MISMATCH` | 400 | 선언한 크기·해시와 실제가 다름 |
| `RESOURCE_LIMIT_EXCEEDED` | 400 | 용량·해상도·장수 한도 초과 |

앞의 6개는 Receiver가, 뒤의 4개는 Collector가 판정해 상태 파일에 기록합니다.

---

## 5. 사무실 폴더 구조

```
/data/ssw/
├── keys/
│   ├── office-private.jwk.json     # 권한 600. 백업 필수
│   └── devices.json                # 권한 600
├── inbox/
│   ├── enc/2026-08-17/             # 암호문 (Receiver가 씀)
│   │   └── 01M07PX1K1E1JSW2R23F8D68EH.bin
│   ├── status/                     # 상태 (Collector가 씀, Receiver가 읽음)
│   │   └── 01M07PX1K1E1JSW2R23F8D68EH.json
│   ├── ready/                      # 최종 결과물. ERP가 읽는 곳 ★
│   │   ├── photo/2026-08-17/
│   │   │   ├── 7f3a91c2-….json
│   │   │   ├── 7f3a91c2-…_1.jpg        # 정규화본
│   │   │   └── 7f3a91c2-…_1_scan.jpg   # 보정본
│   │   └── memo/2026-08-17/
│   ├── _processed/2026-08-17/      # 복호화 완료된 암호문
│   └── _error/2026-08-17/          # 실패 건
└── logs/
```

- `enc/`, `status/` 는 `submission_id` 로, `ready/` 는 `record_id` 로 이름을 붙입니다
- 날짜 폴더는 **KST 기준**
- **ready/ 는 평문입니다.** 디스크 전체 암호화(LUKS)로 보호합니다
- 로그에 메모 본문·사용자명·파일명을 남기지 않습니다

### 쓰기 순서

- Receiver: `.bin.part` 로 쓴 뒤 `rename` → 원자적 완결 신호
- Collector: 이미지 먼저, JSON 나중. **JSON의 존재가 곧 "이 세트는 완결됨"**

---

## 6. 수집기 규격

```
[1단계 · 검증]  inotify 즉시 감지
 1) key_id 확인 → 복호화
 2) 입력 검사 (PIPELINE.md 2.1)
 3) 정규화 (PIPELINE.md 2.2)
 4) record_id(UUIDv4) 생성
 5) ready/ 에 정규화본 + JSON 기록
 6) status/<submission_id>.json 기록  ← 폰이 여기서 확인
 7) 암호문을 _processed/ 로 이동

[2단계 · 보정]  1단계와 분리, 큐로 처리
 8) 정규화본을 읽어 문서 보정
 9) 성공 시 _scan.jpg 추가 + JSON 갱신
10) 실패해도 정규화본 유지. scan_status 에 기록 후 종료
```

실패 시 `_error/` 로 이동하고 사유를 로그에 남깁니다.
ERP insert 는 `submission_id` 유니크 인덱스로 중복을 막습니다.

보존 정책: `_processed/` 는 30일, **개인정보 사진은 7일 권장**.
`status/` 는 30일 후 삭제.

---

## 7. 인수 조건

### 통과 완료 (v2 기준, 2026-08-17 실측)

| # | 상황 | 결과 |
|---|---|---|
| T1 | 정상 메모 1건 | ✅ |
| T2 | 사진 2장 600KB — 원본과 바이트 동일, sha256 일치 | ✅ |
| T3 | 같은 id 2회 전송 → 1건만 생성 | ✅ |
| T4 | id 위조 → 서명 거부 | ✅ |
| T5 | 암호문 1바이트 변조 → 서명 거부 | ✅ |
| T6 | 30분 지난 요청 → 거부 | ✅ |
| T7 | 미등록 기기 → 거부 | ✅ |
| T8 | 알 수 없는 schema → 거부 | ✅ |
| T9 | 분당 30건 초과 → 429 | ✅ |
| T10 | body 줄바꿈·이모지 원문 보존 | ✅ |
| T11 | 암호문 보관소 평문 검색 0건 | ✅ |

### v3에서 추가로 통과해야 할 것

| # | 상황 | 기대 |
|---|---|---|
| T12 | 메모·사진 모두 빈 제출 | `INVALID_SUBMISSION` |
| T13 | 사진 6장 | `RESOURCE_LIMIT_EXCEEDED` |
| T14 | JPEG가 아닌 바이트 | `INVALID_MEDIA` |
| T15 | 선언 해시와 실제 불일치 | `CONTENT_DIGEST_MISMATCH` |
| T16 | 4096px 초과 | `RESOURCE_LIMIT_EXCEEDED` (축소하지 않음) |
| T17 | 상태 조회 — 검증 완료 후 `verified:true` | 15초 내 응답 |
| T18 | 남의 submission_id 조회 | 거부 |
| T19 | 보정 실패 | 정규화본 유지, `scan_status: failed`, 데이터 손실 없음 |
| T20 | 재전송 시 저장본이 달라도 같은 digest | 중복 판정 유지 |

### 실기 필요

| # | 상황 | 기대 |
|---|---|---|
| T21 | 오프라인 3건 대기 후 복귀 | 3건 모두 도착, 중복 없음 |
| T22 | 미니PC 다운 중 전송 시도 | 암호화 대기열 보관 → 복구 후 재전송 |
| T23 | 키 교체 후 구 키 암호문 | 구 키로 복호화 성공 |
