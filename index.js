/**
 * Host half of @local/dsh-session-delete.
 *
 * Registers `POST /session-delete/delete` on the composition's webServer,
 * behind the same connection trust fence (Host/Origin + browser auth) the
 * shipped app routes use, plus a small `POST /session-delete/trace` sink that
 * records the browser half's progress into a debug log.
 *
 * One delete runs as:
 *
 *   1. Resolve the session (live store, then persistence stat); unknown ids
 *      answer 404 and nothing is written.
 *   2. Best-effort `workspaceRegistry.archiveSession(id, { stopActivity: true })`
 *      — the registry's own stop machinery halts the running turn, jobs, and
 *      subagent descendants, and the durable archive set gates every wake the
 *      stops induce. Every registry call is timeout-guarded: the registry
 *      serializes its operations, so one wedged operation would otherwise
 *      block this request forever. A timeout is recorded and the delete
 *      continues, because removing the files is the user's actual request.
 *   3. Wait (bounded) for the live session to leave `ctx.sessions`, i.e. for
 *      `session/disposed` to have run the persistence backend's final drain
 *      and closed its write handle — on Windows an open handle would block
 *      the file removal. Still live after the wait → 409, files untouched.
 *   4. Remove the JSONL backend's session directory
 *      (`<sessionsRoot>/<projectKey(cwd)>/<encodeSegment(id)>`), falling back
 *      to a scan of project directories when the header's cwd does not name
 *      the expected location.
 *   5. Remove the projection-cache record document
 *      (`<storagesRoot>/session_projcache/sessions/<id>.json`).
 *   6. Best-effort registry accounting: detach the id from its workspace
 *      record, then drop it from the pin and archive sets. Each write
 *      publishes its ordinary workspace-feed increment, so sidebars drop the
 *      row live. Failures here are reported as `degraded`, never as a failed
 *      delete: the files are already gone.
 *   7. Emit `api-session/removed`, which the api-remotes relay forwards to
 *      every connected browser.
 *
 * Every step appends to `session-delete.debug.log` beside this module, and the
 * browser half's markers land in `session-delete.client.log`; both are debug
 * artifacts, safe to delete.
 *
 * Not deleted (by design, v1): content-addressed attachment bytes (shared
 * across sessions), descendant subagent session logs, and full-text search
 * index rows (the SQLite index reconciles itself against persistence on the
 * next search).
 */
import { appendFile, readdir, rm, stat as fsStat } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dshHomePath, encodeSegment, isContainedPath, isSafeRecordKey, projectDirName } from './paths.js';

/** Cordis function-plugin name. */
export const name = 'session-delete';

/** Required composition services; the row stays inactive until all exist. */
export const inject = ['webServer', 'connection', 'workspaceRegistry', 'sessionPersistence', 'sessions'];

/** Exact route path serving the delete operation. */
const ROUTE_PATH = '/session-delete/delete';

/** Exact route path receiving browser-side progress markers. */
const TRACE_PATH = '/session-delete/trace';

/** Request bodies are one tiny JSON object; anything larger is hostile. */
const MAX_BODY_BYTES = 4096;

/** Poll interval while waiting for a live session to dispose. */
const POLL_INTERVAL_MS = 200;

/** Grace period after the store empties, letting the backend's drain finish. */
const SETTLE_GRACE_MS = 300;

/** Body collection bound: a stalled request must not hold a handler open. */
const BODY_TIMEOUT_MS = 10000;

/** Per-request watchdog: always answer, even if a step never settles. */
const WATCHDOG_MS = 90000;

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const DEBUG_LOG = join(MODULE_DIR, 'session-delete.debug.log');
const CLIENT_LOG = join(MODULE_DIR, 'session-delete.client.log');

/** Append one debug line; logging never affects the operation. */
async function appendLog(file, line) {
  try {
    await appendFile(file, `${new Date().toISOString()} ${line}\n`);
  } catch {
    // A debug sink must never break the request path.
  }
}

/** Clamp one configured millisecond bound into a sane range. */
function boundedMs(value, fallback, min = 1000, max = 300000) {
  return typeof value === 'number' && Number.isFinite(value) && value >= min
    ? Math.min(Math.trunc(value), max)
    : fallback;
}

/** JSON response (no-store: delete outcomes are live facts). */
function sendJson(res, status, payload) {
  if (res.headersSent) {
    res.end();
    return;
  }
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(payload));
}

/**
 * Run one step under a timeout, converting every outcome into a value so a
 * wedged dependency can never hang the request. `timedOut` distinguishes the
 * timeout from a genuine failure.
 * @param label - step name for the log.
 * @param ms - timeout bound.
 * @param fn - the step.
 * @returns `{ ok: true, value }` or `{ ok: false, error, timedOut }`.
 */
async function withTimeout(label, ms, fn) {
  let timer;
  try {
    const value = await Promise.race([
      Promise.resolve().then(fn),
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => {
          const error = new Error(`${label} timed out after ${ms} ms`);
          error.timedOut = true;
          reject(error);
        }, ms);
      }),
    ]);
    return { ok: true, value };
  } catch (error) {
    return { ok: false, error, timedOut: error?.timedOut === true };
  } finally {
    clearTimeout(timer);
  }
}

/** Collect a bounded request body as UTF-8 text; null past the ceiling. */
async function readBoundedBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > MAX_BODY_BYTES) {
      req.resume();
      return null;
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** One configured root: an absolute override, or the harness-home default. */
function rootOf(override, defaultSegments) {
  return typeof override === 'string' && override.trim().length > 0
    ? resolve(override)
    : dshHomePath(...defaultSegments);
}

/** Sleep helper for the bounded dispose wait. */
function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

/** Whether an absolute path names an existing directory. */
async function isDirectory(path) {
  try {
    return (await fsStat(path)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Fallback location pass: scan the root's project directories for one holding
 * the encoded session id. The header cwd can disagree with the physical
 * location (normalization differences, moved homes); the encoded id is an
 * injective, traversal-safe segment, and the containment check pins every
 * candidate strictly inside the root.
 * @param root - resolved sessions root.
 * @param encodedId - encodeSegment of the session id.
 * @returns the found session directory, or undefined.
 */
async function scanForSessionDir(root, encodedId) {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return undefined;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const candidate = resolve(join(root, entry.name, encodedId));
    if (!isContainedPath(candidate, resolve(root), sep)) continue;
    if (await isDirectory(candidate)) return candidate;
  }
  return undefined;
}

/**
 * Plugin entry: mount the routes for the lifetime of the row.
 * @param ctx - host root context with the injected services.
 * @param config - row config: optional timeoutMs / sessionsRoot / storagesRoot.
 */
export function apply(ctx, config = {}) {
  const timeoutMs = boundedMs(config?.timeoutMs, 20000);
  const sessionsRoot = rootOf(config?.sessionsRoot, ['sessions']);
  const storagesRoot = rootOf(config?.storagesRoot, ['storages']);

  /** One in-flight delete per session id; concurrent callers share it. */
  const inFlight = new Map();

  /**
   * The delete core. Returns an HTTP-ish outcome instead of throwing for the
   * anticipated refusals.
   * @param sessionId - durable session identity to remove.
   * @returns `{ status, body }` for the route to answer.
   */
  async function deleteSession(sessionId) {
    const startedAt = Date.now();
    const step = (label) => appendLog(DEBUG_LOG, `[${sessionId}] ${label} (+${Date.now() - startedAt}ms)`);
    const degraded = [];
    await step('delete: start');

    // 1. Locate the session: the live store first, then persistence, then a
    //    scan of the sessions root. Location must not depend on any single
    //    seam, because the files are the actual target.
    const wasLive = ctx.sessions.get(sessionId) !== undefined;
    let header = ctx.sessions.get(sessionId)?.header;
    const statOutcome = await withTimeout('persistence.stat', 15000, () => ctx.sessionPersistence.stat(sessionId));
    if (statOutcome.ok) {
      if (statOutcome.value?.header !== undefined) header = statOutcome.value.header;
      await step(`stat: ok cwd=${header?.cwd ?? '<none>'}`);
    } else {
      degraded.push('stat');
      await step(`stat: ${statOutcome.timedOut ? 'TIMEOUT' : 'failed'} ${String(statOutcome.error?.message ?? statOutcome.error)}`);
    }
    const encodedId = encodeSegment(sessionId);
    let dir;
    if (header?.cwd !== undefined) {
      const candidate = resolve(join(sessionsRoot, projectDirName(header.cwd), encodedId));
      if (isContainedPath(candidate, resolve(sessionsRoot), sep) && await isDirectory(candidate)) dir = candidate;
    }
    if (dir === undefined) {
      const scanned = await scanForSessionDir(sessionsRoot, encodedId);
      if (scanned !== undefined) {
        dir = scanned;
        await step(`locate: found by scan ${dir}`);
      }
    }
    if (dir === undefined && !wasLive && header === undefined) {
      await step('delete: 404 session not found');
      return {
        status: 404,
        body: { code: 'session-not-found', message: `session '${sessionId}' is neither live, persisted, nor present on disk` },
      };
    }
    await step(`locate: ${dir ?? 'no directory on disk'}`);

    // 2. Best-effort: stop the session's work and archive it. The registry
    //    serializes operations, so this is timeout-guarded and non-fatal.
    const archiveOutcome = await withTimeout('workspaceRegistry.archiveSession', 15000, () => ctx.workspaceRegistry.archiveSession(sessionId, { stopActivity: true }));
    if (archiveOutcome.ok) {
      await step(`archive: ok (wasLive=${wasLive})`);
    } else {
      degraded.push(archiveOutcome.timedOut ? 'archive-timeout' : 'archive-failed');
      await step(`archive: ${archiveOutcome.timedOut ? 'TIMEOUT' : 'failed'} ${String(archiveOutcome.error?.message ?? archiveOutcome.error)}`);
    }

    // 3. Wait for the live session to dispose so the backend's write handle
    //    is closed and Windows removal cannot hit a share violation.
    const deadline = Date.now() + timeoutMs;
    while (ctx.sessions.get(sessionId) !== undefined) {
      if (Date.now() >= deadline) {
        await step(`wait: still live after ${timeoutMs}ms -> 409`);
        return {
          status: 409,
          body: {
            code: 'session-busy',
            message: `session '${sessionId}' did not release within ${timeoutMs} ms; close its view or restart the app, then retry`,
          },
        };
      }
      await sleep(POLL_INTERVAL_MS);
    }
    if (wasLive) await step('wait: disposed');
    await sleep(SETTLE_GRACE_MS);

    // 4. Remove the physical session directory located in step 1.
    let removedLog = false;
    if (dir !== undefined) {
      if (!isContainedPath(dir, resolve(sessionsRoot), sep)) {
        throw new Error(`session directory escapes the sessions root: ${dir}`);
      }
      if (await isDirectory(dir)) {
        try {
          await rm(dir, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 });
          removedLog = true;
          await step(`rm: ok ${dir}`);
        } catch (error) {
          await step(`rm: FAILED ${String(error?.message ?? error)}`);
          return {
            status: 500,
            body: {
              code: 'remove-failed',
              message: `could not remove ${dir}: ${String(error?.message ?? error)}`,
              degraded,
            },
          };
        }
      } else {
        await step(`rm: no directory at ${dir} (already gone?)`);
      }
    } else {
      await step('rm: nothing on disk to remove');
    }

    // 5. Remove the projection-cache record document.
    let removedCache = false;
    if (isSafeRecordKey(sessionId)) {
      const cachePath = resolve(join(storagesRoot, 'session_projcache', 'sessions', `${sessionId}.json`));
      if (isContainedPath(cachePath, resolve(storagesRoot), sep)) {
        try {
          await rm(cachePath, { force: true });
          removedCache = true;
          await step(`cache: removed ${cachePath}`);
        } catch (error) {
          degraded.push('cache');
          await step(`cache: FAILED ${String(error?.message ?? error)}`);
        }
      }
    }

    // 6. Best-effort registry accounting. Each write publishes its feed
    //    increment, so connected sidebars update live.
    const detachOutcome = await withTimeout('workspace.detachSession', 8000, async () => {
      for (const workspace of ctx.workspaceRegistry.list()) {
        const ids = workspace.record?.sessionIds ?? workspace.sessionIds ?? [];
        if (ids.includes(sessionId)) {
          await workspace.detachSession(sessionId);
          return true;
        }
      }
      return false;
    });
    if (!detachOutcome.ok) degraded.push(detachOutcome.timedOut ? 'detach-timeout' : 'detach-failed');
    const unpinOutcome = await withTimeout('workspaceRegistry.unpinSession', 8000, () => ctx.workspaceRegistry.unpinSession(sessionId));
    if (!unpinOutcome.ok) degraded.push(unpinOutcome.timedOut ? 'unpin-timeout' : 'unpin-failed');
    const unarchiveOutcome = await withTimeout('workspaceRegistry.unarchiveSession', 8000, () => ctx.workspaceRegistry.unarchiveSession(sessionId));
    if (!unarchiveOutcome.ok) degraded.push(unarchiveOutcome.timedOut ? 'unarchive-timeout' : 'unarchive-failed');
    await step(`accounting: detach=${detachOutcome.ok ? 'ok' : 'FAIL'} unpin=${unpinOutcome.ok ? 'ok' : 'FAIL'} unarchive=${unarchiveOutcome.ok ? 'ok' : 'FAIL'}`);

    // 7. Tell every connected browser the session is gone.
    ctx.emit('api-session/removed', sessionId);
    await step(`delete: done (removedLog=${removedLog} removedCache=${removedCache} degraded=[${degraded.join(',')}])`);
    ctx.logger.info(`session-delete: removed session '${sessionId}' (log: ${removedLog}, projection cache: ${removedCache}, degraded: ${degraded.join(',') || 'none'})`);
    return { status: 200, body: { ok: true, sessionId, removedLog, removedCache, degraded } };
  }

  /**
   * Route handler: trust fence, wire validation, watchdog, then the shared
   * in-flight delete for the requested id.
   * @param req - Node http request.
   * @param res - Node http response.
   */
  async function handle(req, res) {
    const watchdog = setTimeout(() => {
      void appendLog(DEBUG_LOG, `watchdog: no response after ${WATCHDOG_MS}ms for ${req.method} ${req.url}`);
      sendJson(res, 500, { code: 'timeout', message: `no result after ${WATCHDOG_MS} ms; check session-delete.debug.log` });
    }, WATCHDOG_MS);
    try {
      const rejection = ctx.connection.requestRejection(req);
      if (rejection !== undefined) {
        const status = typeof rejection === 'number' ? rejection : (rejection?.status ?? rejection?.code ?? 403);
        void appendLog(DEBUG_LOG, `fence: rejected ${req.method} ${req.url} -> ${status}`);
        sendJson(res, status, { code: 'forbidden', message: 'request rejected by the connection trust fence' });
        return;
      }
      if (req.method !== 'POST') {
        res.statusCode = 405;
        res.setHeader('allow', 'POST');
        res.end();
        return;
      }
      if (String(req.headers['content-type'] ?? '').split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') {
        sendJson(res, 415, { code: 'unsupported-media-type', message: 'content-type must be application/json' });
        return;
      }
      const bodyOutcome = await withTimeout('readBoundedBody', BODY_TIMEOUT_MS, () => readBoundedBody(req));
      if (!bodyOutcome.ok) {
        await appendLog(DEBUG_LOG, `body: ${bodyOutcome.timedOut ? 'TIMEOUT' : 'unreadable'} ${String(bodyOutcome.error?.message ?? bodyOutcome.error)}`);
        sendJson(res, 400, { code: 'bad-request', message: 'request body unreadable' });
        return;
      }
      const text = bodyOutcome.value;
      if (text === null) {
        sendJson(res, 413, { code: 'payload-too-large', message: 'request body is too large' });
        return;
      }
      let sessionId;
      try {
        sessionId = JSON.parse(text)?.sessionId;
      } catch {
        sessionId = undefined;
      }
      if (typeof sessionId !== 'string' || sessionId.length === 0 || sessionId.length > 512) {
        sendJson(res, 400, { code: 'bad-request', message: 'request body must be JSON with a string "sessionId"' });
        return;
      }
      await appendLog(DEBUG_LOG, `request: POST ${req.url} sessionId=${sessionId}`);
      let task = inFlight.get(sessionId);
      if (task === undefined) {
        task = deleteSession(sessionId).finally(() => {
          if (inFlight.get(sessionId) === task) inFlight.delete(sessionId);
        });
        inFlight.set(sessionId, task);
      }
      const outcome = await task;
      sendJson(res, outcome.status, outcome.body);
    } catch (error) {
      await appendLog(DEBUG_LOG, `error: ${String(error?.stack ?? error)}`);
      ctx.logger.error(`session-delete: route failed: ${String(error?.stack ?? error)}`);
      sendJson(res, 500, { code: 'internal', message: String(error?.message ?? error) });
    } finally {
      clearTimeout(watchdog);
    }
  }

  /**
   * Trace sink: the browser half's progress markers, appended to a separate
   * log so a stalled delete can be told apart from a stalled archive hop.
   * @param req - Node http request.
   * @param res - Node http response.
   */
  async function handleTrace(req, res) {
    try {
      const rejection = ctx.connection.requestRejection(req);
      if (rejection !== undefined) {
        const status = typeof rejection === 'number' ? rejection : (rejection?.status ?? rejection?.code ?? 403);
        sendJson(res, status, { code: 'forbidden', message: 'request rejected by the connection trust fence' });
        return;
      }
      if (req.method !== 'POST') {
        res.statusCode = 405;
        res.setHeader('allow', 'POST');
        res.end();
        return;
      }
      const outcome = await withTimeout('readBoundedBody', BODY_TIMEOUT_MS, () => readBoundedBody(req));
      const text = outcome.ok ? outcome.value : null;
      let message;
      try {
        message = JSON.parse(String(text))?.message;
      } catch {
        message = undefined;
      }
      await appendLog(CLIENT_LOG, typeof message === 'string' ? message.slice(0, 500) : '<unparsable trace>');
      sendJson(res, 200, { ok: true });
    } catch (error) {
      sendJson(res, 200, { ok: false, message: String(error?.message ?? error) });
    }
  }

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: ROUTE_PATH,
    handler: (req, res) => {
      handle(req, res).catch((error) => {
        void appendLog(DEBUG_LOG, `handler: ${String(error?.stack ?? error)}`);
        ctx.logger.error(`session-delete: route failed: ${String(error?.stack ?? error)}`);
        sendJson(res, 500, { code: 'internal', message: String(error?.message ?? error) });
      });
    },
  }), `session-delete: POST ${ROUTE_PATH}`);

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: TRACE_PATH,
    handler: (req, res) => {
      handleTrace(req, res).catch(() => {
        if (!res.headersSent) sendJson(res, 200, { ok: false });
      });
    },
  }), `session-delete: POST ${TRACE_PATH}`);

  void appendLog(DEBUG_LOG, `plugin: routes mounted (timeoutMs=${timeoutMs} sessionsRoot=${sessionsRoot} storagesRoot=${storagesRoot})`);
}
