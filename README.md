# meta-display-remote-iphone

개인용 Meta Display / MRBD 브라우저용 영상 런처 PoC입니다.

목표는 안경에서 검색/입력을 많이 하는 것이 아니라, **iPhone에서 URL을 고르고 MRBD/안경 브라우저에서 영상 화면을 여는 것**입니다.

## 1차 검증 범위

- YouTube 영상이 안경 브라우저에서 재생되는지 확인
- CHZZK Live 공식 페이지가 안경 브라우저에서 진입/재생 가능한지 확인
- 600x600 화면에서 UI가 잘리지 않는지 확인
- 방향키 / Enter / Esc 조작이 동작하는지 확인
- 오디오가 안경/폰 중 어디로 나오는지 확인

CHZZK 클립/비디오는 1차 검증 범위에서 제외합니다. 우선 라이브만 봅니다.

## 실기기 검증 시작점

검증 페이지:

- 로컬/LAN: `http://<Mac-LAN-IP>:5173/validation.html`
- GitHub Pages 사용 시: `https://youn-sik.github.io/meta-display-remote-iphone/validation.html`

`validation.html`에는 YouTube/CHZZK Live launch URL 생성, QR, 실기기 체크리스트, 결과 JSON 복사 기능이 있습니다.

## 사용 흐름

1. `validation.html` 또는 `index.html?mode=phone`을 iPhone에서 엽니다.
2. YouTube 또는 CHZZK Live URL을 입력합니다.
3. `Launch URL 복사` 또는 QR을 사용해 MRBD/안경 브라우저에서 엽니다.
4. MRBD/안경에서는 600x600 화면에서 영상 또는 공식 페이지 fallback을 봅니다.
5. `validation.html` 체크리스트에 실기기 결과를 기록합니다.

## 모드

- Display: MRBD/안경용 600x600 화면
- Phone: URL 분석, 즐겨찾기, launch URL/QR 생성, 리모컨 데모

## 현재 지원

- YouTube: 공식 iframe embed player
- CHZZK Live: 공식 페이지 iframe 시도 후 전체 페이지 열기 보조 버튼 제공
- 최근/즐겨찾기: localStorage
- 방향키/Enter/Esc 조작
- 같은 브라우저/탭 간 리모컨 데모: BroadcastChannel

## 중요한 제약

정적 Web App만으로는 **실제 iPhone과 MRBD/안경 브라우저 사이의 실시간 원격 제어**가 안정적으로 불가능합니다. 서로 다른 기기 간 제어를 하려면 다음 단계에서 작은 relay가 필요합니다.

후속 후보:

- 작은 WebSocket relay 서버
- Supabase/Firebase 같은 realtime DB
- WebRTC signaling 서버

그래서 이 PoC는 먼저 `iPhone에서 선택 → MRBD launch URL로 열기`를 검증합니다. 실기기에서 이 흐름이 쓸만하면 다음 단계로 relay를 붙입니다.

## 로컬 실행

```bash
python3 -m http.server 5173
```

브라우저에서:

- Display: <http://localhost:5173/?mode=display>
- Phone: <http://localhost:5173/?mode=phone>

## 실기기 검증 체크리스트

- [ ] 600x600 화면에서 UI가 잘리지 않는다.
- [ ] Phone 모드에서 URL 분석 후 launch URL이 생성된다.
- [ ] YouTube launch URL이 Display 모드에서 iframe으로 열린다.
- [ ] YouTube 영상이 실제 재생된다.
- [ ] CHZZK Live URL이 Display 모드에서 공식 페이지로 진입한다.
- [ ] CHZZK Live가 실제 재생되거나, 안 되면 전체 페이지 열기 fallback이 동작한다.
- [ ] 방향키/Enter/Esc 조작이 동작한다.
- [ ] MRBD/안경 실기기에서 오디오 출력 위치를 확인한다.
