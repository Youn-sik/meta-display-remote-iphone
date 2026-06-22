const $ = (id) => document.getElementById(id);

const STORAGE_KEY = 'meta-display-remote-iphone:v1';
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
};

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

function makeLaunchUrl(raw) {
  const base = new URL(window.location.href);
  base.search = '';
  base.hash = '';
  base.searchParams.set('mode', 'display');
  base.searchParams.set('play', raw);
  return base.href;
}

function makePhoneUrl() {
  const base = new URL(window.location.href);
  base.search = '';
  base.hash = '';
  base.searchParams.set('mode', 'phone');
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
    el.addEventListener('click', () => playUrl(item.url));
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

function playUrl(raw) {
  const parsed = parseProvider(raw);
  if (!parsed.url) return;
  state.current = parsed;
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
    const iframe = document.createElement('iframe');
    iframe.allow = 'autoplay; encrypted-media; fullscreen; picture-in-picture';
    iframe.allowFullscreen = true;
    iframe.referrerPolicy = 'strict-origin-when-cross-origin';
    iframe.src = parsed.embedUrl || parsed.url;
    frame.appendChild(iframe);
    window.setTimeout(() => showChzzkAssist(parsed), 2400);
    return;
  }

  showFallback(parsed, '내장 재생을 지원하지 않는 URL입니다.');
}

function showChzzkAssist(parsed) {
  const frame = $('playerFrame');
  if (frame.querySelector('.chzzk-assist')) return;
  const bar = document.createElement('div');
  bar.className = 'chzzk-assist';
  bar.innerHTML = `
    <span>CHZZK 최대화 모드입니다. 필요하면 전체화면을 누르세요.</span>
    <button id="chzzkFullscreenBtn">전체화면</button>
    <button id="chzzkLauncherBtn">런처</button>
    <button id="chzzkHideBtn">숨김</button>
  `;
  frame.appendChild(bar);
  bar.querySelector('#chzzkFullscreenBtn').addEventListener('click', async () => {
    try {
      await $('app').requestFullscreen?.();
    } catch {
      showFallback(parsed, '이 브라우저는 자동 전체화면을 허용하지 않습니다. 아래 버튼으로 공식 페이지를 열 수 있습니다.');
    }
  });
  bar.querySelector('#chzzkLauncherBtn').addEventListener('click', resetPlayer);
  bar.querySelector('#chzzkHideBtn').addEventListener('click', () => bar.remove());
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
  if (action === 'playpause') window.postMessage({ type: 'noop' }, '*');
  renderDisplayList();
}

function seedSamples() {
  state.items = [...SAMPLE_ITEMS, ...state.items.filter((item) => !SAMPLE_ITEMS.some((sample) => sample.url === item.url))].slice(0, 40);
  persist();
  renderAll();
}

function bootFromParams() {
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
  $('analyzeBtn').addEventListener('click', analyzeInput);
  $('saveFavoriteBtn').addEventListener('click', () => saveFavorite($('urlInput').value));
  $('copyLaunchBtn').addEventListener('click', copyLaunch);
  $('openLaunchBtn').addEventListener('click', openLaunch);
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
  });
}

loadState();
bindEvents();
bootFromParams();
renderAll();
