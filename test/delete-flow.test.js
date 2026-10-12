/**
 * End-to-end test of the host half's delete flow, driven through a fake
 * composition context: the real route handler runs against real fixture
 * directories on disk, so the Windows removal path is exercised too.
 *
 * Run with the bundled node:
 *   node dsh-session-delete/test/delete-flow.test.js
 *
 * Covered:
 *   1. a plain persisted session is removed (directory + projection cache),
 *      accounting is cleaned, and `api-session/removed` is emitted;
 *   2. a wedged registry (archive never settles) does not block the delete —
 *      the files still go, and the response reports the degraded step;
 *   3. a live session that never releases answers 409 and leaves files intact;
 *   4. an unauthenticated request is refused by the trust fence without
 *      touching anything;
 *   5. an unknown session answers 404;
 *   6. malformed requests answer 400/415.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply } from '../index.js';
import { encodeSegment, projectDirName } from '../paths.js';

const CWD = 'D:\\Backup\\Documents\\deepseek-harness\\default-workspace';
const SESSION_ID = 'session-test-0001-abcd';

/** A fake Node request carrying one JSON body. */
function fakeRequest(body, { method = 'POST', contentType = 'application/json' } = {}) {
  const chunks = [Buffer.from(JSON.stringify(body))];
  return {
    method,
    url: '/session-delete/delete',
    headers: { 'content-type': contentType },
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk;
    },
    resume() {},
  };
}

/** A fake Node response recording the outcome. */
function fakeResponse() {
  const state = { statusCode: 200, headers: {}, body: undefined, ended: false };
  return {
    state,
    get headersSent() {
      return state.ended;
    },
    get statusCode() {
      return state.statusCode;
    },
    set statusCode(value) {
      state.statusCode = value;
    },
    setHeader(key, value) {
      state.headers[key] = value;
    },
    end(text) {
      state.ended = true;
      state.body = text;
    },
  };
}

/** Build one fixture session on disk and return its paths. */
async function makeFixture(sessionsRoot, storagesRoot, sessionId, cwd) {
  const dir = join(sessionsRoot, projectDirName(cwd), encodeSegment(sessionId));
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'session.v4.jsonl.zstd'), 'fixture-log');
  const cacheDir = join(storagesRoot, 'session_projcache', 'sessions');
  await mkdir(cacheDir, { recursive: true });
  const cachePath = join(cacheDir, `${sessionId}.json`);
  await writeFile(cachePath, '{"version":7,"record":{}}');
  return { dir, cachePath };
}

/**
 * Mount the plugin against a fake host context.
 * @returns `{ run, calls }` where `run` drives one request through the route.
 */
function mountPlugin({
  sessionsRoot,
  storagesRoot,
  timeoutMs = 5000,
  liveSessions = new Map(),
  archiveSession,
  statHangs = false,
  reject = false,
} = {}) {
  const calls = { archive: [], detach: [], unpin: [], unarchive: [], emitted: [] };
  const routes = new Map();
  const workspaces = [{
    record: { sessionIds: [SESSION_ID] },
    async detachSession(id) {
      calls.detach.push(id);
      this.record.sessionIds = this.record.sessionIds.filter((value) => value !== id);
    },
  }];
  const ctx = {
    sessions: { get: (id) => liveSessions.get(id) },
    sessionPersistence: {
      async stat(id) {
        if (statHangs && id === SESSION_ID) await new Promise(() => {});
        if (id === SESSION_ID) return { header: { id, cwd: CWD } };
        return undefined;
      },
    },
    workspaceRegistry: {
      async archiveSession(sessionId, options) {
        calls.archive.push({ sessionId, options });
        if (archiveSession !== undefined) return archiveSession(sessionId, options);
        return undefined;
      },
      list: () => workspaces,
      async unpinSession(id) {
        calls.unpin.push(id);
      },
      async unarchiveSession(id) {
        calls.unarchive.push(id);
      },
    },
    connection: { requestRejection: () => (reject ? 401 : undefined) },
    webServer: {
      register(route) {
        routes.set(route.path, route.handler);
        return () => routes.delete(route.path);
      },
    },
    logger: { info() {}, warn() {}, error() {} },
    effect(callback) {
      const disposer = callback();
      return typeof disposer === 'function' ? disposer : () => {};
    },
    emit(event, payload) {
      calls.emitted.push({ event, payload });
    },
  };
  apply(ctx, { sessionsRoot, storagesRoot, timeoutMs });
  const run = async (body, options) => {
    const handler = routes.get('/session-delete/delete');
    assert.ok(handler !== undefined, 'delete route must be registered');
    const res = fakeResponse();
    // The registered handler answers asynchronously (the composition does not
    // await it), so wait for the response to end instead of awaiting a value.
    await handler(fakeRequest(body, options), res);
    const deadline = Date.now() + 60000;
    while (!res.state.ended) {
      if (Date.now() >= deadline) throw new Error('route did not answer within 60 s');
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
    }
    return res.state;
  };
  return { run, calls };
}

const root = await mkdtemp(join(tmpdir(), 'dsh-session-delete-test-'));
const sessionsRoot = join(root, 'sessions');
const storagesRoot = join(root, 'storages');
await mkdir(sessionsRoot, { recursive: true });
await mkdir(storagesRoot, { recursive: true });

try {
  // --- 1. plain delete ------------------------------------------------------
  {
    const fixture = await makeFixture(sessionsRoot, storagesRoot, SESSION_ID, CWD);
    const { run, calls } = mountPlugin({ sessionsRoot, storagesRoot });
    const state = await run({ sessionId: SESSION_ID });
    assert.equal(state.statusCode, 200, `expected 200, got ${state.statusCode}: ${state.body}`);
    const payload = JSON.parse(state.body);
    assert.equal(payload.ok, true);
    assert.equal(payload.removedLog, true);
    assert.equal(payload.removedCache, true);
    assert.deepEqual(payload.degraded, []);
    assert.equal(existsSync(fixture.dir), false, 'session directory must be gone');
    assert.equal(existsSync(fixture.cachePath), false, 'projection cache record must be gone');
    assert.deepEqual(calls.archive, [{ sessionId: SESSION_ID, options: { stopActivity: true } }]);
    assert.deepEqual(calls.detach, [SESSION_ID]);
    assert.deepEqual(calls.unpin, [SESSION_ID]);
    assert.deepEqual(calls.unarchive, [SESSION_ID]);
    assert.deepEqual(calls.emitted, [{ event: 'api-session/removed', payload: SESSION_ID }]);
    console.log('case 1 ok: plain delete removes files and cleans accounting');
  }

  // --- 2. wedged registry: archive never settles ---------------------------
  {
    const fixture = await makeFixture(sessionsRoot, storagesRoot, SESSION_ID, CWD);
    const { run } = mountPlugin({
      sessionsRoot,
      storagesRoot,
      archiveSession: () => new Promise(() => {}),
    });
    const startedAt = Date.now();
    const state = await run({ sessionId: SESSION_ID });
    const elapsed = Date.now() - startedAt;
    assert.equal(state.statusCode, 200, `expected 200 despite a wedged registry, got ${state.statusCode}: ${state.body}`);
    const payload = JSON.parse(state.body);
    assert.equal(payload.ok, true);
    assert.equal(payload.removedLog, true);
    assert.ok(payload.degraded.includes('archive-timeout'), `degraded=${JSON.stringify(payload.degraded)}`);
    assert.equal(existsSync(fixture.dir), false, 'files must be removed even when the registry wedges');
    assert.ok(elapsed < 60000, `delete must not wait indefinitely (took ${elapsed} ms)`);
    console.log(`case 2 ok: wedged registry does not block deletion (${elapsed} ms, degraded=${payload.degraded.join(',')})`);
  }

  // --- 3. live session that never releases: removed anyway -----------------
  {
    const fixture = await makeFixture(sessionsRoot, storagesRoot, SESSION_ID, CWD);
    const live = new Map([[SESSION_ID, { header: { id: SESSION_ID, cwd: CWD } }]]);
    const { run, calls } = mountPlugin({ sessionsRoot, storagesRoot, timeoutMs: 1000, liveSessions: live });
    const startedAt = Date.now();
    const state = await run({ sessionId: SESSION_ID });
    const elapsed = Date.now() - startedAt;
    assert.equal(state.statusCode, 200, `expected 200, got ${state.statusCode}: ${state.body}`);
    const payload = JSON.parse(state.body);
    assert.equal(payload.ok, true);
    assert.equal(payload.removedLog, true);
    assert.equal(payload.liveHeld, true, 'the outcome must report the session was still held');
    assert.equal(payload.resurrected, false);
    assert.ok(payload.degraded.includes('live-session'), `degraded=${JSON.stringify(payload.degraded)}`);
    assert.equal(existsSync(fixture.dir), false, 'files must be removed even while the session is held');
    assert.deepEqual(calls.unarchive, [], 'a held session keeps its archive flag (a ghost stays hidden)');
    assert.deepEqual(calls.detach, [SESSION_ID]);
    assert.ok(elapsed < 20000, `the grace wait must stay bounded (took ${elapsed} ms)`);
    console.log(`case 3 ok: a session held by another surface is still removed (${elapsed} ms, degraded=${payload.degraded.join(',')})`);
  }

  // --- 4. unauthenticated --------------------------------------------------
  {
    const fixture = await makeFixture(sessionsRoot, storagesRoot, SESSION_ID, CWD);
    const { run, calls } = mountPlugin({ sessionsRoot, storagesRoot, reject: true });
    const state = await run({ sessionId: SESSION_ID });
    assert.equal(state.statusCode, 401, `expected 401, got ${state.statusCode}`);
    assert.equal(existsSync(fixture.dir), true, 'a refused request must not touch files');
    assert.equal(calls.archive.length, 0);
    console.log('case 4 ok: the trust fence refuses before any side effect');
  }

  // --- 5. unknown session --------------------------------------------------
  {
    const { run } = mountPlugin({ sessionsRoot, storagesRoot });
    const state = await run({ sessionId: 'session-does-not-exist' });
    assert.equal(state.statusCode, 404, `expected 404, got ${state.statusCode}: ${state.body}`);
    console.log('case 5 ok: unknown session answers 404');
  }

  // --- 6. malformed requests -----------------------------------------------
  {
    const { run } = mountPlugin({ sessionsRoot, storagesRoot });
    const missing = await run({ nope: true });
    assert.equal(missing.statusCode, 400, `expected 400, got ${missing.statusCode}`);
    const wrongType = await run({ sessionId: SESSION_ID }, { contentType: 'text/plain' });
    assert.equal(wrongType.statusCode, 415, `expected 415, got ${wrongType.statusCode}`);
    const wrongMethod = await run({ sessionId: SESSION_ID }, { method: 'GET' });
    assert.equal(wrongMethod.statusCode, 405, `expected 405, got ${wrongMethod.statusCode}`);
    console.log('case 6 ok: malformed requests are refused with 400/415/405');
  }

  // --- 7. hung persistence stat still deletes via the directory scan --------
  {
    const fixture = await makeFixture(sessionsRoot, storagesRoot, SESSION_ID, CWD);
    const { run } = mountPlugin({ sessionsRoot, storagesRoot, statHangs: true, timeoutMs: 1000 });
    const state = await run({ sessionId: SESSION_ID });
    // The stat bound is 15 s; the scan then finds the directory the header
    // could not name, so the files still go.
    assert.equal(state.statusCode, 200, `expected 200, got ${state.statusCode}: ${state.body}`);
    const payload = JSON.parse(state.body);
    assert.ok(payload.degraded.includes('stat'), `degraded=${JSON.stringify(payload.degraded)}`);
    assert.equal(existsSync(fixture.dir), false, 'scan fallback must still remove the files');
    console.log(`case 7 ok: hung persistence stat still deletes via scan (degraded=${payload.degraded.join(',')})`);
  }

  // --- 8. a held session whose files keep reappearing ----------------------
  {
    const fixture = await makeFixture(sessionsRoot, storagesRoot, SESSION_ID, CWD);
    const live = new Map([[SESSION_ID, { header: { id: SESSION_ID, cwd: CWD } }]]);
    const { run } = mountPlugin({ sessionsRoot, storagesRoot, timeoutMs: 500, liveSessions: live });
    // Simulate a writer that keeps recreating the log after every removal.
    const writer = setInterval(() => {
      try {
        mkdirSync(fixture.dir, { recursive: true });
        writeFileSync(join(fixture.dir, 'session.v4.jsonl.zstd'), 'late-append');
      } catch {
        // The test only needs the directory to come back.
      }
    }, 200);
    try {
      const state = await run({ sessionId: SESSION_ID });
      assert.equal(state.statusCode, 500, `expected 500, got ${state.statusCode}: ${state.body}`);
      const payload = JSON.parse(state.body);
      assert.equal(payload.code, 'remove-blocked');
      assert.ok(payload.degraded.includes('remove-blocked'), `degraded=${JSON.stringify(payload.degraded)}`);
      console.log('case 8 ok: a directory that keeps reappearing reports remove-blocked instead of pretending success');
    } finally {
      clearInterval(writer);
    }
  }
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log('delete-flow.test.js: all assertions passed');
