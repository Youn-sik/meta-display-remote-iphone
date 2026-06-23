const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const PUBLIC_DIR = __dirname;
const DEFAULT_PORT = Number(process.env.PORT || 5173);
const clientsByRoom = new Map();
const latestByRoom = new Map();
const statusByRoom = new Map();
let nextMessageId = 1;

const CHZZK_CHANNEL_API_BASE = 'https://api.chzzk.naver.com/service/v3/channels';
const CHZZK_VIDEO_API_BASE = 'https://api.chzzk.naver.com/service/v3/videos';
const NAVER_VODPLAY_API_BASE = 'https://apis.naver.com/neonplayer/vodplay/v1/playback';
const CHZZK_QUALITIES = ['1080p', '720p', '480p', '360p', '144p'];

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
};

function sanitizeRoom(value) {
  const room = String(value || 'default').trim().replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 48);
  return room || 'default';
}

function isAllowedUrl(value) {
  try {
    const url = new URL(String(value || ''));
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

function sendJson(res, status, body) {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(json);
}

function sendText(res, status, text, contentType = 'text/plain; charset=utf-8') {
  res.writeHead(status, {
    'content-type': contentType,
    'cache-control': 'no-store',
  });
  res.end(text);
}

function isAllowedNaverVodManifest(value) {
  try {
    const url = new URL(String(value || ''));
    return url.protocol === 'https:' && url.hostname.endsWith('naver-vod.pstatic.net') && url.pathname.endsWith('.m3u8');
  } catch {
    return false;
  }
}

function signedVodPlaylistUrl(vodManifestUrl) {
  return `/api/chzzk/vod-playlist?src=${encodeURIComponent(vodManifestUrl)}`;
}

function rewriteVodPlaylist(text, manifestUrl) {
  const parsed = new URL(manifestUrl);
  const signature = parsed.search;
  return text.split(/(\r?\n)/).map((line) => {
    const trimmed = line.trim();
    if (!signature || !trimmed || trimmed.startsWith('#')) return line;
    const absoluteUrl = new URL(trimmed, manifestUrl);
    if (!absoluteUrl.search) absoluteUrl.search = signature;
    return absoluteUrl.href;
  }).join('');
}

async function serveSignedVodPlaylist(res, src) {
  if (!isAllowedNaverVodManifest(src)) {
    sendJson(res, 400, { ok: false, error: 'invalid_vod_manifest' });
    return;
  }
  const response = await fetch(src, {
    headers: { 'user-agent': 'Mozilla/5.0 (Meta Display Remote iPhone PoC)' },
  });
  if (!response.ok) {
    sendJson(res, 502, { ok: false, error: `vod_manifest_${response.status}` });
    return;
  }
  const text = await response.text();
  sendText(res, 200, rewriteVodPlaylist(text, src), 'application/vnd.apple.mpegurl; charset=utf-8');
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 32_000) {
        reject(new Error('body_too_large'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function parseChzzkChannelId(value) {
  const raw = String(value || '').trim();
  if (/^[a-zA-Z0-9_-]{16,80}$/.test(raw)) return raw;
  try {
    const url = new URL(raw);
    const parts = url.pathname.split('/').filter(Boolean);
    const liveIndex = parts.indexOf('live');
    const channelId = liveIndex >= 0 ? parts[liveIndex + 1] : parts.at(-1);
    return /^[a-zA-Z0-9_-]{16,80}$/.test(channelId || '') ? channelId : null;
  } catch {
    return null;
  }
}

function parseChzzkVideoNo(value) {
  const raw = String(value || '').trim();
  if (/^\d{3,20}$/.test(raw)) return raw;
  try {
    const url = new URL(raw);
    const parts = url.pathname.split('/').filter(Boolean);
    const videoIndex = parts.indexOf('video');
    const videoNo = videoIndex >= 0 ? parts[videoIndex + 1] : parts.at(-1);
    return /^\d{3,20}$/.test(videoNo || '') ? videoNo : null;
  } catch {
    return null;
  }
}

function normalizeChzzkQuality(value) {
  const quality = String(value || '480p').toLowerCase();
  return CHZZK_QUALITIES.find((item) => item.toLowerCase() === quality) || '480p';
}

function selectChzzkVariantFromList(variants, preferredQuality) {
  const sorted = [...variants].filter((variant) => variant.url).sort((a, b) => (b.height || 0) - (a.height || 0));
  const preferredHeight = Number(String(preferredQuality || '480p').replace(/p$/i, '')) || 480;
  const exact = sorted.find((variant) => variant.quality === preferredQuality);
  const atLeastPreferred = [...sorted].reverse().find((variant) => (variant.height || 0) >= preferredHeight);
  return exact || atLeastPreferred || sorted[0] || null;
}

function selectChzzkVariant(masterText, masterUrl, preferredQuality) {
  const variants = [];
  const lines = masterText.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const info = lines[index];
    if (!info.startsWith('#EXT-X-STREAM-INF')) continue;
    const uri = lines.slice(index + 1).find((line) => line && !line.startsWith('#'));
    if (!uri) continue;
    const resolution = /RESOLUTION=(\d+)x(\d+)/.exec(info);
    const bandwidth = /BANDWIDTH=(\d+)/.exec(info);
    const frameRate = /FRAME-RATE=([\d.]+)/.exec(info);
    const height = resolution ? Number(resolution[2]) : 0;
    variants.push({
      quality: height ? `${height}p` : 'unknown',
      width: resolution ? Number(resolution[1]) : null,
      height: height || null,
      bandwidth: bandwidth ? Number(bandwidth[1]) : null,
      frameRate: frameRate ? Number(frameRate[1]) : null,
      url: new URL(uri, masterUrl).href,
    });
  }
  const preferred = variants.find((variant) => variant.quality === preferredQuality);
  return { variants, selected: preferred || variants[0] || null };
}

async function fetchChzzkHlsInfo(channelId, preferredQuality) {
  const detailUrl = `${CHZZK_CHANNEL_API_BASE}/${encodeURIComponent(channelId)}/live-detail`;
  const detailResponse = await fetch(detailUrl, {
    headers: {
      accept: 'application/json',
      'user-agent': 'Mozilla/5.0 (Meta Display Remote iPhone PoC)',
      referer: `https://chzzk.naver.com/live/${encodeURIComponent(channelId)}`,
    },
  });
  if (!detailResponse.ok) throw new Error(`chzzk_detail_${detailResponse.status}`);
  const detail = await detailResponse.json();
  const content = detail.content;
  if (!content?.livePlaybackJson) throw new Error(detail.message || 'no_live_playback');
  const playback = JSON.parse(content.livePlaybackJson);
  const media = playback.media || [];
  const normalHls = media.find((item) => item.mediaId === 'HLS' && item.path);
  const fallbackHls = media.find((item) => item.protocol === 'HLS' && item.path);
  const selectedMedia = normalHls || fallbackHls;
  if (!selectedMedia?.path) throw new Error('no_hls_media');
  const masterResponse = await fetch(selectedMedia.path, {
    headers: { 'user-agent': 'Mozilla/5.0 (Meta Display Remote iPhone PoC)' },
  });
  if (!masterResponse.ok) throw new Error(`chzzk_master_${masterResponse.status}`);
  const masterText = await masterResponse.text();
  const { variants, selected } = selectChzzkVariant(masterText, selectedMedia.path, preferredQuality);
  if (!selected) throw new Error('no_hls_variant');
  return {
    title: content.liveTitle,
    status: content.status,
    channelName: content.channel?.channelName,
    channelId,
    mediaId: selectedMedia.mediaId,
    p2pQuality: content.p2pQuality || [],
    masterUrl: selectedMedia.path,
    selected,
    variants,
  };
}


async function fetchChzzkVodInfo(videoNo, preferredQuality) {
  const detailUrl = `${CHZZK_VIDEO_API_BASE}/${encodeURIComponent(videoNo)}`;
  const detailResponse = await fetch(detailUrl, {
    headers: {
      accept: 'application/json',
      'user-agent': 'Mozilla/5.0 (Meta Display Remote iPhone PoC)',
      referer: `https://chzzk.naver.com/video/${encodeURIComponent(videoNo)}`,
    },
  });
  if (!detailResponse.ok) throw new Error(`chzzk_video_detail_${detailResponse.status}`);
  const detail = await detailResponse.json();
  const content = detail.content;
  if (!content?.videoId || !content?.inKey) throw new Error(detail.message || 'no_vod_playback_key');
  if (content.adult && content.userAdultStatus !== 'ADULT') throw new Error('adult_vod_requires_login');
  if (content.blindType) throw new Error(`blocked_vod_${content.blindType}`);
  if (content.vodStatus && content.vodStatus !== 'ABR_HLS') throw new Error(`unsupported_vod_status_${content.vodStatus}`);

  const playbackUrl = `${NAVER_VODPLAY_API_BASE}/${encodeURIComponent(content.videoId)}?key=${encodeURIComponent(content.inKey)}`;
  const playbackResponse = await fetch(playbackUrl, {
    headers: {
      accept: 'application/json',
      'user-agent': 'Mozilla/5.0 (Meta Display Remote iPhone PoC)',
      referer: `https://chzzk.naver.com/video/${encodeURIComponent(videoNo)}`,
    },
  });
  if (!playbackResponse.ok) throw new Error(`naver_vodplay_${playbackResponse.status}`);
  const playback = await playbackResponse.json();
  const variants = [];
  for (const period of playback.period || []) {
    for (const adaptation of period.adaptationSet || []) {
      for (const representation of adaptation.representation || []) {
        const hlsUrl = representation.otherAttributes?.m3u;
        if (!hlsUrl) continue;
        const height = Number(representation.height) || null;
        variants.push({
          quality: height ? `${height}p` : 'unknown',
          width: Number(representation.width) || null,
          height,
          bandwidth: Number(representation.bandwidth) || null,
          frameRate: Number(representation.frameRate) || null,
          url: hlsUrl,
        });
      }
    }
  }
  const selected = selectChzzkVariantFromList(variants, preferredQuality);
  if (!selected) throw new Error('no_vod_hls_variant');
  const proxiedSelected = { ...selected, sourceUrl: selected.url, url: signedVodPlaylistUrl(selected.url) };
  return {
    title: content.videoTitle,
    status: content.vodStatus,
    channelName: content.channel?.channelName,
    videoNo: String(content.videoNo || videoNo),
    videoId: content.videoId,
    duration: Number(content.duration) || 0,
    selected: proxiedSelected,
    variants,
  };
}

function broadcast(room, event, payload) {
  const clients = clientsByRoom.get(room);
  if (!clients?.size) return 0;
  const data = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const res of clients) res.write(data);
  return clients.size;
}

function addSseClient(room, res) {
  if (!clientsByRoom.has(room)) clientsByRoom.set(room, new Set());
  const clients = clientsByRoom.get(room);
  clients.add(res);
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  res.write(`event: ready\ndata: ${JSON.stringify({ ok: true, room, at: new Date().toISOString() })}\n\n`);
  return () => {
    clients.delete(res);
    if (clients.size === 0) clientsByRoom.delete(room);
  };
}

function safeStaticPath(urlPathname) {
  const decoded = decodeURIComponent(urlPathname);
  const pathname = decoded === '/' ? '/index.html' : decoded;
  const resolved = path.resolve(PUBLIC_DIR, `.${pathname}`);
  if (!resolved.startsWith(PUBLIC_DIR)) return null;
  return resolved;
}

async function handleApi(req, res, url) {
  if (req.method === 'GET' && url.pathname === '/api/health') {
    sendJson(res, 200, { ok: true, rooms: [...new Set([...clientsByRoom.keys(), ...latestByRoom.keys(), ...statusByRoom.keys()])] });
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/api/latest') {
    const room = sanitizeRoom(url.searchParams.get('room'));
    const since = Number(url.searchParams.get('since') || 0);
    const latest = latestByRoom.get(room) || null;
    sendJson(res, 200, { ok: true, room, latest: latest && latest.id > since ? latest : null });
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/api/status') {
    const room = sanitizeRoom(url.searchParams.get('room'));
    sendJson(res, 200, { ok: true, room, status: statusByRoom.get(room) || null });
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/status') {
    try {
      const raw = await readBody(req);
      const payload = JSON.parse(raw || '{}');
      const room = sanitizeRoom(payload.room);
      const status = {
        id: nextMessageId++,
        room,
        provider: String(payload.provider || 'none').slice(0, 24),
        title: String(payload.title || '').slice(0, 160),
        url: String(payload.url || '').slice(0, 2048),
        paused: Boolean(payload.paused),
        currentTime: Number.isFinite(Number(payload.currentTime)) ? Number(payload.currentTime) : 0,
        duration: Number.isFinite(Number(payload.duration)) ? Number(payload.duration) : 0,
        seekableStart: Number.isFinite(Number(payload.seekableStart)) ? Number(payload.seekableStart) : 0,
        seekableEnd: Number.isFinite(Number(payload.seekableEnd)) ? Number(payload.seekableEnd) : 0,
        isLive: Boolean(payload.isLive),
        canSeek: Boolean(payload.canSeek),
        at: new Date().toISOString(),
      };
      statusByRoom.set(room, status);
      broadcast(room, 'status', status);
      sendJson(res, 200, { ok: true, room, status });
    } catch (error) {
      sendJson(res, 400, { ok: false, error: error.message || 'bad_request' });
    }
    return true;
  }


  if (req.method === 'GET' && url.pathname === '/api/chzzk/vod-playlist') {
    try {
      await serveSignedVodPlaylist(res, url.searchParams.get('src'));
    } catch (error) {
      sendJson(res, 502, { ok: false, error: error.message || 'vod_playlist_failed' });
    }
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/api/chzzk/live') {
    try {
      const channelId = parseChzzkChannelId(url.searchParams.get('channel') || url.searchParams.get('url'));
      if (!channelId) {
        sendJson(res, 400, { ok: false, error: 'invalid_chzzk_channel' });
        return true;
      }
      const quality = normalizeChzzkQuality(url.searchParams.get('quality'));
      const info = await fetchChzzkHlsInfo(channelId, quality);
      sendJson(res, 200, { ok: true, requestedQuality: quality, ...info });
    } catch (error) {
      sendJson(res, 502, { ok: false, error: error.message || 'chzzk_live_failed' });
    }
    return true;
  }


  if (req.method === 'GET' && url.pathname === '/api/chzzk/video') {
    try {
      const videoNo = parseChzzkVideoNo(url.searchParams.get('video') || url.searchParams.get('url'));
      if (!videoNo) {
        sendJson(res, 400, { ok: false, error: 'invalid_chzzk_video' });
        return true;
      }
      const quality = normalizeChzzkQuality(url.searchParams.get('quality'));
      const info = await fetchChzzkVodInfo(videoNo, quality);
      sendJson(res, 200, { ok: true, requestedQuality: quality, ...info });
    } catch (error) {
      sendJson(res, 502, { ok: false, error: error.message || 'chzzk_video_failed' });
    }
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/api/events') {
    if (url.searchParams.get('sse') !== '1') {
      res.writeHead(204, { 'cache-control': 'no-store' });
      res.end();
      return true;
    }
    const room = sanitizeRoom(url.searchParams.get('room'));
    const remove = addSseClient(room, res);
    req.on('close', remove);
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/push') {
    try {
      const raw = await readBody(req);
      const payload = JSON.parse(raw || '{}');
      const room = sanitizeRoom(payload.room);
      const videoUrl = String(payload.url || '').trim();
      if (!isAllowedUrl(videoUrl)) {
        sendJson(res, 400, { ok: false, error: 'invalid_url' });
        return true;
      }
      const message = { id: nextMessageId++, url: videoUrl, room, at: new Date().toISOString() };
      latestByRoom.set(room, message);
      const delivered = broadcast(room, 'play', message);
      sendJson(res, 200, { ok: true, room, delivered, message });
    } catch (error) {
      sendJson(res, 400, { ok: false, error: error.message || 'bad_request' });
    }
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/control') {
    try {
      const raw = await readBody(req);
      const payload = JSON.parse(raw || '{}');
      const room = sanitizeRoom(payload.room);
      const action = String(payload.action || '').trim();
      const allowed = new Set(['playpause', 'play', 'pause', 'back', 'quality:480p', 'quality:720p', 'official', 'direct']);
      const isSeek = /^seek:\d+(?:\.\d+)?$/.test(action);
      if (!allowed.has(action) && !isSeek) {
        sendJson(res, 400, { ok: false, error: 'invalid_action' });
        return true;
      }
      const message = { id: nextMessageId++, type: 'control', action, room, at: new Date().toISOString() };
      latestByRoom.set(room, message);
      const delivered = broadcast(room, 'control', message);
      sendJson(res, 200, { ok: true, room, delivered, message });
    } catch (error) {
      sendJson(res, 400, { ok: false, error: error.message || 'bad_request' });
    }
    return true;
  }

  return false;
}

function serveStatic(req, res, url) {
  const filePath = safeStaticPath(url.pathname);
  if (!filePath) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  fs.stat(filePath, (statError, stat) => {
    if (statError || !stat.isFile()) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'content-type': MIME_TYPES[ext] || 'application/octet-stream',
      'cache-control': 'no-store',
    });
    fs.createReadStream(filePath).pipe(res);
  });
}

function createServer() {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (await handleApi(req, res, url)) return;
    serveStatic(req, res, url);
  });
}

if (require.main === module) {
  const server = createServer();
  server.listen(DEFAULT_PORT, '::', () => {
    console.log(`Serving static app and relay on http://localhost:${DEFAULT_PORT}`);
  });
}

module.exports = { createServer, sanitizeRoom, isAllowedUrl, broadcast, clientsByRoom, latestByRoom, statusByRoom };
