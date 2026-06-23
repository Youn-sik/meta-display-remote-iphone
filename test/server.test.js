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


const vodDetailFixture = {
  code: 200,
  message: null,
  content: {
    videoNo: 11835187,
    videoId: 'E31870E0C86CE538BB848BCD56F24A4E0B38',
    videoTitle: 'fixture vod',
    duration: 345,
    adult: false,
    blindType: null,
    vodStatus: 'ABR_HLS',
    inKey: 'fixture-key',
    channel: { channelName: 'fixture channel' },
  },
};

const vodPlaybackFixture = {
  period: [
    {
      adaptationSet: [
        {
          mimeType: 'video/mp2t',
          representation: [
            {
              id: 'vod-1080',
              width: 1920,
              height: 1080,
              bandwidth: 8203000,
              frameRate: '30',
              otherAttributes: { m3u: 'https://example.test/vod/1080.m3u8' },
            },
            {
              id: 'vod-144',
              width: 256,
              height: 144,
              bandwidth: 173000,
              frameRate: '30',
              otherAttributes: { m3u: 'https://example.test/vod/144.m3u8' },
            },
            {
              id: 'vod-720',
              width: 1280,
              height: 720,
              bandwidth: 3202000,
              frameRate: '30',
              otherAttributes: { m3u: 'https://example.test/vod/720.m3u8' },
            },
          ],
        },
      ],
    },
  ],
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

async function readSseEvent(responsePromise, eventName) {
  const response = await responsePromise;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const match = buffer.match(new RegExp(`event: ${eventName}\\ndata: (.+?)\\n\\n`, 's'));
    if (match) {
      await reader.cancel();
      return JSON.parse(match[1]);
    }
  }
  throw new Error(`missing ${eventName} event`);
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



test('GET /api/chzzk/video resolves VOD HLS and falls 480p request back to 720p', async (t) => {
  const originalFetch = global.fetch;
  t.after(() => {
    global.fetch = originalFetch;
  });
  global.fetch = async (url, options) => {
    const href = String(url);
    if (href.startsWith('http://127.0.0.1:')) return originalFetch(url, options);
    if (href.includes('/service/v3/videos/11835187')) {
      return Response.json(vodDetailFixture);
    }
    if (href.includes('/neonplayer/vodplay/v1/playback/E31870E0C86CE538BB848BCD56F24A4E0B38')) {
      return Response.json(vodPlaybackFixture);
    }
    throw new Error(`unexpected fetch ${href}`);
  };

  const server = createServer();
  const port = await listen(server);
  t.after(() => server.close());

  const response = await fetch(`http://127.0.0.1:${port}/api/chzzk/video?video=https%3A%2F%2Fchzzk.naver.com%2Fvideo%2F11835187&quality=480p`);
  const result = await response.json();
  assert.equal(response.status, 200);
  assert.equal(result.ok, true);
  assert.equal(result.requestedQuality, '480p');
  assert.equal(result.title, 'fixture vod');
  assert.equal(result.duration, 345);
  assert.equal(result.selected.quality, '720p');
  assert.equal(result.selected.sourceUrl, 'https://example.test/vod/720.m3u8');
  assert.equal(result.selected.url, '/api/chzzk/vod-playlist?src=https%3A%2F%2Fexample.test%2Fvod%2F720.m3u8');
  assert.deepEqual(result.variants.map((variant) => variant.quality), ['1080p', '144p', '720p']);
});


test('GET /api/chzzk/vod-playlist appends manifest signature query to VOD segments', async (t) => {
  const originalFetch = global.fetch;
  t.after(() => {
    global.fetch = originalFetch;
  });
  global.fetch = async (url, options) => {
    const href = String(url);
    if (href.startsWith('http://127.0.0.1:')) return originalFetch(url, options);
    if (href === 'https://b01-kr-naver-vod.pstatic.net/vod/720.m3u8?token=signed') {
      return new Response('#EXTM3U\n#EXTINF:4,\nseg-000.ts\n#EXTINF:4,\nseg-001.ts?already=1\n#EXT-X-ENDLIST\n', { status: 200 });
    }
    throw new Error(`unexpected fetch ${href}`);
  };

  const server = createServer();
  const port = await listen(server);
  t.after(() => server.close());

  const src = encodeURIComponent('https://b01-kr-naver-vod.pstatic.net/vod/720.m3u8?token=signed');
  const response = await fetch(`http://127.0.0.1:${port}/api/chzzk/vod-playlist?src=${src}`);
  const text = await response.text();
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /application\/vnd\.apple\.mpegurl/);
  assert.match(text, /https:\/\/b01-kr-naver-vod\.pstatic\.net\/vod\/seg-000\.ts\?token=signed/);
  assert.match(text, /https:\/\/b01-kr-naver-vod\.pstatic\.net\/vod\/seg-001\.ts\?already=1/);
});

test('GET /api/events without sse=1 returns 204 so old EventSource clients stop reconnecting', async (t) => {
  const server = createServer();
  const port = await listen(server);
  t.after(() => server.close());

  const response = await fetch(`http://127.0.0.1:${port}/api/events?room=legacy`);
  assert.equal(response.status, 204);
});

test('POST /api/push delivers play event to SSE display client', async (t) => {
  const server = createServer();
  const port = await listen(server);
  t.after(() => server.close());

  const room = `testroom_${Date.now()}`;
  const received = readSseEvent(fetch(`http://127.0.0.1:${port}/api/events?room=${room}&sse=1`), 'play');

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

test('POST /api/control is available through SSE and polling latest', async (t) => {
  const server = createServer();
  const port = await listen(server);
  t.after(() => server.close());

  const room = `control_${Date.now()}`;
  const received = readSseEvent(fetch(`http://127.0.0.1:${port}/api/events?room=${room}&sse=1`), 'control');

  await new Promise((resolve) => setTimeout(resolve, 100));
  const response = await fetch(`http://127.0.0.1:${port}/api/control`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ room, action: 'seek:30.5' }),
  });
  const result = await response.json();
  assert.equal(result.ok, true);
  assert.equal(result.delivered, 1);

  const event = await received;
  assert.equal(event.action, 'seek:30.5');
  assert.equal(event.type, 'control');
  assert.equal(event.room, room);

  const latestResponse = await fetch(`http://127.0.0.1:${port}/api/latest?room=${room}&since=0`);
  const latestResult = await latestResponse.json();
  assert.equal(latestResult.ok, true);
  assert.equal(latestResult.latest.action, 'seek:30.5');
  assert.equal(latestResult.latest.type, 'control');
  assert.equal(latestResult.latest.id, result.message.id);
});

test('POST /api/status stores playback timeline status and broadcasts it', async (t) => {
  const server = createServer();
  const port = await listen(server);
  t.after(() => server.close());

  const room = `status_${Date.now()}`;
  const received = readSseEvent(fetch(`http://127.0.0.1:${port}/api/events?room=${room}&sse=1`), 'status');

  await new Promise((resolve) => setTimeout(resolve, 100));
  const response = await fetch(`http://127.0.0.1:${port}/api/status`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      room,
      provider: 'youtube',
      title: 'fixture video',
      url: 'https://www.youtube.com/watch?v=aqz-KE-bpKQ',
      paused: false,
      currentTime: 42.25,
      duration: 635,
      seekableStart: 0,
      seekableEnd: 635,
      isLive: false,
      canSeek: true,
    }),
  });
  const result = await response.json();
  assert.equal(result.ok, true);
  assert.equal(result.status.provider, 'youtube');
  assert.equal(result.status.currentTime, 42.25);
  assert.equal(result.status.canSeek, true);

  const latestResponse = await fetch(`http://127.0.0.1:${port}/api/status?room=${room}`);
  const latestResult = await latestResponse.json();
  assert.equal(latestResult.ok, true);
  assert.equal(latestResult.status.title, 'fixture video');
  assert.equal(latestResult.status.seekableEnd, 635);

  const event = await received;
  assert.equal(event.room, room);
  assert.equal(event.title, 'fixture video');
  assert.equal(event.paused, false);
});
