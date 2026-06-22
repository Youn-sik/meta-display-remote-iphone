const assert = require('node:assert/strict');
const test = require('node:test');
const { createServer, sanitizeRoom, isAllowedUrl } = require('../server');

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
