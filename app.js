const $ = (id) => document.getElementById(id);

const STORAGE_KEY = 'meta-display-remote-iphone:v1';
const ROOM_KEY = 'meta-display-remote-iphone:room';
const channel = 'BroadcastChannel' in window ? new BroadcastChannel('meta-display-remote-iphone') : null;

const SAMPLE_ITEMS = [
  {
    title: 'YouTube 샘플: Big Buck Bunny',
    url: 'https://www.youtube.com/watch?v=aqz-KE-bpKQ',
    favorite: true,
  },
  {
    title: 'YouTube 샘플: NASA Live',
    url: 'https://www.youtube.com/watch?v=21X5lGlDOfg',
    favorite: true,
  },
  {
    title: 'CHZZK Live 테스트',
    url: 'https://chzzk.naver.com/live/b1099827eb54bab6771bae5c85e887b7',
    favorite: false,
  },
];

const state = {
  mode: 'display',
  items: [],
  focusIndex: 0,
  current: null,
  room: 'default',
  relayReady: false,
  lastRelayId: 0,
  hls: null,
  chzzkQuality: null,
  chzzkDirectRunId: 0,
  chzzkAbortController: null,
};

function getInitialRoom() {
  const params = new URLSearchParams(window.location.search);
  const fromUrl = params.get('room');
  const fromStorage = localStorage.getItem(ROOM_KEY);
  const room = (fromUrl || fromStorage || 'default').trim().replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 48) || 'default';
  localStorage.setItem(ROOM_KEY, room);
  return room;
}

function loadState() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    state.items = Array.isArray(saved.items) && saved.items.length ? saved.items : SAMPLE_ITEMS;
  } catch {
    state.items = SAMPLE_ITEMS;
  }
}

function persist() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ items: state.items.slice(0, 40) }));
}

function normalizeUrl(raw) {
  const value = (raw || '').trim();
  if (!value) return null;
  try {
    return new URL(value.startsWith('http') ? value : `https://${value}`);
  } catch {
    return null;
  }
}

function parseProvider(raw) {
  const url = normalizeUrl(raw);
  if (!url) return { provider: 'unknown', kind: 'invalid', title: '잘못된 URL', raw };
  const host = url.hostname.replace(/^www\./, '').replace(/^m\./, '');
  const path = url.pathname;

  if (host === 'youtu.be') {
    const id = path.split('/').filter(Boolean)[0];
    return { provider: 'youtube', kind: 'video', id, title: `YouTube ${id || ''}`, url: url.href, embedUrl: youtubeEmbed(id) };
  }
  if (host.endsWith('youtube.com')) {
    const id = url.searchParams.get('v') || path.split('/').filter(Boolean).at(-1);
    return { provider: 'youtube', kind: path.includes('/live') ? 'live' : 'video', id, title: `YouTube ${id || ''}`, url: url.href, embedUrl: youtubeEmbed(id) };
  }
  if (host.endsWith('chzzk.naver.com')) {
    const parts = path.split('/').filter(Boolean);
    const kind = parts.includes('live') ? 'live' : parts.includes('video') ? 'video' : parts.includes('clips') || parts.includes('clip') ? 'clip' : 'page';
    const id = parts.at(-1);
    return {
      provider: 'chzzk',
      kind,
      id,
      title: `CHZZK ${kind.toUpperCase()} ${id || ''}`,
      url: url.href,
      embedUrl: chzzkCandidateEmbed(url, kind, id),
    };
  }
  return { provider: 'web', kind: 'page', title: host, url: url.href, embedUrl: url.href };
}

function youtubeEmbed(id) {
  if (!id) return null;
  return `https://www.youtube.com/embed/${encodeURIComponent(id)}?autoplay=1&playsinline=1&rel=0&modestbranding=1`;
}

function chzzkCandidateEmbed(url, kind, id) {
  if (!id) return url.href;
  if (kind === 'clip') return url.href;
  if (kind === 'video') return url.href;
  if (kind === 'live') return `https://chzzk.naver.com/live/${encodeURIComponent(id)}`;
  return url.href;
}

function getChzzkQuality() {
  const params = new URLSearchParams(window.location.search);
  const quality = (state.chzzkQuality || params.get('chzzkQuality') || params.get('quality') || '480p').toLowerCase();
  return ['720p', '480p', '360p', '144p'].includes(quality) ? quality : '480p';
}

function setChzzkQuality(quality) {
  state.chzzkQuality = ['720p', '480p', '360p', '144p'].includes(String(quality).toLowerCase()) ? String(quality).toLowerCase() : '480p';
  const url = new URL(window.location.href);
  url.searchParams.set('chzzkQuality', state.chzzkQuality);
  history.replaceState(null, '', url);
  return state.chzzkQuality;
}

function getChzzkMode() {
  const params = new URLSearchParams(window.location.search);
  return params.get('chzzkMode') || 'direct';
}

function disposeHls() {
  if (state.hls) {
    state.hls.destroy();
    state.hls = null;
  }
}

function abortChzzkDirectRequest() {
  if (state.chzzkAbortController) {
    state.chzzkAbortController.abort();
    state.chzzkAbortController = null;
  }
}

function stopCurrentVideoElement() {
  const video = $('chzzkVideo');
  if (!video) return;
  try {
    video.pause();
    video.removeAttribute('src');
    video.load();
  } catch {
    // Best-effort cleanup for constrained MRBD browser implementations.
  }
}

function cleanupChzzkDirectPlayback() {
  abortChzzkDirectRequest();
  disposeHls();
  stopCurrentVideoElement();
}

function formatMbps(bandwidth) {
  if (!bandwidth) return '-';
  return `${(bandwidth / 1_000_000).toFixed(2)} Mbps`;
}

function makeLaunchUrl(raw) {
  const base = new URL(window.location.href);
  base.search = '';
  base.hash = '';
  base.searchParams.set('mode', 'display');
  base.searchParams.set('room', state.room);
  base.searchParams.set('play', raw);
  return base.href;
}

function makePhoneUrl() {
  const base = new URL(window.location.href);
  base.search = '';
  base.hash = '';
  base.searchParams.set('mode', 'phone');
  base.searchParams.set('room', state.room);
  return base.href;
}

function setMode(mode) {
  state.mode = mode;
  $('app').dataset.mode = mode;
  $('displayView').classList.toggle('active', mode === 'display');
  $('phoneView').classList.toggle('active', mode === 'phone');
  $('screenTitle').textContent = mode === 'display' ? '안경 디스플레이' : '폰 컴패니언';
  $('modePill').textContent = mode === 'display' ? 'DISPLAY' : 'PHONE';
  const url = new URL(window.location.href);
  url.searchParams.set('mode', mode);
  history.replaceState(null, '', url);
  renderAll();
}

function upsertRecent(item) {
  if (!item?.url) return;
  const existing = state.items.find((x) => x.url === item.url);
  const next = {
    title: item.title || parseProvider(item.url).title,
    url: item.url,
    favorite: existing?.favorite || item.favorite || false,
    lastPlayedAt: new Date().toISOString(),
  };
  state.items = [next, ...state.items.filter((x) => x.url !== item.url)].slice(0, 40);
  persist();
}

function saveFavorite(raw) {
  const parsed = parseProvider(raw);
  if (!parsed.url) return showAnalysis('유효한 URL이 아닙니다.', true);
  const title = prompt('즐겨찾기 이름', parsed.title) || parsed.title;
  upsertRecent({ title, url: parsed.url, favorite: true });
  renderAll();
  showAnalysis(`즐겨찾기에 저장됨: ${title}`);
}

function renderList(container, items, compact = false) {
  container.innerHTML = '';
  items.forEach((item, index) => {
    const parsed = parseProvider(item.url);
    const el = document.createElement('div');
    el.className = `item ${index === state.focusIndex && !compact ? 'focused' : ''}`;
    el.tabIndex = 0;
    el.innerHTML = `
      <div class="item-badge">${parsed.provider.toUpperCase()} · ${parsed.kind.toUpperCase()} ${item.favorite ? '· ★' : ''}</div>
      <div class="item-title"></div>
      <div class="item-meta"></div>
    `;
    el.querySelector('.item-title').textContent = item.title || parsed.title;
    el.querySelector('.item-meta').textContent = item.url;
    el.addEventListener('click', () => compact ? sendUrlToDisplay(item.url) : playUrl(item.url));
    el.addEventListener('focus', () => { state.focusIndex = index; renderDisplayList(); });
    container.appendChild(el);
  });
}

function renderDisplayList() {
  renderList($('displayList'), state.items, false);
}

function renderPhoneList() {
  renderList($('phoneList'), state.items, true);
}

function renderAll() {
  renderDisplayList();
  renderPhoneList();
}

function showAnalysis(text, isError = false) {
  $('analysisBox').textContent = text;
  $('analysisBox').classList.toggle('error', isError);
}

function setRelayState(text, isReady = false) {
  state.relayReady = isReady;
  const relayState = $('relayState');
  const connectionState = $('connectionState');
  if (relayState) relayState.textContent = text;
  if (connectionState) connectionState.textContent = text;
}

function playRelayMessage(data) {
  if (!data?.url || state.mode !== 'display') return;
  if (data.id && data.id <= state.lastRelayId) return;
  if (data.id) state.lastRelayId = data.id;
  playUrl(data.url);
}

function updateNowPlaying(text) {
  const target = $('nowPlaying');
  if (target) target.textContent = text || '아직 송출 중인 영상이 없습니다.';
}

function analyzeInput() {
  const raw = $('urlInput').value.trim();
  const parsed = parseProvider(raw);
  if (!parsed.url) {
    $('launchUrl').value = '';
    $('qrBox').textContent = 'QR';
    return showAnalysis('유효한 URL이 아닙니다.', true);
  }
  const launch = makeLaunchUrl(parsed.url);
  $('launchUrl').value = launch;
  renderQr(launch);
  showAnalysis(`${parsed.provider.toUpperCase()} / ${parsed.kind}: MRBD launch URL 생성 완료`);
  upsertRecent({ title: parsed.title, url: parsed.url });
  renderAll();
}

function renderQr(text) {
  const encoded = encodeURIComponent(text);
  $('qrBox').innerHTML = `<img alt="launch QR" src="https://api.qrserver.com/v1/create-qr-code/?size=160x160&margin=8&data=${encoded}">`;
}

async function copyLaunch() {
  if (!$('launchUrl').value) analyzeInput();
  if (!$('launchUrl').value) return;
  await navigator.clipboard.writeText($('launchUrl').value);
  showAnalysis('Launch URL을 복사했습니다. MRBD 브라우저에서 열면 됩니다.');
}

function openLaunch() {
  if (!$('launchUrl').value) analyzeInput();
  if ($('launchUrl').value) window.open($('launchUrl').value, '_blank', 'noopener');
}

function previewOnThisDevice() {
  const raw = $('urlInput').value.trim();
  const parsed = parseProvider(raw);
  if (!parsed.url) return showAnalysis('유효한 URL을 넣은 뒤 이 기기에서 미리보기를 누르세요.', true);
  const launch = makeLaunchUrl(parsed.url);
  $('launchUrl').value = launch;
  renderQr(launch);
  upsertRecent({ title: parsed.title, url: parsed.url });
  renderAll();
  window.open(launch, '_blank', 'noopener');
  showAnalysis('이 기기에서 Display와 동일한 재생 화면을 미리보기로 열었습니다. 여기서 이상 없을 때 글래스에 보내세요.');
}

async function sendUrlToDisplay(raw = $('urlInput').value.trim()) {
  const parsed = parseProvider(raw);
  if (!parsed.url) return showAnalysis('유효한 URL이 아닙니다.', true);
  upsertRecent({ title: parsed.title, url: parsed.url });
  updateNowPlaying(`${parsed.title} · ${parsed.provider.toUpperCase()} ${parsed.kind.toUpperCase()}`);
  renderAll();
  const launch = makeLaunchUrl(parsed.url);
  $('launchUrl').value = launch;
  renderQr(launch);
  channel?.postMessage({ type: 'play', url: parsed.url });
  try {
    const response = await fetch('/api/push', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ room: state.room, url: parsed.url }),
    });
    const result = await response.json();
    if (!response.ok || !result.ok) throw new Error(result.error || 'relay_failed');
    showAnalysis(`${parsed.provider.toUpperCase()} 링크를 글래스로 보냈습니다. 연결된 Display: ${result.delivered}. 멈춰 있으면 글래스 화면 안의 재생 버튼을 눌러야 합니다.`);
  } catch {
    showAnalysis('Relay 전송 실패. Display launch URL을 복사해서 Meta AI 앱에 입력하세요.', true);
  }
}

function playUrl(raw) {
  const parsed = parseProvider(raw);
  if (!parsed.url) return;
  cleanupChzzkDirectPlayback();
  state.current = parsed;
  updateNowPlaying(`${parsed.title} · ${parsed.provider.toUpperCase()} ${parsed.kind.toUpperCase()}`);
  upsertRecent({ title: parsed.title, url: parsed.url });
  setMode('display');
  $('app').classList.remove('chzzk-theater');
  const frame = $('playerFrame');
  frame.innerHTML = '';

  if (parsed.provider === 'youtube' && parsed.embedUrl) {
    const iframe = document.createElement('iframe');
    iframe.allow = 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share';
    iframe.allowFullscreen = true;
    iframe.src = parsed.embedUrl;
    frame.appendChild(iframe);
    return;
  }

  if (parsed.provider === 'chzzk') {
    $('app').classList.add('chzzk-theater');
    if (parsed.kind === 'live' && getChzzkMode() !== 'official') {
      playChzzkDirect(parsed);
      return;
    }
    playChzzkOfficial(parsed);
    return;
  }

  showFallback(parsed, '내장 재생을 지원하지 않는 URL입니다.');
}

function playChzzkOfficial(parsed) {
  cleanupChzzkDirectPlayback();
  const frame = $('playerFrame');
  frame.innerHTML = '';
  const iframe = document.createElement('iframe');
  iframe.allow = 'autoplay; encrypted-media; fullscreen; picture-in-picture';
  iframe.allowFullscreen = true;
  iframe.referrerPolicy = 'strict-origin-when-cross-origin';
  iframe.src = parsed.embedUrl || parsed.url;
  frame.appendChild(iframe);
}

async function playChzzkDirect(parsed) {
  cleanupChzzkDirectPlayback();
  const runId = ++state.chzzkDirectRunId;
  const controller = new AbortController();
  state.chzzkAbortController = controller;
  const frame = $('playerFrame');
  const quality = getChzzkQuality();
  frame.innerHTML = `
    <div class="chzzk-direct">
      <div id="chzzkStatus" class="chzzk-status">CHZZK ${quality} HLS 직접 재생 준비 중…</div>
      <video id="chzzkVideo" class="chzzk-video" autoplay playsinline webkit-playsinline disablepictureinpicture></video>
      <div id="chzzkOverlay" class="chzzk-overlay"></div>
    </div>
  `;
  const video = $('chzzkVideo');
  video.controls = false;
  video.disablePictureInPicture = true;
  const overlay = $('chzzkOverlay');
  const status = $('chzzkStatus');
  const isCurrentRun = () => state.chzzkDirectRunId === runId;
  const setStatus = (text, hidden = false) => {
    if (!isCurrentRun() || !status) return;
    status.textContent = text;
    status.classList.toggle('hidden', hidden);
  };
  ['loadedmetadata', 'loadeddata', 'canplay', 'playing'].forEach((eventName) => {
    video.addEventListener(eventName, () => setStatus('', true), { once: eventName !== 'playing' });
  });
  video.addEventListener('waiting', () => setStatus(`CHZZK ${quality} 버퍼링 중…`, false));
  video.addEventListener('error', () => setStatus('CHZZK video 오류. 다른 품질이나 공식 페이지를 시도하세요.', false));
  try {
    const response = await fetch(`/api/chzzk/live?channel=${encodeURIComponent(parsed.url)}&quality=${encodeURIComponent(quality)}&t=${Date.now()}`, {
      cache: 'no-store',
      signal: controller.signal,
    });
    const result = await response.json();
    if (!isCurrentRun()) return;
    if (!response.ok || !result.ok) throw new Error(result.error || 'chzzk_hls_failed');
    const src = result.selected.url;
    overlay.innerHTML = `
      <div><strong>${result.selected.quality}</strong> · ${result.selected.width}x${result.selected.height} · ${formatMbps(result.selected.bandwidth)}</div>
      <div>${result.title || parsed.title}</div>
      <div class="button-row chzzk-mini-buttons">
        <button id="chzzkPlayBtn">재생/일시정지</button>
        <button id="chzzk480Btn">480p</button>
        <button id="chzzk720Btn">720p</button>
        <button id="chzzkOfficialBtn">공식 페이지</button>
      </div>
    `;
    overlay.querySelector('#chzzkPlayBtn').addEventListener('click', () => toggleCurrentVideo());
    overlay.querySelector('#chzzk480Btn').addEventListener('click', () => switchChzzkQuality('480p'));
    overlay.querySelector('#chzzk720Btn').addEventListener('click', () => switchChzzkQuality('720p'));
    overlay.querySelector('#chzzkOfficialBtn').addEventListener('click', () => playChzzkOfficial(parsed));

    if (window.Hls?.isSupported()) {
      const hls = new Hls({
        enableWorker: true,
        lowLatencyMode: true,
        liveDurationInfinity: true,
        liveSyncDurationCount: 3,
        liveMaxLatencyDurationCount: 8,
        maxBufferLength: 12,
        maxMaxBufferLength: 20,
        backBufferLength: 0,
      });
      state.hls = hls;
      hls.loadSource(src);
      hls.attachMedia(video);
      hls.on(Hls.Events.MANIFEST_PARSED, () => setStatus(`CHZZK ${result.selected.quality} 재생 시작 중…`, false));
      hls.on(Hls.Events.LEVEL_LOADED, (_, data) => {
        setStatus('', true);
        if (data?.details?.live && Number.isFinite(hls.liveSyncPosition) && Math.abs(video.currentTime - hls.liveSyncPosition) > 8) {
          video.currentTime = hls.liveSyncPosition;
        }
      });
      hls.on(Hls.Events.ERROR, (_, data) => {
        if (!isCurrentRun()) return;
        if (data?.fatal) {
          overlay.classList.add('error');
          overlay.insertAdjacentHTML('beforeend', `<div>HLS 오류: ${data.type || ''} ${data.details || ''}</div>`);
        }
      });
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = src;
    } else {
      throw new Error('hls_not_supported');
    }
    if (!isCurrentRun()) return;
    await video.play().catch(() => {
      if (!isCurrentRun()) return;
      overlay.insertAdjacentHTML('beforeend', '<div>자동재생이 막히면 화면의 재생 버튼을 누르세요.</div>');
    });
  } catch (error) {
    if (error.name === 'AbortError' || !isCurrentRun()) return;
    frame.innerHTML = '';
    showChzzkDirectFallback(parsed, error.message || 'direct_failed');
  } finally {
    if (isCurrentRun()) state.chzzkAbortController = null;
  }
}

function switchChzzkQuality(quality) {
  if (state.current?.provider !== 'chzzk') return;
  setChzzkQuality(quality);
  if (state.current.kind === 'live') playChzzkDirect(state.current);
}

function showChzzkDirectFallback(parsed, reason) {
  const frame = $('playerFrame');
  const card = document.createElement('div');
  card.className = 'fallback-card';
  card.innerHTML = `
    <div>
      <div class="logo-mark">⚠</div>
      <h2>CHZZK 직접 재생 실패</h2>
      <p>${reason}</p>
      <div class="button-row">
        <button id="retryDirectBtn">직접 재시도</button>
        <button id="officialBtn" class="primary">공식 페이지</button>
      </div>
    </div>
  `;
  frame.appendChild(card);
  card.querySelector('#retryDirectBtn').addEventListener('click', () => playChzzkDirect(parsed));
  card.querySelector('#officialBtn').addEventListener('click', () => playChzzkOfficial(parsed));
}

function showFallback(parsed, reason) {
  const frame = $('playerFrame');
  const card = document.createElement('div');
  card.className = 'fallback-card';
  card.innerHTML = `
    <div>
      <div class="logo-mark">↗</div>
      <h2>공식 페이지로 열기</h2>
      <p>${reason}</p>
      <div class="button-row">
        <button id="retryBtn">다시 시도</button>
        <button id="fullPageBtn" class="primary">전체 페이지 열기</button>
        <button id="backBtn">런처</button>
      </div>
    </div>
  `;
  frame.appendChild(card);
  card.querySelector('#retryBtn').addEventListener('click', () => playUrl(parsed.url));
  card.querySelector('#fullPageBtn').addEventListener('click', () => { window.location.href = parsed.url; });
  card.querySelector('#backBtn').addEventListener('click', resetPlayer);
}

function resetPlayer() {
  cleanupChzzkDirectPlayback();
  state.current = null;
  $('app').classList.remove('chzzk-theater');
  $('playerFrame').innerHTML = `
    <div class="empty-state">
      <div class="logo-mark">◉</div>
      <h2>폰에서 영상을 골라<br/>안경으로 보내는 런처</h2>
      <p>Phone Companion에서 YouTube/CHZZK URL을 넣고 Launch URL 또는 QR로 MRBD에서 여세요.</p>
      <div class="shortcut-row"><kbd>↑↓</kbd><span>목록 이동</span><kbd>Enter</kbd><span>열기</span><kbd>Esc</kbd><span>뒤로</span></div>
    </div>`;
}

function handleRemote(action) {
  if (action === 'up') state.focusIndex = Math.max(0, state.focusIndex - 1);
  if (action === 'down') state.focusIndex = Math.min(state.items.length - 1, state.focusIndex + 1);
  if (action === 'enter') playUrl(state.items[state.focusIndex]?.url);
  if (action === 'back') resetPlayer();
  if (action === 'playpause') toggleCurrentVideo();
  renderDisplayList();
}

function toggleCurrentVideo(force) {
  const video = $('chzzkVideo');
  if (!video) return false;
  if (force === 'pause' || (!force && !video.paused)) {
    video.pause();
    return true;
  }
  video.play().catch(() => {});
  return true;
}

function handleControl(action) {
  if (!action) return;
  if (action === 'playpause') toggleCurrentVideo();
  if (action === 'play') toggleCurrentVideo('play');
  if (action === 'pause') toggleCurrentVideo('pause');
  if (action === 'back') resetPlayer();
  if (action === 'quality:480p' && state.current?.provider === 'chzzk') switchChzzkQuality('480p');
  if (action === 'quality:720p' && state.current?.provider === 'chzzk') switchChzzkQuality('720p');
  if (action === 'official' && state.current?.provider === 'chzzk') playChzzkOfficial(state.current);
  if (action === 'direct' && state.current?.provider === 'chzzk') playChzzkDirect(state.current);
}

async function sendControl(action) {
  channel?.postMessage({ type: 'control', action });
  if (state.mode === 'display') handleControl(action);
  try {
    const response = await fetch('/api/control', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ room: state.room, action }),
    });
    const result = await response.json();
    if (!response.ok || !result.ok) throw new Error(result.error || 'control_failed');
    showAnalysis(`제어 전송: ${action} · 연결된 Display ${result.delivered}`);
  } catch {
    showAnalysis('제어 전송 실패. Display가 같은 room으로 열려 있는지 확인하세요.', true);
  }
}

function seedSamples() {
  state.items = [...SAMPLE_ITEMS, ...state.items.filter((item) => !SAMPLE_ITEMS.some((sample) => sample.url === item.url))].slice(0, 40);
  persist();
  renderAll();
}

function bootFromParams() {
  state.room = getInitialRoom();
  const params = new URLSearchParams(window.location.search);
  const mode = params.get('mode') || 'display';
  const play = params.get('play');
  setMode(mode === 'phone' ? 'phone' : 'display');
  if (play) {
    $('urlInput').value = play;
    playUrl(play);
  }
  if (state.mode === 'phone') renderQr(makePhoneUrl());
}

function bindEvents() {
  $('displayModeBtn').addEventListener('click', () => setMode('display'));
  $('phoneModeBtn').addEventListener('click', () => setMode('phone'));
  $('sampleBtn').addEventListener('click', seedSamples);
  $('sampleBtnInline')?.addEventListener('click', seedSamples);
  $('sendDisplayBtn').addEventListener('click', () => sendUrlToDisplay());
  $('saveFavoriteBtn').addEventListener('click', () => saveFavorite($('urlInput').value));
  $('copyLaunchBtn').addEventListener('click', copyLaunch);
  $('openLaunchBtn').addEventListener('click', openLaunch);
  $('previewDeviceBtn').addEventListener('click', previewOnThisDevice);
  document.querySelectorAll('[data-control]').forEach((button) => {
    button.addEventListener('click', () => sendControl(button.dataset.control));
  });
  document.querySelectorAll('[data-remote]').forEach((button) => {
    button.addEventListener('click', () => {
      const action = button.dataset.remote;
      handleRemote(action);
      channel?.postMessage({ type: 'remote', action });
    });
  });
  document.addEventListener('keydown', (event) => {
    const map = { ArrowUp: 'up', ArrowDown: 'down', Enter: 'enter', Escape: 'back', Backspace: 'back' };
    if (!map[event.key]) return;
    if (['TEXTAREA', 'INPUT'].includes(document.activeElement?.tagName)) return;
    event.preventDefault();
    handleRemote(map[event.key]);
  });
  channel?.addEventListener('message', (event) => {
    if (event.data?.type === 'remote' && state.mode === 'display') handleRemote(event.data.action);
    if (event.data?.type === 'control' && state.mode === 'display') handleControl(event.data.action);
    if (event.data?.type === 'play' && state.mode === 'display') playUrl(event.data.url);
  });
}

function connectRelay() {
  if ('EventSource' in window) {
    const events = new EventSource(`/api/events?room=${encodeURIComponent(state.room)}`);
    events.addEventListener('ready', () => setRelayState(`relay 연결됨 · room ${state.room}`, true));
    events.addEventListener('play', (event) => playRelayMessage(JSON.parse(event.data || '{}')));
    events.addEventListener('control', (event) => {
      if (state.mode === 'display') handleControl(JSON.parse(event.data || '{}').action);
    });
    events.onerror = () => setRelayState(`relay 재연결 중 · room ${state.room}`, false);
  }
  window.setInterval(pollLatest, 1000);
  pollLatest();
}

async function pollLatest() {
  try {
    const response = await fetch(`/api/latest?room=${encodeURIComponent(state.room)}&since=${state.lastRelayId}`, { cache: 'no-store' });
    const result = await response.json();
    if (result.ok) {
      setRelayState(`relay 연결됨 · room ${state.room}`, true);
      playRelayMessage(result.latest);
    }
  } catch {
    setRelayState(`relay 재연결 중 · room ${state.room}`, false);
  }
}

loadState();
bindEvents();
bootFromParams();
connectRelay();
renderAll();
