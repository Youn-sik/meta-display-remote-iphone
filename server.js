const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const PUBLIC_DIR = __dirname;
const DEFAULT_PORT = Number(process.env.PORT || 5173);
const clientsByRoom = new Map();
const latestByRoom = new Map();
let nextMessageId = 1;

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
    sendJson(res, 200, { ok: true, rooms: [...new Set([...clientsByRoom.keys(), ...latestByRoom.keys()])] });
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/api/latest') {
    const room = sanitizeRoom(url.searchParams.get('room'));
    const since = Number(url.searchParams.get('since') || 0);
    const latest = latestByRoom.get(room) || null;
    sendJson(res, 200, { ok: true, room, latest: latest && latest.id > since ? latest : null });
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/api/events') {
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

module.exports = { createServer, sanitizeRoom, isAllowedUrl, broadcast, clientsByRoom, latestByRoom };
