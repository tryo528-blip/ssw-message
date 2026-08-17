# 미니PC 설치 가이드 (Ubuntu Server)

폰이 사진을 직접 보낼 수 있는 사무실 서버를 만드는 절차입니다.
한 번만 하면 끝입니다.

**전체 그림**

```
폰 ──인터넷──▶ 공유기 ──▶ 미니PC (LUKS 암호화 디스크)
                (80·443)    ├─ Caddy      HTTPS 담당 (인증서 자동)
                            ├─ receiver   암호문 저장      [ssw-recv] 키 접근 불가
                            ├─ collector  복호화·정규화    [ssw-coll] 키 보유
                            └─ enhancer   문서 보정        [ssw-coll]
```

**준비물**

| 항목 | 권장 |
|---|---|
| 미니PC | N100급 저전력 CPU, RAM **8GB**, SSD 256GB 이상 (15~25만원) |
| OS | Ubuntu Server 24.04 LTS |
| 네트워크 | 공유기 관리자 비밀번호 |

RAM은 4GB가 아니라 8GB를 권합니다. 문서 보정이 CPU·메모리를 씁니다.

---

## 0단계 · Ubuntu 설치 + 디스크 암호화

설치 프로그램에서 **"Encrypt the LVM group with LUKS"를 반드시 켭니다.**

`ready/` 폴더에는 복호화된 서류 사진이 평문으로 놓입니다. ERP가 읽어야 하기 때문입니다.
미니PC를 도난당하거나 디스크만 빼가면 그대로 노출됩니다. **LUKS가 그 유일한 방어선입니다.**

> 암호를 잊으면 디스크를 못 엽니다. 개인키 백업과 같은 장소에 보관하세요.

부팅 시 암호 입력이 필요합니다. 정전 후 자동 복구가 필요하면 별도 검토가 필요합니다.

---

## 1단계 · 네트워크 진단

저장소를 받고 진단부터 돌립니다.

```bash
sudo apt update && sudo apt install -y git curl
```

```bash
git clone https://github.com/tryo528-blip/ssw-message.git /opt/ssw-message
```

```bash
node /opt/ssw-message/server/check-network.mjs
```

`[3] 밖에서 찾아올 수 있는 주소인가` 가 **"가능해 보입니다"** 여야 계속 진행합니다.
"공유 주소(CGNAT)"가 나오면 통신사에 공인 IP를 요청하세요. 대개 무료입니다.

`[1]` 의 내부 주소를 적어두세요. 4단계에서 씁니다.

---

## 2단계 · 런타임 설치

```bash
sudo apt install -y nodejs npm python3 python3-opencv python3-numpy
```

```bash
node -v && python3 -c "import cv2; print('OpenCV', cv2.__version__)"
```

Node는 서버, Python+OpenCV는 문서 보정에 씁니다.
Node 쪽은 **외부 패키지가 0개**라 `npm install` 이 필요 없습니다.

---

## 3단계 · 인터넷 주소 이름 만들기 (DDNS)

인터넷 주소는 수시로 바뀝니다. 바뀌어도 찾아올 수 있게 이름을 붙입니다.

### 방법 A — 공유기 내장 기능 (권장)

ipTIME 공유기라면 이미 들어 있습니다.

1. 공유기 관리페이지 접속 (보통 `192.168.0.1`)
2. **고급설정 → 특수기능 → DDNS 설정**
3. 이름 입력 → `우리회사메시지.iptime.org` 같은 주소가 생성됨
4. 등록 상태가 "정상 등록"인지 확인

공유기가 알아서 갱신하므로 별도 프로그램이 필요 없습니다.

### 방법 B — DDNS 기능이 없을 때

[duckdns.org](https://www.duckdns.org) 에서 무료 주소를 만들고 갱신을 cron에 겁니다.

```bash
(crontab -l 2>/dev/null; echo "*/5 * * * * curl -s 'https://www.duckdns.org/update?domains=이름&token=토큰&ip=' >/dev/null") | crontab -
```

---

## 4단계 · 공유기 설정

**4-1. 미니PC 주소 고정** — 포워딩 목적지가 바뀌면 끊깁니다.
**고급설정 → 네트워크 관리 → 내부 네트워크 설정** 에서 미니PC를 1단계 주소로 수동 할당합니다.

**4-2. 포트 포워딩** — **고급설정 → NAT/라우터 관리 → 포트포워드 설정**

| 규칙 이름 | 외부 포트 | 내부 IP | 내부 포트 | 프로토콜 |
|---|---|---|---|---|
| ssw-https | 443 | 미니PC 주소 | 443 | TCP |
| ssw-http | 80 | 미니PC 주소 | 80 | TCP |

80번은 인증서 자동 발급용입니다. **그 외 포트는 열지 마세요.**

방화벽도 같이 잠급니다.

```bash
sudo ufw allow 22/tcp && sudo ufw allow 80/tcp && sudo ufw allow 443/tcp && sudo ufw enable
```

---

## 5단계 · 계정과 권한 — 키 분리를 OS가 강제하게

**이 단계가 리눅스로 온 가장 큰 이득입니다.**
"수신 서버는 개인키를 갖지 않는다"가 약속이 아니라 **파일 권한으로 강제**됩니다.
receiver가 침해당해도 개인키 파일을 읽을 수 없습니다.

```bash
sudo useradd -r -s /usr/sbin/nologin ssw-recv
sudo useradd -r -s /usr/sbin/nologin ssw-coll
sudo mkdir -p /data/ssw/{keys,inbox/{enc,status,ready,_processed,_error},logs}
```

```bash
# 키: collector 전용. receiver는 접근조차 불가
sudo chown -R ssw-coll:ssw-coll /data/ssw/keys && sudo chmod 700 /data/ssw/keys

# 암호문: receiver가 쓰고 collector가 읽음
sudo chown ssw-recv:ssw-coll /data/ssw/inbox/enc && sudo chmod 770 /data/ssw/inbox/enc

# 상태: collector가 쓰고 receiver가 읽음
sudo chown ssw-coll:ssw-recv /data/ssw/inbox/status && sudo chmod 750 /data/ssw/inbox/status

# 결과물: collector 전용 (ERP 계정에는 별도로 읽기 권한 부여)
sudo chown -R ssw-coll:ssw-coll /data/ssw/inbox/{ready,_processed,_error} && sudo chmod 750 /data/ssw/inbox/ready
```

확인 — receiver 계정으로 키를 읽어보고 **실패해야 정상**입니다.

```bash
sudo -u ssw-recv cat /data/ssw/keys/office-private.jwk.json
```

`Permission denied` 가 나오면 제대로 된 것입니다.

---

## 6단계 · Caddy 설치 (HTTPS 자동)

```bash
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https && curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg && curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list && sudo apt update && sudo apt install -y caddy
```

`/etc/caddy/Caddyfile` 을 3단계에서 만든 주소로 채웁니다.

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

```bash
sudo systemctl restart caddy && sudo journalctl -u caddy -n 30 --no-pager
```

`certificate obtained successfully` 가 보이면 성공입니다.
실패하면 대개 80/443 포워딩이 안 된 것입니다. 4단계를 다시 보세요.

---

## 7단계 · 키 만들기

```bash
sudo -u ssw-coll SSW_KEYS=/data/ssw/keys node /opt/ssw-message/server/keygen.mjs office
```

**딱 한 번만 실행합니다.**

> ### 지금 바로 백업하세요
> - `office-private.jwk.json` 을 USB 2개에 복사, **최소 1개는 사무실 밖** 보관
> - LUKS 암호도 같이 보관 (별도 봉투 권장)
> - 담당자 1명이 혼자 들고 있지 않게 합니다
> - 잃으면 **아직 수집 안 된 사진은 누구도 못 엽니다.** 복구 방법이 없습니다

직원 기기 등록 — 사람마다 한 번씩입니다.

```bash
sudo -u ssw-coll SSW_KEYS=/data/ssw/keys node /opt/ssw-message/server/keygen.mjs device 김현장
```

출력된 JSON을 **오프라인 QR 생성기**로 QR을 만들어 해당 직원이 스캔하게 합니다.
비밀값이 들어 있으므로 온라인 QR 사이트, 카톡, 메일은 쓰지 마세요.

폰 분실 시 `devices.json` 에서 `"revoked": true` 로 바꾸면 즉시 차단됩니다.

---

## 8단계 · systemd 등록

`/etc/systemd/system/ssw-receiver.service`

```ini
[Unit]
Description=SSW Message receiver
After=network-online.target

[Service]
User=ssw-recv
Group=ssw-coll
WorkingDirectory=/opt/ssw-message
Environment=SSW_DATA=/data/ssw
ExecStart=/usr/bin/node /opt/ssw-message/server/receiver.mjs --port 8443
Restart=always
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ReadWritePaths=/data/ssw/inbox/enc
ProtectHome=true

[Install]
WantedBy=multi-user.target
```

`ProtectSystem=strict` 와 `ReadWritePaths` 로 **receiver가 쓸 수 있는 경로를 암호문 폴더 하나로 제한**합니다.
침해되어도 다른 곳을 건드릴 수 없습니다.

`/etc/systemd/system/ssw-collector.service`

```ini
[Unit]
Description=SSW Message collector
After=network-online.target

[Service]
User=ssw-coll
Group=ssw-coll
WorkingDirectory=/opt/ssw-message
Environment=SSW_DATA=/data/ssw
ExecStart=/usr/bin/node /opt/ssw-message/server/collector.mjs --watch
Restart=always
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ReadWritePaths=/data/ssw
ProtectHome=true

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload && sudo systemctl enable --now ssw-receiver ssw-collector && systemctl status ssw-receiver ssw-collector --no-pager
```

---

## 9단계 · 최종 확인

**반드시 휴대폰 데이터로** 확인합니다. 와이파이를 끄세요.
사무실 와이파이에 붙은 채로는 밖에서 되는지 알 수 없습니다.

1. 폰 브라우저에서 `https://우리회사메시지.iptime.org` 접속
2. 자물쇠 아이콘이 뜨고 경고가 없어야 합니다
3. **카메라 검증 페이지가 뜹니다** — 수신 서버가 함께 서빙합니다

여기까지 오면 별도 준비 없이 **카메라 실기 검증**을 바로 할 수 있습니다.
[spike/camera/README.md](../spike/camera/README.md) 절차를 따르세요.
아이폰·갤럭시 각 1대에서 "촬영 후 갤러리에 안 남는다"를 확인해야 다음 단계로 갑니다.

되지 않으면 순서대로 확인하세요.

| 증상 | 확인할 것 |
|---|---|
| 아예 연결 안 됨 | 포트포워딩, 미니PC 주소 변경 여부, `ufw status` |
| 인증서 경고 | `journalctl -u caddy`. 80번 포워딩 누락이 가장 흔합니다 |
| 사무실에서만 됨 | 이중 NAT(공유기 2대). 둘 다 포워딩 필요 |
| 502 Bad Gateway | receiver가 죽었습니다. `systemctl status ssw-receiver` |
| 어제까지 되다 안 됨 | DDNS 등록 상태, 통신사 IP 변경 |

---

## 보안 체크리스트

- [ ] LUKS 디스크 암호화가 켜져 있는가
- [ ] 열어둔 포트가 22, 80, 443 뿐인가 (`sudo ufw status`)
- [ ] `sudo -u ssw-recv cat` 으로 개인키 읽기가 **실패**하는가
- [ ] 공유기 관리자 비밀번호를 기본값에서 바꿨는가
- [ ] 공유기 **원격 관리(외부 접속)가 꺼져 있는가**
- [ ] 개인키 백업 2벌, 1벌은 사무실 밖에 있는가
- [ ] LUKS 암호를 개인키와 함께 보관했는가
- [ ] `unattended-upgrades` 로 보안 업데이트가 자동 적용되는가
- [ ] SSH 비밀번호 로그인을 끄고 키 인증만 쓰는가

## 정기 점검

| 주기 | 할 일 |
|---|---|
| 매주 | `_error/` 에 쌓인 게 없는지, 디스크 여유 확인 (`df -h`) |
| 매월 | 퇴사자·교체 단말 `revoked` 처리, 보존기간 지난 `_processed` 삭제 |
| 분기 | 폰에서 실제 전송 1건 테스트, 개인키 백업 상태 확인 |
