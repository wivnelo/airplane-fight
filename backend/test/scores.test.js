const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ScoreClient } = require('../../frontend/scores');
const response = (status, data = {}) => ({ ok: status < 400, status, json: async () => data });
const readyRun = (runId) => ({ ready: Promise.resolve(), credentials: { runId, token: 'a'.repeat(64) } });

test('a second game finishing during the first POST is sent, not discarded', async t => {
  const original = global.fetch; t.after(() => { global.fetch = original; });
  const sent = []; let release;
  global.fetch = async (url, opts) => {
    sent.push(JSON.parse(opts.body).score);
    if (sent.length === 1) await new Promise(r => { release = r; });
    return response(201);
  };
  const client = new ScoreClient('/queue-test');
  const first = client.finish(readyRun('one'), 10, 1000);
  await new Promise(r => setImmediate(r));
  await client.finish(readyRun('two'), 20, 2000);
  assert.deepEqual(sent, [10]); release(); await first;
  await new Promise(r => setImmediate(r));
  assert.deepEqual(sent, [10, 20]); assert.equal(client.pending.length, 0);
});
test('failed request persists for reload, retry keeps same run payload', async t => {
  const original = global.fetch; const storage = global.localStorage;
  const data = new Map(); global.localStorage = { getItem: k => data.get(k), setItem: (k,v) => data.set(k,v) };
  t.after(() => { global.fetch = original; if(storage) global.localStorage=storage; else delete global.localStorage; });
  const payloads = [];
  global.fetch = async (url, opts) => { payloads.push(opts.body); return response(503); };
  const client = new ScoreClient('/persistent-test');
  await client.finish(readyRun('one'), 1, 1000);
  assert.equal(client.pending.length, 1);
  const reloaded = new ScoreClient('/persistent-test'); assert.equal(reloaded.pending.length, 1);
  global.fetch = async (url, opts) => { payloads.push(opts.body); return response(200); };
  await reloaded.flush(); assert.equal(reloaded.pending.length, 0);
  assert.equal(payloads[0], payloads[1]);
});
test('credential failure keeps offline game possible without sending unchecked score', async t => {
  const original = global.fetch; t.after(() => { global.fetch = original; });
  const calls = []; const statuses = [];
  global.fetch = async url => { calls.push(url); throw new Error('offline'); };
  const client = new ScoreClient('/offline-test', m => statuses.push(m));
  const run = client.begin(); await client.finish(run, 2, 1000);
  assert.deepEqual(calls, ['/offline-test/runs']); assert.equal(client.pending.length, 0);
  assert.ok(statuses.some(m => m.includes('未同步')));
});
test('blocked browser storage leaves a visible loss warning on retry failure', async t => {
  const original=global.fetch, storage=global.localStorage;
  t.after(() => {global.fetch=original;if(storage)global.localStorage=storage;else delete global.localStorage;});
  global.localStorage={getItem:()=>null,setItem:()=>{throw new Error('quota');}};
  global.fetch=async()=>response(503);
  const statuses=[];const client=new ScoreClient('/blocked',m=>statuses.push(m));
  await client.finish(readyRun('one'),1,1000);
  assert.equal(client.pending.length,1);
  assert.match(statuses.at(-1),/关闭页面会丢失/);
});
