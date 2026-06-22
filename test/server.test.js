const assert = require('node:assert/strict');
const test = require('node:test');
const { createServer, sanitizeRoom, isAllowedUrl } = require('../server');

const liveDetailFixture = {
  code: 200,
  message: null,
  content: {
    liveTitle: 'fixture live',
    status: 'OPEN',
    channel: { channelName: 'fixture channel' },
    p2pQuality: ['720p', '1080p'],
    livePlaybackJson: JSON.stringify({
      media: [
        {
          mediaId: 'HLS',
          protocol: 'HLS',
          path: 'https://example.test/master.m3u8',
        },
      ],
    }),
  },
};

const masterPlaylistFixture = `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=3192000,CODECS="avc1.640028,mp4a.40.2",RESOLUTION=1280x720,FRAME-RATE=60.00
720p/chunklist.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=1692000,CODECS="avc1.4D001F,mp4a.40.2",RESOLUTION=852x480,FRAME-RATE=30.00
480p/chunklist.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=696000,CODECS="avc1.4D001E,mp4a.40.2",RESOLUTION=640x360,FRAME-RATE=30.00
360p/chunklist.m3u8`;

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

test('sanitizeRoom keeps only safe room characters', () => {
  assert.equal(sanitizeRoom(' team-1_room '), 'team-1_room');
  assert.equal(sanitizeRoom('../../bad room'), 'badroom');
  assert.equal(sanitizeRoom(''), 'default');
});

test('isAllowedUrl accepts only http/https URLs', () => {
  assert.equal(isAllowedUrl('https://www.youtube.com/watch?v=aqz-KE-bpKQ'), true);
  assert.equal(isAllowedUrl('https://chzzk.naver.com/live/b1099827eb54bab6771bae5c85e887b7'), true);
  assert.equal(isAllowedUrl('javascript:alert(1)'), false);
  assert.equal(isAllowedUrl('not a url'), false);
});

test('GET /api/chzzk/live selects requested HLS quality', async (t) => {
  const originalFetch = global.fetch;
  t.after(() => {
    global.fetch = originalFetch;
  });
  global.fetch = async (url, options) => {
    const href = String(url);
    if (href.startsWith('http://127.0.0.1:')) return originalFetch(url, options);
    if (href.includes('/live-detail')) {
      return Response.json(liveDetailFixture);
    }
    if (href === 'https://example.test/master.m3u8') {
      return new Response(masterPlaylistFixture, { status: 200 });
    }
    throw new Error(`unexpected fetch ${href}`);
  };

  const server = createServer();
  const port = await listen(server);
  t.after(() => server.close());

  const response = await fetch(`http://127.0.0.1:${port}/api/chzzk/live?channel=https%3A%2F%2Fchzzk.naver.com%2Flive%2Fb1099827eb54bab6771bae5c85e887b7&quality=480p`);
  const result = await response.json();
  assert.equal(response.status, 200);
  assert.equal(result.ok, true);
  assert.equal(result.requestedQuality, '480p');
  assert.equal(result.selected.quality, '480p');
  assert.equal(result.selected.height, 480);
  assert.equal(result.selected.bandwidth, 1692000);
  assert.equal(result.selected.url, 'https://example.test/480p/chunklist.m3u8');
  assert.deepEqual(result.variants.map((variant) => variant.quality), ['720p', '480p', '360p']);
});

test('POST /api/push delivers play event to SSE display client', async (t) => {
  const server = createServer();
  const port = await listen(server);
  t.after(() => server.close());

  const room = `testroom_${Date.now()}`;
  const received = new Promise((resolve, reject) => {
    const req = fetch(`http://127.0.0.1:${port}/api/events?room=${room}`);
    req.then(async (response) => {
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      const timer = setTimeout(() => reject(new Error('timeout waiting for play event')), 2500);
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const match = buffer.match(/event: play\ndata: (.+?)\n\n/s);
        if (match) {
          clearTimeout(timer);
          await reader.cancel();
          resolve(JSON.parse(match[1]));
          break;
        }
      }
    }).catch(reject);
  });

  await new Promise((resolve) => setTimeout(resolve, 100));
  const videoUrl = 'https://www.youtube.com/watch?v=aqz-KE-bpKQ';
  const response = await fetch(`http://127.0.0.1:${port}/api/push`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ room, url: videoUrl }),
  });
  const result = await response.json();
  assert.equal(result.ok, true);
  assert.equal(result.delivered, 1);
  assert.ok(result.message.id > 0);

  const latestResponse = await fetch(`http://127.0.0.1:${port}/api/latest?room=${room}&since=0`);
  const latestResult = await latestResponse.json();
  assert.equal(latestResult.ok, true);
  assert.equal(latestResult.latest.url, videoUrl);
  assert.equal(latestResult.latest.id, result.message.id);

  const noNewResponse = await fetch(`http://127.0.0.1:${port}/api/latest?room=${room}&since=${result.message.id}`);
  const noNewResult = await noNewResponse.json();
  assert.equal(noNewResult.latest, null);

  const event = await received;
  assert.equal(event.url, videoUrl);
  assert.equal(event.room, room);
  assert.equal(event.id, result.message.id);
});
