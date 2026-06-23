# meta-display-remote-iphone

개인용 Meta Display / MRBD 브라우저용 영상 런처 + iPhone 컴패니언 PoC입니다.

핵심 목표는 안경에서 검색/입력을 많이 하는 것이 아니라, **iPhone에서 YouTube/CHZZK URL을 고르고 MRBD/안경 브라우저의 Display 화면으로 보내 재생/정지/닫기/타임라인 이동을 제어하는 것**입니다.

## 현재 완료 수준

이 repo는 “개인 사용 가능한 PoC 1차 마무리” 상태입니다.

- iPhone Phone Companion → MRBD/글래스 Display로 URL 송출
- `room` 기반 relay: `/api/push`, `/api/latest`, `/api/events`, `/api/control`, `/api/status`
- YouTube: 공식 iframe embed player + 폰 재생/일시정지/타임라인 상태 표시
- CHZZK Live: 공식 페이지 대신 직접 HLS `<video>` 재생 시도
- CHZZK VOD: 직접 HLS `<video>` 재생 시도 + signed playlist segment query 보존
- CHZZK 기본 화질: **480p ceiling**
  - 480p가 있으면 480p
  - 480p가 없으면 가능한 한 480p 이하의 최고 화질
  - 480p 이하가 전혀 없을 때만 더 높은 최저 화질 fallback
- 600x600 화면 대응 theater/player UI
- Phone Companion: 송출, 미리보기, 저장, 최근/즐겨찾기, 재생/일시정지/닫기, 타임라인 seek
- Meta AI 앱에 넣기 쉬운 짧은 시작점: `youtube.html`, `display.html`, `chzzk.html`
- 실기기 검증 페이지: `validation.html`

## 실행

```bash
npm start
```

기본 포트는 `5173`입니다.

- Phone Companion: <http://localhost:5173/?mode=phone>
- Display: <http://localhost:5173/?mode=display>
- 실기기 검증: <http://localhost:5173/validation.html>
- YouTube 즉시 테스트: <http://localhost:5173/youtube.html>
- CHZZK Live 즉시 테스트: <http://localhost:5173/chzzk.html>
- 빈 Display 런처: <http://localhost:5173/display.html>

LAN/실기기에서는 `localhost` 대신 Mac의 LAN IP 또는 HTTPS 터널 주소를 사용합니다.
Meta Display/MRBD는 일반 웹 서핑 앱이 없으므로, 실제 안경 테스트는 **Meta AI 앱에 HTTPS URL을 입력해서 여는 흐름**이 가장 현실적입니다.

## 사용 흐름

1. Mac에서 `npm start`로 앱/relay 서버를 띄웁니다.
2. iPhone에서 `https://.../?mode=phone` 또는 `validation.html`을 엽니다.
3. MRBD/글래스에서는 `https://.../display.html` 또는 Display launch URL을 엽니다.
4. iPhone에서 YouTube/CHZZK URL을 입력하고 **글래스로 보내기**를 누릅니다.
5. MRBD/글래스 Display에서 영상이 뜨는지 확인합니다.
6. iPhone에서 재생/일시정지/닫기/타임라인 이동이 먹는지 확인합니다.
7. `validation.html` 체크리스트에 실기기 결과를 기록하고 JSON으로 복사합니다.

## 주요 파일

- `index.html` — Display/Phone 공용 UI shell
- `app.js` — URL 파싱, Phone Companion, Display playback, relay polling/SSE, 제어/상태 로직
- `styles.css` — 600x600 Display와 iPhone Phone Companion UI
- `server.js` — 정적 파일 서버 + relay API + CHZZK Live/VOD HLS helper API
- `validation.html` — iPhone 중심 실기기 검증 도구
- `youtube.html` — YouTube 샘플 Display redirect
- `chzzk.html` — CHZZK Live 샘플 Display redirect, 기본 480p
- `display.html` — 빈 Display redirect
- `test/server.test.js` — relay/API/CHZZK helper 회귀 테스트

## 지원 범위

### YouTube

- YouTube watch/live URL을 embed URL로 변환합니다.
- Display에서는 iframe player로 재생합니다.
- Phone Companion에서 play/pause와 타임라인 상태/seek를 제어합니다.
- 브라우저 autoplay 정책 때문에 최초 재생은 Display 화면 터치가 필요할 수 있습니다.

### CHZZK Live

- `chzzk.naver.com/live/<channelId>` URL을 받아 CHZZK live-detail API에서 HLS 정보를 가져옵니다.
- HLS master playlist에서 기본 480p ceiling으로 variant를 고릅니다.
- Display에서는 `hls.js` 또는 native HLS 가능한 브라우저의 `<video>`로 재생합니다.
- 공식 CHZZK 페이지 iframe은 느리고 광고/정책/로그인 변수도 있어 기본 경로가 아닙니다.

### CHZZK VOD

- `chzzk.naver.com/video/<videoNo>` URL을 받아 VOD playback 정보를 가져옵니다.
- 기본 480p ceiling으로 HLS representation을 고릅니다.
- VOD segment 요청에 필요한 manifest query/signature가 끊기지 않도록 `/api/chzzk/vod-playlist`에서 playlist를 보정합니다.
- 성인/차단/비 ABR_HLS VOD는 실패할 수 있습니다.

### CHZZK Clip

- 현재 직접 재생 구현 대상이 아닙니다.
- URL 파싱은 되지만, 안정 재생 경로는 Live/VOD 우선입니다.

## Relay/API 요약

- `GET /api/health` — 서버 상태와 room 목록
- `POST /api/push` — Phone에서 Display로 새 URL 송출
- `GET /api/latest?room=&since=` — Display/Phone이 최신 메시지 polling
- `GET /api/events?room=&sse=1` — SSE client용 이벤트 스트림
- `POST /api/control` — Phone에서 Display로 play/pause/back/seek 등 제어 전송
- `POST /api/status` / `GET /api/status` — Display playback 상태 공유
- `GET /api/chzzk/live` — CHZZK Live HLS variant 선택
- `GET /api/chzzk/video` — CHZZK VOD HLS variant 선택
- `GET /api/chzzk/vod-playlist` — VOD playlist segment signature 보존

## 실기기 검증 기준

GO로 볼 수 있는 기준:

- MRBD/글래스에서 HTTPS 앱 URL이 열린다.
- Display 600x600에서 핵심 UI와 video 영역이 잘리지 않는다.
- iPhone에서 URL 송출 후 Display가 영상을 받는다.
- YouTube가 실제 재생된다.
- CHZZK Live 또는 VOD가 480p ceiling direct video로 실제 재생된다.
- 폰에서 재생/일시정지/닫기/타임라인 이동이 최소 사용 가능한 수준으로 동작한다.
- 오디오 출력 위치가 사용 가능한 수준이다.

PARTIAL:

- YouTube는 안정적이나 CHZZK가 일부 콘텐츠/정책/브라우저에서 막힌다.
- 이 경우 개인 앱은 YouTube 중심으로 먼저 쓰고, CHZZK는 테스트 가능한 Live/VOD만 유지합니다.

NO-GO:

- MRBD 브라우저에서 YouTube도 재생/오디오/화면이 사용 불가 수준입니다.
- 이 경우 앱 기능 확장보다 MRBD 브라우저 미디어 제약 확인이 먼저입니다.

## 현재 남은 리스크

- Meta Display/MRBD 실기기 autoplay, HLS, 오디오 출력 정책은 데스크톱 검증으로 확정할 수 없습니다.
- CHZZK API/playlist 구조는 비공식 사용이므로 언제든 깨질 수 있습니다.
- CHZZK 콘텐츠별 로그인/성인/권한/지역 제한에 따라 실패할 수 있습니다.
- 장시간 시청 안정성, 발열, 배터리, 네트워크 끊김 복구는 아직 별도 장시간 테스트가 필요합니다.
- 외부 HTTPS 배포/터널을 쓰면 relay 서버가 인터넷에 노출되므로 개인용 URL 관리가 필요합니다.

## 테스트

```bash
npm test
```

현재 테스트는 서버 relay, CHZZK Live/VOD quality 선택, VOD playlist query 보존을 확인합니다.

## 이번 단계의 결론

비즈니스 제품이 아니라 개인용 MRBD/Meta Glass 영상 앱 기준으로는, 여기서 더 기능을 늘리기보다 **실기기에서 YouTube/CHZZK Live/VOD가 실제로 볼 만한지**를 확인하는 것이 다음 병목입니다.

다음 작업을 한다면 새 기능보다 아래 순서가 맞습니다.

1. HTTPS 공개 URL로 실기기 20~30분 시청 테스트
2. 오디오 출력 위치와 끊김/버퍼링 기록
3. 자주 보는 CHZZK Live/VOD 3~5개로 재생 성공률 확인
4. 성공률이 충분하면 즐겨찾기/검색 UX만 소폭 개선
