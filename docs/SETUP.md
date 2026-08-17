# 사무실 설치 가이드

사무실 PC를 "폰이 사진을 직접 보낼 수 있는 곳"으로 만드는 절차입니다.
네트워크를 잘 몰라도 순서대로 따라오면 됩니다. 한 번만 하면 끝입니다.

**전체 그림**

```
폰 ──인터넷──▶ 공유기 ──▶ 사무실 PC
                (443 포워딩)   ├─ Caddy      : HTTPS 담당 (인증서 자동)
                               ├─ receiver   : 암호문 받아서 저장
                               └─ collector  : 복호화 → ERP 투입
```

준비물: 사무실 PC 1대(상시 가동), 공유기 관리자 비밀번호. 비용은 들지 않습니다.

---

## 0단계 · 환경 진단

**사무실 PC에서** 실행합니다. (개발 PC가 아니라 실제로 서버가 될 컴퓨터입니다)

```bash
node server/check-network.mjs
```

`[3] 밖에서 찾아올 수 있는 주소인가` 가 **"가능해 보입니다"** 로 나와야 계속 진행합니다.
"공유 주소(CGNAT)"가 나오면 통신사에 공인 IP를 요청하세요. 대개 무료로 바꿔줍니다.

`[1]` 에 나온 내부 주소(예: `192.168.0.20`)를 적어두세요. 3단계에서 씁니다.

---

## 1단계 · Node 설치

```bash
winget install OpenJS.NodeJS.LTS
```

설치 후 새 터미널을 열어 확인합니다.

```bash
node -v
```

---

## 2단계 · 인터넷 주소 이름 만들기 (DDNS)

집·사무실 인터넷은 주소가 수시로 바뀝니다. 바뀌어도 항상 찾아올 수 있게 **이름**을 붙입니다.

### 방법 A — 공유기에 내장된 기능 (가장 간단, 권장)

ipTIME 공유기라면 이미 들어 있습니다.

1. 공유기 관리페이지 접속 (보통 `192.168.0.1` 또는 `172.30.1.254`)
2. **고급설정 → 특수기능 → DDNS 설정**
3. 원하는 이름 입력 → `우리회사메시지.iptime.org` 같은 주소가 생깁니다
4. 등록 상태가 "정상 등록"으로 바뀌는지 확인

주소가 바뀌어도 공유기가 알아서 갱신합니다. 별도 프로그램이 필요 없습니다.

### 방법 B — 공유기에 DDNS 기능이 없을 때

[duckdns.org](https://www.duckdns.org) 에서 무료 주소를 만들고,
안내에 나오는 갱신 주소를 Windows 작업 스케줄러에 5분 주기로 등록합니다.

---

## 3단계 · 공유기 설정

### 3-1. 사무실 PC 주소 고정

포워딩 목적지가 바뀌면 연결이 끊깁니다. 공유기에서 고정해 둡니다.

**고급설정 → 네트워크 관리 → 내부 네트워크 설정** 에서 사무실 PC를 찾아
0단계에서 적어둔 주소로 **수동 할당(고정 IP)** 합니다.

### 3-2. 포트 포워딩

**고급설정 → NAT/라우터 관리 → 포트포워드 설정** 에서 두 개를 추가합니다.

| 규칙 이름 | 외부 포트 | 내부 IP | 내부 포트 | 프로토콜 |
|---|---|---|---|---|
| ssw-https | 443 | 사무실 PC 주소 | 443 | TCP |
| ssw-http | 80 | 사무실 PC 주소 | 80 | TCP |

80번은 인증서 자동 발급에 쓰입니다. **그 외 포트는 절대 열지 마세요.**

---

## 4단계 · Caddy 설치 (HTTPS 자동)

```bash
winget install CaddyServer.Caddy
```

`server/Caddyfile` 파일을 만들고 2단계에서 만든 주소를 넣습니다.

```
우리회사메시지.iptime.org {
    reverse_proxy localhost:8443
    header {
        Strict-Transport-Security "max-age=31536000"
        X-Content-Type-Options nosniff
        Referrer-Policy no-referrer
    }
}
```

실행하면 인증서를 **자동으로 발급받고 만료 전에 알아서 갱신**합니다.

```bash
caddy run --config server/Caddyfile
```

`certificate obtained successfully` 가 보이면 성공입니다.

> 실패한다면 대개 80/443 포워딩이 안 된 것입니다. 3단계를 다시 확인하세요.

---

## 5단계 · 키 만들기

```bash
node server/keygen.mjs office
```

**이 명령은 딱 한 번만 실행합니다.** 만들어진
`server/keys/office-private.jwk.json` 이 사무실의 유일한 열쇠입니다.

> ### 지금 바로 백업하세요
> - USB 2개에 복사하고, **최소 1개는 사무실 밖**에 보관합니다
> - 담당자 1명이 혼자 들고 있지 않게 합니다
> - 이 파일을 잃으면 **아직 수집 안 된 사진은 누구도 못 엽니다**. 복구 방법이 없습니다

직원 기기를 등록합니다. 사람마다 한 번씩입니다.

```bash
node server/keygen.mjs device 김현장
```

출력된 JSON을 **오프라인 QR 생성기**로 QR을 만들어 해당 직원 폰에서 스캔하게 합니다.
비밀값이 들어 있으므로 온라인 QR 사이트는 쓰지 마세요. 카톡·메일로 보내지도 마세요.

폰을 잃어버리면 `server/keys/devices.json` 에서 해당 기기의
`"revoked": false` 를 `true` 로 바꿉니다. 즉시 차단됩니다.

---

## 6단계 · 자동 시작 등록

PC가 재부팅돼도 알아서 뜨게 합니다. 관리자 PowerShell에서 실행합니다.

```powershell
$dir = "C:\marco\ssw-message"
$node = (Get-Command node).Source
$caddy = (Get-Command caddy).Source
$s = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1)
$t = New-ScheduledTaskTrigger -AtStartup
$p = New-ScheduledTaskPrincipal -UserId "SYSTEM" -RunLevel Highest
Register-ScheduledTask "SSW-Caddy"     -Action (New-ScheduledTaskAction -Execute $caddy -Argument "run --config $dir\server\Caddyfile" -WorkingDirectory $dir) -Trigger $t -Principal $p -Settings $s
Register-ScheduledTask "SSW-Receiver"  -Action (New-ScheduledTaskAction -Execute $node  -Argument "$dir\server\receiver.mjs --port 8443" -WorkingDirectory $dir) -Trigger $t -Principal $p -Settings $s
Register-ScheduledTask "SSW-Collector" -Action (New-ScheduledTaskAction -Execute $node  -Argument "$dir\server\collector.mjs --watch" -WorkingDirectory $dir) -Trigger $t -Principal $p -Settings $s
```

등록 확인:

```powershell
Get-ScheduledTask SSW-* | Select-Object TaskName, State
```

---

## 7단계 · 최종 확인

**반드시 휴대폰 데이터로** 확인합니다. 와이파이를 끄세요.
사무실 와이파이에 붙은 채로는 밖에서 되는지 알 수 없습니다.

1. 폰 브라우저에서 `https://우리회사메시지.iptime.org` 접속
2. 자물쇠 아이콘이 뜨고 경고가 없어야 합니다
3. **카메라 검증 페이지가 뜹니다** — 수신 서버가 이 페이지를 함께 서빙합니다

여기까지 오면 별도 준비 없이 **카메라 실기 검증**을 바로 진행할 수 있습니다.
[spike/camera/README.md](../spike/camera/README.md) 의 테스트 절차를 그대로 따르세요.
아이폰·갤럭시 각 1대에서 "촬영 후 갤러리에 안 남는다"를 확인해야 다음 단계로 갑니다.

되지 않으면 아래를 순서대로 확인하세요.

| 증상 | 확인할 것 |
|---|---|
| 아예 연결 안 됨 | 포트포워딩 규칙, 사무실 PC 주소가 바뀌지 않았는지 |
| 인증서 경고 | Caddy 로그. 80번 포워딩 누락이 가장 흔합니다 |
| 사무실에서만 됨 | 이중 NAT(공유기 2대). 둘 다 포워딩 필요 |
| 어제까지 되다 안 됨 | DDNS 등록 상태, 통신사 IP 변경 |

---

## 보안 체크리스트

설치 후 한 번 훑어보세요.

- [ ] 열어둔 포트가 80, 443 **둘뿐**인가
- [ ] 공유기 관리자 비밀번호를 기본값에서 바꿨는가
- [ ] 공유기 **원격 관리(외부 접속) 기능은 꺼져 있는가**
- [ ] 개인키 백업 2벌, 그중 1벌은 사무실 밖에 있는가
- [ ] `server/keys/` 폴더가 공유 폴더나 클라우드 동기화 대상이 아닌가
- [ ] 사무실 PC에 자동 업데이트가 켜져 있는가
- [ ] 디스크 암호화(BitLocker)를 켰는가

## 정기 점검

| 주기 | 할 일 |
|---|---|
| 매주 | `inbox/_error/` 에 쌓인 게 없는지 확인 |
| 매월 | 퇴사자·교체 단말 `revoked` 처리, 보존기간 지난 `_processed` 삭제 |
| 분기 | 폰에서 실제 전송 1건 테스트, 개인키 백업 상태 확인 |
