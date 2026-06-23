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
  chzzkRunId: 0,
  chzzkAbortController: null,
  chzzkStats: null,
  youtubeStatus: { currentTime: 0, duration: 0, paused: true, title: '', url: '' },
  playbackStatus: null,
  isSeekingFromPhone: false,
  lastStatusPostAt: 0,
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
  const params = new URLSearchParams({
    autoplay: '1',
    playsinline: '1',
    rel: '0',
    modestbranding: '1',
    controls: '0',
    disablekb: '1',
    fs: '0',
    iv_load_policy: '3',
    enablejsapi: '1',
    origin: window.location.origin,
  });
  return `https://www.youtube.com/embed/${encodeURIComponent(id)}?${params.toString()}`;
}

function chzzkCandidateEmbed(url, kind, id) {
  if (!id) return url.href;
  if (kind === 'clip') return url.href;
  if (kind === 'video') return url.href;
  if (kind === 'live') return `https://chzzk.naver.com/live/${encodeURIComponent(id)}`;
  return url.href;
}

function cleanupEmbeddedPlayback() {
  state.chzzkRunId += 1;
  if (state.chzzkAbortController) {
    state.chzzkAbortController.abort();
    state.chzzkAbortController = null;
  }
  if (state.hls) {
    state.hls.destroy();
    state.hls = null;
  }
  const video = $('chzzkVideo');
  if (video) {
    try {
      video.pause();
      video.removeAttribute('src');
      video.load();
    } catch {
      // Best-effort cleanup for constrained browsers.
    }
  }
  state.chzzkStats = null;
}

function formatSeconds(value) {
  if (!Number.isFinite(value)) return '-';
  return `${value.toFixed(1)}s`;
}

function formatMbps(bandwidth) {
  if (!bandwidth) return '-';
  return `${(bandwidth / 1_000_000).toFixed(2)} Mbps`;
}

function sendYouTubeCommand(func, args = []) {
  const iframe = $('youtubeFrame');
  if (!iframe?.contentWindow) return false;
  iframe.dataset.lastCommand = func;
  iframe.contentWindow.postMessage(JSON.stringify({ event: 'command', func, args }), 'https://www.youtube.com');
  return true;
}

function initializeYouTubeTelemetry() {
  const iframe = $('youtubeFrame');
  if (!iframe?.contentWindow) return;
  iframe.contentWindow.postMessage(JSON.stringify({ event: 'listening', id: 'youtubeFrame' }), 'https://www.youtube.com');
  sendYouTubeCommand('addEventListener', ['onStateChange']);
}

function handleYouTubeMessage(event) {
  if (event.origin !== 'https://www.youtube.com') return;
  let data = event.data;
  if (typeof data === 'string') {
    try { data = JSON.parse(data); } catch { return; }
  }
  if (!data || data.event !== 'infoDelivery' || !data.info) return;
  const info = data.info;
  if (Number.isFinite(info.currentTime)) state.youtubeStatus.currentTime = info.currentTime;
  if (Number.isFinite(info.duration)) state.youtubeStatus.duration = info.duration;
  if (Number.isFinite(info.playerState)) state.youtubeStatus.paused = info.playerState !== 1;
  if (typeof info.videoData?.title === 'string') state.youtubeStatus.title = info.videoData.title;
  state.youtubeStatus.url = state.current?.url || state.youtubeStatus.url || '';
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

function setTheaterMode(active) {
  $('app').classList.toggle('player-theater', active);
  document.body.classList.toggle('player-theater', active);
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

function normalizeFiniteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function formatClock(seconds) {
  const value = Math.max(0, Math.floor(normalizeFiniteNumber(seconds)));
  const h = Math.floor(value / 3600);
  const m = Math.floor((value % 3600) / 60);
  const s = value % 60;
  if (h) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function getVideoSeekable(video) {
  if (!video?.seekable?.length) return { start: 0, end: normalizeFiniteNumber(video?.duration) };
  const last = video.seekable.length - 1;
  return { start: video.seekable.start(0), end: video.seekable.end(last) };
}

function collectPlaybackStatus() {
  if (!state.current) {
    return { provider: 'none', title: '', url: '', paused: true, currentTime: 0, duration: 0, seekableStart: 0, seekableEnd: 0, isLive: false, canSeek: false };
  }
  if (state.current.provider === 'chzzk') {
    const video = $('chzzkVideo');
    const seekable = getVideoSeekable(video);
    const duration = Number.isFinite(video?.duration) ? video.duration : Math.max(0, seekable.end - seekable.start);
    const currentTime = normalizeFiniteNumber(video?.currentTime);
    return {
      provider: 'chzzk',
      title: state.current.title,
      url: state.current.url,
      paused: video ? video.paused : true,
      currentTime,
      duration,
      seekableStart: normalizeFiniteNumber(seekable.start),
      seekableEnd: normalizeFiniteNumber(seekable.end),
      isLive: true,
      canSeek: Boolean(video && seekable.end > seekable.start && currentTime >= seekable.start),
    };
  }
  if (state.current.provider === 'youtube') {
    return {
      provider: 'youtube',
      title: state.youtubeStatus.title || state.current.title,
      url: state.current.url,
      paused: Boolean(state.youtubeStatus.paused),
      currentTime: normalizeFiniteNumber(state.youtubeStatus.currentTime),
      duration: normalizeFiniteNumber(state.youtubeStatus.duration),
      seekableStart: 0,
      seekableEnd: normalizeFiniteNumber(state.youtubeStatus.duration),
      isLive: state.current.kind === 'live',
      canSeek: normalizeFiniteNumber(state.youtubeStatus.duration) > 0,
    };
  }
  return { provider: state.current.provider, title: state.current.title, url: state.current.url, paused: true, currentTime: 0, duration: 0, seekableStart: 0, seekableEnd: 0, isLive: false, canSeek: false };
}

async function postPlaybackStatus(force = false) {
  if (state.mode !== 'display') return;
  const now = Date.now();
  if (!force && now - state.lastStatusPostAt < 900) return;
  state.lastStatusPostAt = now;
  const status = collectPlaybackStatus();
  channel?.postMessage({ type: 'status', status });
  try {
    await fetch('/api/status', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ room: state.room, ...status }),
    });
  } catch {
    // Status is best-effort. Control path must not be blocked by telemetry.
  }
}

function applyPlaybackStatus(status) {
  if (!status || state.mode !== 'phone') return;
  state.playbackStatus = status;
  updateNowPlaying(status.provider === 'none' ? '아직 송출 중인 영상이 없습니다.' : `${status.title || status.provider} · ${status.provider.toUpperCase()} ${status.paused ? '· 일시정지' : '· 재생 중'}`);
  renderTimeline(status);
}

function renderTimeline(status = state.playbackStatus) {
  const slider = $('timelineSeek');
  const current = $('timelineCurrent');
  const duration = $('timelineDuration');
  const meta = $('timelineMeta');
  if (!slider || !current || !duration || !meta) return;
  if (!status || status.provider === 'none') {
    slider.disabled = true;
    slider.value = 0;
    current.textContent = '0:00';
    duration.textContent = '-:--';
    meta.textContent = '영상 상태를 기다리는 중…';
    return;
  }
  const start = normalizeFiniteNumber(status.seekableStart);
  const end = normalizeFiniteNumber(status.seekableEnd, status.duration);
  const currentTime = normalizeFiniteNumber(status.currentTime);
  const durationValue = normalizeFiniteNumber(status.duration, Math.max(0, end - start));
  const canSeek = Boolean(status.canSeek && end > start);
  slider.disabled = !canSeek;
  slider.min = String(canSeek ? start : 0);
  slider.max = String(canSeek ? end : Math.max(1, durationValue || 100));
  if (!state.isSeekingFromPhone) slider.value = String(currentTime);
  current.textContent = status.isLive ? `LIVE -${formatClock(Math.max(0, end - currentTime))}` : formatClock(currentTime);
  duration.textContent = status.isLive ? 'LIVE' : formatClock(durationValue);
  const quality = status.provider === 'chzzk' && status.title ? ' · 480p' : '';
  meta.textContent = `${status.provider.toUpperCase()}${quality} · ${status.paused ? '일시정지' : '재생 중'}${canSeek ? ' · 타임라인 이동 가능' : ' · 타임라인 대기 중'}`;
}

async function pollPlaybackStatus() {
  if (state.mode !== 'phone') return;
  try {
    const response = await fetch(`/api/status?room=${encodeURIComponent(state.room)}`, { cache: 'no-store' });
    const result = await response.json();
    if (result.ok) applyPlaybackStatus(result.status);
  } catch {
    renderTimeline(state.playbackStatus);
  }
}

function seekCurrentMedia(seconds) {
  const target = normalizeFiniteNumber(seconds);
  if (state.current?.provider === 'youtube') return sendYouTubeCommand('seekTo', [target, true]);
  if (state.current?.provider === 'chzzk') {
    const video = $('chzzkVideo');
    if (!video) return false;
    const seekable = getVideoSeekable(video);
    const clamped = Math.min(Math.max(target, seekable.start || 0), seekable.end || target);
    try {
      video.currentTime = clamped;
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

function playRelayMessage(data) {
  if (!data || state.mode !== 'display') return;
  if (data.id && data.id <= state.lastRelayId) return;
  if (data.id) state.lastRelayId = data.id;
  if (data.type === 'control' || data.action) {
    handleControl(data.action);
    return;
  }
  if (data.url) playUrl(data.url);
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
  cleanupEmbeddedPlayback();
  state.current = parsed;
  state.youtubeStatus = { currentTime: 0, duration: 0, paused: true, title: parsed.title, url: parsed.url };
  postPlaybackStatus(true);
  updateNowPlaying(`${parsed.title} · ${parsed.provider.toUpperCase()} ${parsed.kind.toUpperCase()}`);
  upsertRecent({ title: parsed.title, url: parsed.url });
  setMode('display');
  setTheaterMode(false);
  $('app').classList.remove('chzzk-theater');
  const frame = $('playerFrame');
  frame.innerHTML = '';

  if (parsed.provider === 'youtube' && parsed.embedUrl) {
    playYouTubeTheater(parsed);
    return;
  }

  if (parsed.provider === 'chzzk') {
    setTheaterMode(true);
    $('app').classList.add('chzzk-theater');
    playChzzkDirect480(parsed);
    return;
  }

  showFallback(parsed, '내장 재생을 지원하지 않는 URL입니다.');
}

function playYouTubeTheater(parsed) {
  setTheaterMode(true);
  const frame = $('playerFrame');
  frame.innerHTML = '';
  const iframe = document.createElement('iframe');
  iframe.id = 'youtubeFrame';
  iframe.className = 'youtube-frame';
  iframe.allow = 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share; fullscreen';
  iframe.allowFullscreen = true;
  iframe.referrerPolicy = 'strict-origin-when-cross-origin';
  iframe.src = parsed.embedUrl;
  frame.appendChild(iframe);
  iframe.addEventListener('load', () => setTimeout(initializeYouTubeTelemetry, 300));
}

function playChzzkOfficial(parsed) {
  cleanupEmbeddedPlayback();
  const frame = $('playerFrame');
  frame.innerHTML = '';
  const iframe = document.createElement('iframe');
  iframe.id = 'chzzkFrame';
  iframe.className = 'chzzk-frame';
  iframe.allow = 'autoplay; encrypted-media; fullscreen; picture-in-picture';
  iframe.allowFullscreen = true;
  iframe.referrerPolicy = 'strict-origin-when-cross-origin';
  iframe.src = parsed.embedUrl || parsed.url;
  frame.appendChild(iframe);
}

async function playChzzkDirect480(parsed) {
  cleanupEmbeddedPlayback();
  const runId = state.chzzkRunId;
  const controller = new AbortController();
  state.chzzkAbortController = controller;
  const frame = $('playerFrame');
  frame.innerHTML = `
    <div class="chzzk-direct">
      <video id="chzzkVideo" class="chzzk-video" autoplay playsinline webkit-playsinline disablepictureinpicture disableremoteplayback controlslist="nodownload nofullscreen noplaybackrate"></video>
      <div id="chzzkStatus" class="chzzk-status">CHZZK 480p 불러오는 중…</div>
      <div id="chzzkOverlay" class="chzzk-overlay">480p direct video</div>
    </div>
  `;
  const video = $('chzzkVideo');
  const status = $('chzzkStatus');
  const overlay = $('chzzkOverlay');
  const startedAt = performance.now();
  const stats = { waiting: 0, stalled: 0, errors: 0, firstPlayingMs: null, selected: null };
  state.chzzkStats = stats;
  const isCurrentRun = () => state.chzzkRunId === runId;
  const updateOverlay = (message) => {
    if (!isCurrentRun() || !overlay) return;
    const selected = stats.selected;
    const elapsed = (performance.now() - startedAt) / 1000;
    overlay.textContent = `${message} · ${selected?.quality || '480p'} · ${selected?.width || '-'}x${selected?.height || '-'} · ${formatMbps(selected?.bandwidth)} · wait ${stats.waiting} · ${formatSeconds(elapsed)}`;
  };
  const setStatus = (message, hidden = false) => {
    if (!isCurrentRun() || !status) return;
    status.textContent = message;
    status.classList.toggle('hidden', hidden);
    updateOverlay(message || '재생 중');
  };

  video.controls = false;
  video.disablePictureInPicture = true;
  video.disableRemotePlayback = true;
  video.addEventListener('click', () => toggleCurrentMedia());
  ['loadedmetadata', 'durationchange', 'timeupdate', 'play', 'pause', 'playing', 'waiting', 'stalled', 'seeked'].forEach((eventName) => {
    video.addEventListener(eventName, () => postPlaybackStatus(eventName !== 'timeupdate'));
  });
  video.addEventListener('loadedmetadata', () => setStatus('메타데이터 로드됨', false));
  video.addEventListener('canplay', () => setStatus(video.paused ? '화면을 눌러 재생하세요.' : '재생 가능', false));
  video.addEventListener('playing', () => {
    if (stats.firstPlayingMs == null) stats.firstPlayingMs = Math.round(performance.now() - startedAt);
    setStatus('', true);
  });
  video.addEventListener('waiting', () => { stats.waiting += 1; setStatus('버퍼링 중…', false); });
  video.addEventListener('stalled', () => { stats.stalled += 1; setStatus('네트워크 대기 중…', false); });
  video.addEventListener('error', () => { stats.errors += 1; setStatus('CHZZK video 오류', false); });

  try {
    const response = await fetch(`/api/chzzk/live?channel=${encodeURIComponent(parsed.url)}&quality=480p&t=${Date.now()}`, {
      cache: 'no-store',
      signal: controller.signal,
    });
    const result = await response.json();
    if (!isCurrentRun()) return;
    if (!response.ok || !result.ok) throw new Error(result.error || 'chzzk_hls_failed');
    stats.selected = result.selected;
    updateOverlay('HLS 로드');
    const src = result.selected.url;
    if (window.Hls?.isSupported()) {
      const hls = new Hls({
        enableWorker: true,
        lowLatencyMode: false,
        liveDurationInfinity: true,
        liveSyncDurationCount: 3,
        liveMaxLatencyDurationCount: 8,
        maxBufferLength: 18,
        maxMaxBufferLength: 30,
        backBufferLength: 8,
      });
      state.hls = hls;
      hls.loadSource(src);
      hls.attachMedia(video);
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        setStatus('재생 시작 중…', false);
        video.play().catch(() => setStatus('화면을 눌러 재생하세요.', false));
      });
      hls.on(Hls.Events.LEVEL_LOADED, () => updateOverlay(video.paused ? '대기 중' : '재생 중'));
      hls.on(Hls.Events.ERROR, (_, data) => {
        if (!isCurrentRun()) return;
        if (data?.fatal) {
          stats.errors += 1;
          setStatus(`HLS 오류: ${data.details || data.type || 'unknown'}`, false);
        }
      });
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = src;
      video.play().catch(() => setStatus('화면을 눌러 재생하세요.', false));
    } else {
      throw new Error('hls_not_supported');
    }
  } catch (error) {
    if (error.name === 'AbortError' || !isCurrentRun()) return;
    setStatus(`CHZZK 480p direct 실패: ${error.message || 'unknown'}`, false);
  } finally {
    if (isCurrentRun()) state.chzzkAbortController = null;
  }
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
  cleanupEmbeddedPlayback();
  state.current = null;
  state.youtubeStatus = { currentTime: 0, duration: 0, paused: true, title: '', url: '' };
  postPlaybackStatus(true);
  setTheaterMode(false);
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
  if (action === 'playpause') toggleCurrentMedia();
  renderDisplayList();
}

function toggleCurrentMedia(force) {
  if (state.current?.provider === 'youtube') {
    if (force === 'play') return sendYouTubeCommand('playVideo');
    if (force === 'pause') return sendYouTubeCommand('pauseVideo');
    return sendYouTubeCommand(state.youtubeStatus.paused ? 'playVideo' : 'pauseVideo');
  }
  if (state.current?.provider === 'chzzk') {
    const video = $('chzzkVideo');
    if (!video) return false;
    if (force === 'play') {
      video.play().catch(() => {});
      return true;
    }
    if (force === 'pause' || (!force && !video.paused)) {
      video.pause();
      return true;
    }
    video.play().catch(() => {});
    return true;
  }
  return false;
}

function handleControl(action) {
  if (!action) return;
  if (action === 'playpause') toggleCurrentMedia();
  if (action === 'play') toggleCurrentMedia('play');
  if (action === 'pause') toggleCurrentMedia('pause');
  if (action === 'back') resetPlayer();
  if (action.startsWith('seek:')) seekCurrentMedia(action.slice(5));
  postPlaybackStatus(true);
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
  const timeline = $('timelineSeek');
  timeline?.addEventListener('input', () => {
    state.isSeekingFromPhone = true;
    const current = $('timelineCurrent');
    if (current) current.textContent = formatClock(timeline.value);
  });
  timeline?.addEventListener('change', () => {
    state.isSeekingFromPhone = false;
    sendControl(`seek:${Number(timeline.value).toFixed(2)}`);
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
  window.addEventListener('message', handleYouTubeMessage);
  channel?.addEventListener('message', (event) => {
    if (event.data?.type === 'remote' && state.mode === 'display') handleRemote(event.data.action);
    if (event.data?.type === 'control' && state.mode === 'display') handleControl(event.data.action);
    if (event.data?.type === 'play' && state.mode === 'display') playUrl(event.data.url);
    if (event.data?.type === 'status' && state.mode === 'phone') applyPlaybackStatus(event.data.status);
  });
}

function connectRelay() {
  const useSse = new URLSearchParams(window.location.search).get('sse') === '1';
  if (useSse && 'EventSource' in window) {
    const events = new EventSource(`/api/events?room=${encodeURIComponent(state.room)}&sse=1`);
    events.addEventListener('ready', () => setRelayState(`relay 연결됨 · SSE+polling · room ${state.room}`, true));
    events.addEventListener('play', (event) => playRelayMessage(JSON.parse(event.data || '{}')));
    events.addEventListener('control', (event) => {
      if (state.mode === 'display') handleControl(JSON.parse(event.data || '{}').action);
    });
    events.addEventListener('status', (event) => {
      if (state.mode === 'phone') applyPlaybackStatus(JSON.parse(event.data || '{}'));
    });
    events.onerror = () => setRelayState(`relay SSE 재연결 중 · polling 유지 · room ${state.room}`, false);
  }
  setRelayState(`relay 연결됨 · polling · room ${state.room}`, true);
  window.setInterval(pollLatest, 1000);
  window.setInterval(() => postPlaybackStatus(false), 1000);
  window.setInterval(pollPlaybackStatus, 1000);
  pollLatest();
  pollPlaybackStatus();
}

async function pollLatest() {
  try {
    const response = await fetch(`/api/latest?room=${encodeURIComponent(state.room)}&since=${state.lastRelayId}`, { cache: 'no-store' });
    const result = await response.json();
    if (result.ok) {
      setRelayState(`relay 연결됨 · polling · room ${state.room}`, true);
      playRelayMessage(result.latest);
    }
  } catch {
    setRelayState(`relay 재연결 중 · room ${state.room}`, false);
  }
}

loadState();
bindEvents();
bootFromParams();
renderAll();
connectRelay();
