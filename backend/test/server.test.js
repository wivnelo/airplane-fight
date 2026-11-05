const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../server');
const { LeaderboardStore } = require('../store');
async function fixture(t, options = {}) {
  const ownDir = fs.mkdtempSync(path.join(os.tmpdir(), 'airplane-test-'));
  const dataDir = options.dataDir || ownDir;
  const app = createApp({ dataDir, rateLimit: 1000, ...options });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { await new Promise(r => server.close(r)); app.locals.close(); fs.rmSync(ownDir, { recursive: true, force: true }); });
  async function request(route, body, headers = {}) {
    const r = await fetch(base + route, { method: body === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text(); let data;
    try { data = JSON.parse(text); } catch { data = text; }
    return { status: r.status, data, headers: r.headers };
  }
  return { dataDir, app, base, request };
}
test('serves game, creates runs, retries idempotently and persists best score', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('/')).status, 200);
  assert.equal((await f.request('/health')).data.storage, 'ready');
  const run = (await f.request('/api/runs', {})).data;
  const body = { ...run, score: 3, durationMs: 0 };
  assert.equal((await f.request('/api/leaderboard', body)).status, 201);
  const again = await f.request('/api/leaderboard', body);
  assert.equal(again.status, 200); assert.equal(again.data.duplicate, true);
  assert.equal((await f.request('/api/leaderboard', { ...body, score: 2 })).status, 409);
  const lower = (await f.request('/api/runs', {})).data;
  await f.request('/api/leaderboard', { ...lower, score: 1, durationMs: 0 });
  assert.equal((await f.request('/api/leaderboard')).data.entries[0].score, 3);
  const reopened = new LeaderboardStore(f.dataDir);
  assert.equal(reopened.list()[0].score, 3); reopened.close();
});
test('20 concurrent valid submissions all remain saved', async t => {
  const { request } = await fixture(t);
  const runs = await Promise.all(Array.from({ length: 20 }, async (_, i) => ({
    headers: { 'User-Agent': `browser-${i}` },
    run: (await request('/api/runs', {}, { 'User-Agent': `browser-${i}` })).data,
  })));
  const results = await Promise.all(runs.map(({ run, headers }) => request('/api/leaderboard', { ...run, score: 1, durationMs: 0 }, headers)));
  assert.ok(results.every(r => r.status === 201));
  assert.equal((await request('/api/leaderboard')).data.entries.length, 20);
});
test('strict scores, credentials, time bounds and no forwarding-header identity spoof', async t => {
  const { request } = await fixture(t);
  assert.equal((await request('/api/leaderboard', { score: 999999999999 })).status, 400);
  const run = (await request('/api/runs', {})).data;
  for (const score of [null, true, '', '2', -1, 1.1, Number.MAX_SAFE_INTEGER + 1])
    assert.equal((await request('/api/leaderboard', { ...run, score, durationMs: 0 })).status, 400);
  for (const [score, durationMs] of [[999999999999, 0], [1, 600000]])
    assert.equal((await request('/api/leaderboard', { ...run, score, durationMs })).status, 422);
  assert.equal((await request('/api/leaderboard', { ...run, token: '0'.repeat(64), score: 1, durationMs: 0 })).status, 403);
  assert.equal((await request('/api/leaderboard', { ...run, score: 1, durationMs: 0 }, { 'User-Agent': 'other' })).status, 403);
  for (const ip of ['198.51.100.1', '198.51.100.2']) {
    const credentials = (await request('/api/runs', {}, { 'X-Forwarded-For': ip })).data;
    assert.equal((await request('/api/leaderboard', { ...credentials, score: 1, durationMs: 0 }, { 'X-Forwarded-For': ip })).status, 201);
  }
  assert.equal((await request('/api/leaderboard')).data.entries.length, 1);
});
test('origin and per-IP rate limits', async t => {
  const { request, base } = await fixture(t, { rateLimit: 2 });
  assert.equal((await request('/api/runs', {}, { Origin: 'https://untrusted.example' })).status, 403);
  assert.equal((await request('/api/runs', {}, { Origin: base })).status, 201);
  assert.equal((await request('/api/runs', {}, { 'X-Forwarded-For': 'one' })).status, 201);
  const result = await request('/api/runs', {}, { 'X-Forwarded-For': 'two' });
  assert.equal(result.status, 429); assert.ok(result.headers.get('retry-after'));
});
test('legacy import is read-only, one-time; rollback preserves old scores and retries', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'airplane-legacy-'));
  const source = path.join(dir, 'leaderboard.json');
  const legacy = JSON.stringify([{ id: 'old', fingerprint: 'old', name: '玩家', score: 1711, playedAt: '2025-10-23T12:00:00Z' }]);
  fs.writeFileSync(source, legacy); let store;
  try {
    store = new LeaderboardStore(dir); assert.equal(store.list()[0].score, 1711);
    assert.equal(fs.readFileSync(source, 'utf8'), legacy);
    const run = store.createRun({ fingerprint: 'new', displayName: '新' });
    store.db.exec("CREATE TRIGGER reject_receipt BEFORE UPDATE ON runs BEGIN SELECT RAISE(ABORT,'simulated write failure'); END;");
    assert.throws(() => store.submit({ ...run, score: 1, durationMs: 0 }, { fingerprint: 'new' }));
    assert.equal(store.list().length, 1);
    store.db.exec('DROP TRIGGER reject_receipt');
    assert.equal(store.submit({ ...run, score: 1, durationMs: 0 }, { fingerprint: 'new' }).entry.score, 1);
    store.close(); store = null; fs.writeFileSync(source, 'broken after import');
    store = new LeaderboardStore(dir); assert.equal(store.list().length, 2);
  } finally { store?.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
test('corrupt source: health/API fail closed while game stays available', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'airplane-corrupt-'));
  fs.writeFileSync(path.join(dir, 'leaderboard.json'), '{broken');
  const { request } = await fixture(t, { dataDir: dir });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const route of ['/health', '/api/leaderboard']) assert.equal((await request(route)).status, 503);
  assert.equal((await request('/api/runs', {})).status, 503);
  assert.equal((await request('/')).status, 200);
  assert.equal(fs.readFileSync(path.join(dir, 'leaderboard.json'), 'utf8'), '{broken');
});
test('bad/oversized bodies do not crash API', async t => {
  const { base, request } = await fixture(t);
  assert.equal((await fetch(base + '/api/leaderboard', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{bad' })).status, 400);
  assert.equal((await request('/api/runs', { padding: 'x'.repeat(9000) })).status, 413);
  assert.equal((await request('/health')).status, 200);
});
test('API write failure rolls back, returns 503 and allows an identical retry', async t => {
  const { dataDir, request } = await fixture(t);
  const injector = new LeaderboardStore(dataDir);
  t.after(() => injector.close());
  const run = (await request('/api/runs', {})).data;
  const body = { ...run, score: 1, durationMs: 0 };
  injector.db.exec("CREATE TRIGGER reject_write BEFORE INSERT ON entries BEGIN SELECT RAISE(ABORT,'simulated failure'); END;");
  assert.equal((await request('/api/leaderboard', body)).status, 503);
  assert.equal((await request('/health')).status, 200);
  assert.equal((await request('/api/leaderboard')).data.entries.length, 0);
  injector.db.exec('DROP TRIGGER reject_write');
  assert.equal((await request('/api/leaderboard', body)).status, 201);
});
test('separate processes share transactions without losing scores', async () => {
  const { spawn } = require('node:child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'airplane-processes-'));
  const modulePath = require.resolve('../store');
  const worker = `const {LeaderboardStore}=require(process.argv[1]);
    const s=new LeaderboardStore(process.argv[2]);
    for(let i=0;i<5;i++) {const who={fingerprint:process.argv[3]+'-'+i,displayName:'test'};
      const run=s.createRun(who);s.submit({...run,score:1,durationMs:0},who);}
    s.close();`;
  try {
    await Promise.all(Array.from({ length: 4 }, (_, i) => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['-e', worker, modulePath, dir, String(i)]);
      let errors=''; child.stderr.on('data', d => { errors += d; });
      child.once('error', reject);
      child.once('exit', code => code === 0 ? resolve() : reject(new Error(errors)));
    })));
    const check = new LeaderboardStore(dir);
    try { assert.equal(check.list().length, 20); } finally { check.close(); }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test('expired run is rejected without writing a score', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'airplane-expired-'));
  const store = new LeaderboardStore(dir);
  try {
    const who={ fingerprint:'test',displayName:'test' };
    const run=store.createRun(who, 1000);
    assert.throws(() => store.submit({...run,score:1,durationMs:0},who, run.expiresAt+1), { status:410 });
    assert.equal(store.list().length, 0);
  } finally { store.close(); fs.rmSync(dir,{recursive:true,force:true}); }
});
