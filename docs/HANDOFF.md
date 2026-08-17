# 인수인계 문서 (HANDOFF)

> 작업이 중간에 끊겼을 때 **다른 사람이나 다른 AI가 이어받기 위한** 문서.
> 이 문서 하나만 읽고도 다음 한 걸음을 뗄 수 있어야 합니다.
> **작업을 진행하면 이 문서를 같이 갱신하세요.**

| | |
|---|---|
| 최종 갱신 | 2026-08-17 |
| 현재 단계 | **P2 완료** → 다음은 P0-c(갤럭시 검증) 또는 P3(PWA) |
| 저장소 | https://github.com/tryo528-blip/ssw-message (private) |

---

## 1. 이 프로젝트가 뭔가

현장 직원이 **서류 사진**과 **할일 메모**를 사무실로 보내는 PWA + 수신 서버.
SSWCENTER ERP가 결과 폴더를 읽어갑니다. ERP와 직접 연결하지 않습니다.

**절대 깨면 안 되는 제약 4가지**

1. 사진이 **휴대폰 갤러리에 남으면 안 된다** — 그래서 `getUserMedia`+canvas만 쓰고
   `<input capture>`는 금지 (OEM 카메라가 DCIM에 먼저 저장함)
2. **제3자 서버에 데이터가 남으면 안 된다** — 클라우드 경유 금지. 사무실 미니PC 직접 수신
3. **비용 0** — PWA(스토어 비용 회피) + 무료 DDNS + Let's Encrypt
4. **다시 찍어올 수 없는 사진이 있다** — 도착 확인 전에 폰에서 지우면 안 됨

읽을 순서: [DESIGN.md](../DESIGN.md) → [CONTRACT.md](CONTRACT.md) → [PIPELINE.md](PIPELINE.md)

---

## 2. 지금까지 확인된 사실 (재검증 불필요)

| 항목 | 결과 | 근거 |
|---|---|---|
| E2E 암호화 왕복 | 일치 | 실측 2026-08-17 |
| 변조 감지 (GCM) | 거부됨 | 1바이트 뒤집기 테스트 |
| id 위조 (AAD 바인딩) | 거부됨 | id만 교체 테스트 |
| 암호화 성능 | 300KB **1ms** | 실측 |
| 전송 오버헤드 | **+0.2%** (600KB → 601KB) | v3 바이너리 전송 |
| JPEG 메타데이터 제거 | 25/25 통과 | `test-jpeg.mjs` |
| getUserMedia + canvas 캡처 | 동작 | PC 크롬 |
| canvas 재인코딩 시 EXIF 제거 | `EXIF=false` | PC 크롬 |
| 서버 전 경로 검사 34종 | 34/34 통과 | `test-client.mjs` (v3) |
| 암호문에서 평문 검색 | 0건 | 수신 서버가 실제로 못 읽음을 확인 |

---

## 3. 🔴 아직 안 끝난 최대 리스크 — P0-c

**안드로이드 갤럭시 실기에서 "촬영해도 갤러리에 안 남는다"가 아직 미확인입니다.**

2026-08-17 시도했으나 **PC 크롬에서 돌아가서 무효**였습니다
(리포트의 User-Agent가 `Windows NT 10.0`). 데스크톱엔 갤러리가 없으니 당연히 안 남습니다.
갤럭시에서는 HTTP 접속이라 `getUserMedia 지원: 아니오` 로 카메라가 열리지 않았습니다.

### 닫는 방법 (5분, 인증서 불필요)

`getUserMedia`는 보안 컨텍스트에서만 되는데 **`localhost`는 예외**입니다.
크롬 포트 포워딩으로 폰이 PC 서버를 `localhost`로 보게 만듭니다.

1. 갤럭시: 개발자 옵션 → **무선 디버깅 켜기** (이미 켜져 있음)
2. PC에서 정적 서버 실행

   ```bash
   python -m http.server 8080 --directory spike/camera
   ```

3. PC 크롬 → `chrome://inspect/#devices` → **Port forwarding...**
   → `8080` → `localhost:8080` 추가, 체크박스 켜기
4. **갤럭시 크롬**에서 `http://localhost:8080` 접속
5. 방식 A(getUserMedia)로 촬영 → **갤럭시 갤러리 앱**을 직접 열어 확인
6. 리포트의 User-Agent에 `Android` 가 찍혔는지 반드시 확인할 것

**통과 기준**: 갤러리·DCIM·최근 항목 어디에도 안 나타남
**실패하면**: 설계 전제가 깨집니다. PWA로는 불가능하다는 뜻이므로 네이티브 재검토 필요

---

## 4. 완료된 작업: P2 · 서버 v3 동기화

**왜 하는가**: 규격은 [CONTRACT.md](CONTRACT.md) v3인데 서버 코드는 v2입니다.
PWA가 v3로 말할 텐데 서버가 못 알아듣습니다. PWA를 만들기 전에 맞춰야 합니다.

### v2 → v3 변경점

| 항목 | v2 | v3 |
|---|---|---|
| 식별자 | `id` 하나 | `submission_id`(기기 ULID) + `record_id`(서버 UUID) |
| 내용 해시 | 없음 | `content_digest` — wire 바이트 기준 |
| 전송 | base64 JSON (+33%) | 바이너리 본문 |
| 상태 조회 | 없음 | `POST /api/status` |
| 오류 코드 | 6종 | 10종 (미디어·용량·구성 추가) |
| 처리 | 단일 | 1단계 검증 / 2단계 보정 분리 |
| 저장 경로 | `id` | `record_id` |

### 단계별 진행 상황

- [x] **A** `docs/HANDOFF.md` — 이 문서
- [x] **B** `server/lib/envelope.mjs` — v3 봉투. Node 전용 API 제거해 PWA 이식 가능
- [x] **C** `server/lib/jpeg.mjs` — 신규. 자체 검사 25/25 통과
- [x] **D** `server/receiver.mjs` — 바이너리 수신, 상태 API, 오류 코드
- [x] **E** `server/collector.mjs` — 입력 검사 9종, record_id, 상태 파일, fs.watch
- [x] **F** `server/test-client.mjs` — 검사 34종
- [x] **G** 검사 실행 — **34/34 통과**

### P2 결과

- 전송량 **801KB → 601KB** (600KB 원본 기준, +33% → +0.2%)
- 암호화 5ms → 2ms
- EXIF 실제 제거 확인: 307200 → 307164B, 픽셀 무손실
- 암호문 보관소 평문 검색 0건 유지

**남긴 결정 하나**: Node에는 JPEG 디코더가 없습니다. 픽셀을 건드리는 작업(방향 적용,
재인코딩, 문서 보정)은 전부 2단계 Python으로 미뤘고, 1단계는 **디코딩 없이 메타데이터
세그먼트만 잘라냅니다**(`lib/jpeg.mjs`). GPS·썸네일은 즉시 사라지므로 프라이버시는
1단계에서 확보되고, 방향은 `orientation_pending` 에 남겨 2단계가 적용합니다.

---

## 5. 설계 결정 중 **되돌리면 안 되는 것**

이유를 모른 채 "더 단순하게" 바꾸면 문제가 생기는 것들입니다.

### 수신 서버는 개인키를 갖지 않는다

`receiver.mjs`에 복호화 코드를 넣지 마세요. 인터넷에 노출되는 프로세스라
털려도 지난 사진을 못 열게 하는 것이 목적입니다. 복호화는 `collector.mjs`만 합니다.
상태 조회 API도 collector가 써둔 파일을 **읽기만** 합니다.

### `submission_id`는 기기가 만든다

멱등성 키라서 그렇습니다. 서버가 만들면 재전송인지 새 건인지 구분할 수 없습니다.
저장 경로에만 서버가 만든 `record_id`를 씁니다. 둘은 다른 목적입니다.

### `content_digest`는 wire 바이트 기준

서버가 재인코딩하면 저장본 해시가 달라집니다. digest를 저장본 기준으로 잡으면
같은 제출을 재전송했을 때 다른 건으로 판정됩니다. **전송 당시 바이트로 고정**해야 합니다.

### 한도 초과는 축소가 아니라 거부

4096px / 12MP / 장당 5MiB를 넘으면 자동으로 줄이지 않고 거부합니다.
서버가 사용자 모르게 이미지를 바꾸지 않는다는 원칙입니다.

### 보정 실패는 에러가 아니다

문서 영역 자동 감지는 원래 실패합니다. **정규화본이 항상 남으므로 데이터 손실이 아닙니다.**
확신 없으면 보정을 시도하지 말고 건너뛰세요. 잘못된 원근 변환이 안 하는 것보다 나쁩니다.

### 폰은 "검증 완료" 확인 후에만 지운다

다시 찍어올 수 없는 사진이 있습니다. 수신 200은 "바이트가 도착했다"일 뿐이고,
복호화·해시 대조까지 끝난 뒤에 지워야 합니다. 보정 완료는 기다릴 필요 없습니다.

### iOS에서 안 되는 것 두 가지

- **Share Extension** — Web Share Target API는 안드로이드 크롬만 지원. iOS PWA는 공유 대상 등록 불가
- **TLS 지문 피닝** — 브라우저 JS는 인증서에 접근할 수 없음

선행 프로젝트 [WorkCadenceTransfer](https://github.com/tryo528-blip/WorkCadenceTransfer)에
이 둘이 있는 건 **네이티브 안드로이드 + 사내망 전용**이었기 때문입니다.
그쪽 pairing QR 스키마에 `x-privateIpv4HttpsOrigin: true`가 박혀 있습니다.
현장에서 전송하려면 그 전제를 버려야 했고, 그래서 이 프로젝트가 생겼습니다.

---

## 6. 개발 환경

- **Node 24** — 서버. 외부 패키지 **0개** (`npm install` 불필요)
- **Python 3 + OpenCV** — 문서 보정 (2단계). 아직 미구현
- **OS** — 개발은 Windows, 배포는 Ubuntu Server 미니PC (아직 미구매)
- 셸은 **Windows PowerShell 5.1** — `&&` 안 됨. 명령을 한 줄씩 주세요

### 로컬에서 돌려보기

```bash
node server/keygen.mjs office
```

```bash
node server/keygen.mjs device 테스트
```

```bash
node server/receiver.mjs --port 8443
```

```bash
node server/test-client.mjs --url http://localhost:8443
```

```bash
node server/collector.mjs
```

`server/keys/`, `server/inbox/` 는 `.gitignore` 로 커밋이 막혀 있습니다. **절대 커밋하지 마세요.**

---

## 7. 다음에 할 일

| 단계 | 내용 | 선행 조건 |
|---|---|---|
| P0-c | 갤럭시 갤러리 검증 | 없음 — **언제든 가능, 최우선** |
| P1 | 미니PC 구매 + Ubuntu 설치 | 하드웨어 |
| P3 | PWA 본체 | P2 완료 |
| P4 | 문서 보정 (Python+OpenCV) | P1 (미니PC) |
| P5 | 대기함 UI, QR 등록 | P3 |
| P6 | ERP 연결 + 운영 도구 | ERP 스펙 확정 |

---

## 8. 아직 사람이 결정해야 하는 것

1. 메모 분류 코드 — ERP 기존 코드와 맞춰야 함 (현재 TODO/AS/QUOTE/PURCHASE/ETC 가안)
2. ERP가 폴더를 직접 읽을지, 담당자가 볼지
3. 사진 보존기간 — 서류 중심이라 법정 보존 요건 확인 필요
4. 사용 인원 / 하루 건수 — 레이트리밋 상한 재조정
5. 개인키 백업 담당자와 보관 장소
