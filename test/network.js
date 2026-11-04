'use strict';

// Isolate the request/job functions so faults can be tested without API keys or paid calls.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const frontend = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
const backend = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
const fastTimers = {
  setTimeout(fn, delay) { if (delay < 30000) queueMicrotask(fn); return 1; },
  clearTimeout() {}
};
function client(fetch) {
  const ctx = vm.createContext({ fetch, AbortController, ...fastTimers });
  vm.runInContext(frontend.slice(frontend.indexOf('async function api('), frontend.indexOf('\nconst esc =')), ctx);
  return ctx;
}
const response = (status, data) => ({ ok: status >= 200 && status < 300, status, json: async () => data });

test('GET recovers from a failed fetch and a proxy 503', async () => {
  let calls = 0;
  const ctx = client(async () => {
    calls++;
    if (calls === 1) throw new TypeError('fetch failed');
    return calls === 2 ? response(503, {}) : response(200, { status: 'done' });
  });
  assert.equal((await ctx.api('/api/jobs/job')).status, 'done');
  assert.equal(calls, 3);
});

test('GET retries a proxy HTML 502, but not an HTML 401', async () => {
  for (const status of [502, 401]) {
    let calls = 0;
    const ctx = client(async () => {
      calls++;
      return { status, ok: false, json: async () => { throw new SyntaxError('HTML'); } };
    });
    await assert.rejects(ctx.api('/api/jobs/job'), new RegExp(String(status)));
    assert.equal(calls, status === 502 ? 3 : 1);
  }
});

test('POST is never replayed after a lost response', async () => {
  let calls = 0;
  const ctx = client(async () => { calls++; throw new TypeError('fetch failed'); });
  await assert.rejects(ctx.api('/api/generate', { method: 'POST' }), /请求可能已提交/);
  assert.equal(calls, 1);
});

test('request timeout aborts the fetch and stops after three GET attempts', async () => {
  let calls = 0;
  const ctx = client(async (url, opts) => {
    calls++;
    return new Promise((resolve, reject) => opts.signal.addEventListener('abort', () => reject(new Error('aborted'))));
  });
  ctx.setTimeout = (fn) => { queueMicrotask(fn); return 1; };
  await assert.rejects(ctx.api('/api/jobs/job'), /超时/);
  assert.equal(calls, 3);
});

function pollContext(api) {
  const saved = [];
  const ctx = vm.createContext({ api, Date, ...fastTimers, saveLastResult: (w) => saved.push(w), renderResult() {}, timeAgo: () => '', esc: String });
  vm.runInContext(frontend.slice(frontend.indexOf('async function pollJob('), frontend.indexOf('/* ---------------- 资产')), ctx);
  return { ctx, saved };
}

test('job polling continues after a temporary outage and saves the completed result', async () => {
  let calls = 0;
  const { ctx, saved } = pollContext(async () => {
    calls++;
    if (calls <= 2) throw Object.assign(new Error('network'), { retryable: true });
    return { status: 'done', images: ['/img/test.png'] };
  });
  await ctx.pollJob('job', {}, Date.now());
  assert.equal(calls, 3);
  assert.equal(saved[0].images[0], '/img/test.png');
});

test('persistent polling failure gives background-job guidance; authorization errors stop immediately', async () => {
  for (const retryable of [true, false]) {
    let calls = 0;
    const { ctx } = pollContext(async () => { calls++; throw Object.assign(new Error('unauthorized'), { retryable }); });
    await assert.rejects(ctx.pollJob('job', {}, Date.now()), retryable ? /后台运行/ : /unauthorized/);
    assert.equal(calls, retryable ? 5 : 1);
  }
});

test('an aborted upstream response rejects instead of leaving the job hanging', async () => {
  const req = new EventEmitter();
  req.write = () => {};
  req.end = () => {};
  const ctx = vm.createContext({ Buffer, URL, https: { request(opts, callback) {
    queueMicrotask(() => { const res = new EventEmitter(); callback(res); res.emit('aborted'); res.emit('error', new Error('reset')); });
    return req;
  } } });
  vm.runInContext(backend.slice(backend.indexOf('function upstreamRequest('), backend.indexOf('function dataURLParts(')), ctx);
  await assert.rejects(ctx.upstreamRequest('https://example.com', '/v1/images/generations', {}, 'test-key', false), /response aborted/);
});

test('upstream fetch failed is explained and not replayed automatically', async () => {
  let calls = 0;
  const job = { id: 'job', apiKey: 'test-key', status: 'pending' };
  const logs = [];
  const ctx = vm.createContext({
    jobs: new Map([['job', job]]), now: Date.now, ...fastTimers,
    console: { error() {} },
    callGenerate: async () => { calls++; throw new Error('fetch failed'); },
    logWork: (work) => logs.push(work)
  });
  vm.runInContext(backend.slice(backend.indexOf('async function runJob('), backend.indexOf('/* ---------------- 静态文件')), ctx);
  await ctx.runJob('job');
  assert.equal(calls, 1);
  assert.equal(job.status, 'error');
  assert.match(job.error, /上游服务报告网络连接失败/);
  assert.equal(logs[0].error, job.error);
  assert.equal(job.apiKey, null);
});
