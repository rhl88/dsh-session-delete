/**
 * Pure path helpers for locating a persisted session's on-disk artifacts.
 *
 * `encodeSegment` and `projectKey` replicate — verbatim in behavior — the two
 * encoding functions of the shipped JSONL session backend
 * (`@deepseek-ai/dsh-session-persistence-jsonl`), which does not export them.
 * The backend lays out one session as:
 *
 *   <sessionsRoot>/<projectKey(cwd)>/<encodeSegment(sessionId)>/
 *
 * with `_no-cwd` replacing the project directory for sessions without a
 * working directory. Only node builtins are imported, so this module is
 * unit-testable and loadable outside the dsh runtime.
 */
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * Resolve the DeepSeek Harness home, replicating
 * `@deepseek-ai/dsh-home-paths`'s `resolveDshHome()` precedence:
 * `$DSH_HOME` (blank treated as unset, tilde expanded), then `~/.dsh`.
 * @returns the normalized absolute harness home path.
 */
export function resolveDshHome() {
  const fromEnv = process.env.DSH_HOME;
  const configured = fromEnv !== undefined && fromEnv.trim().length > 0 ? fromEnv : join(homedir(), '.dsh');
  const expanded = configured === '~' ? homedir()
    : configured.startsWith('~/') || configured.startsWith('~\\') ? join(homedir(), configured.slice(2))
      : configured;
  return resolve(expanded);
}

/**
 * Join path segments onto the resolved harness home.
 * @param segments - path segments appended to the home.
 * @returns the normalized absolute joined path.
 */
export function dshHomePath(...segments) {
  return join(resolveDshHome(), ...segments);
}

/**
 * Encode an arbitrary string as a single safe path segment, injectively over
 * all UTF-16 strings. Safe code units stay literal; every other unit,
 * including `~`, becomes `~XXXX`. `.` and `..` are special-cased so no
 * traversal is possible.
 * @param raw - the string to encode; must be non-empty.
 * @returns the escaped single path segment.
 */
export function encodeSegment(raw) {
  if (raw.length === 0) throw new Error('cannot encode an empty path segment');
  if (raw === '.') return '~002E';
  if (raw === '..') return '~002E~002E';
  let out = '';
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i);
    const ch = String.fromCharCode(code);
    if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) out += ch;
    else out += '~' + code.toString(16).toUpperCase().padStart(4, '0');
  }
  return out;
}

/**
 * Build the readable directory key for a project path: separators and drive
 * colons collapse to `-`, unsafe code units use the `~XXXX` escape, leading
 * dashes are stripped, and the result is bounded to 251 characters between
 * `--` sentinels.
 * @param cwd - the session's project directory.
 * @returns a single filesystem-safe project directory name.
 */
export function projectKey(cwd) {
  if (cwd.length === 0) throw new Error('cannot encode an empty project path');
  let readable = '';
  let separatorRun = false;
  for (let i = 0; i < cwd.length; i++) {
    const code = cwd.charCodeAt(i);
    const ch = String.fromCharCode(code);
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!separatorRun) readable += '-';
      separatorRun = true;
    } else if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch;
      separatorRun = false;
    } else {
      readable += '~' + code.toString(16).toUpperCase().padStart(4, '0');
      separatorRun = false;
    }
  }
  return `--${(readable.replace(/^-+/, '') || 'root').slice(0, 251)}--`;
}

/**
 * The JSONL backend's project directory name for one session header.
 * @param cwd - the session's project directory, or undefined.
 * @returns the project directory segment (`_no-cwd` without a cwd).
 */
export function projectDirName(cwd) {
  return cwd === undefined ? '_no-cwd' : projectKey(cwd);
}

/** Per-record storage keys that are safe to splice into a `<key>.json` path. */
const SAFE_RECORD_KEY_RE = /^[A-Za-z0-9._-]+$/;

/**
 * Whether a session id is safe as a per-record storage file name (the storage
 * backends enforce the same class of pattern before using a key as a path
 * segment).
 * @param sessionId - candidate session id.
 * @returns whether the id may name a `<key>.json` record document.
 */
export function isSafeRecordKey(sessionId) {
  return typeof sessionId === 'string' && SAFE_RECORD_KEY_RE.test(sessionId)
    && sessionId !== '.' && sessionId !== '..';
}

/**
 * Defense in depth: whether a resolved target lies strictly inside a resolved
 * root directory. Callers pass already-resolved absolute paths.
 * @param target - resolved candidate path.
 * @param root - resolved root that must contain it.
 * @param sep - platform path separator.
 * @returns whether target is a strict descendant of root.
 */
export function isContainedPath(target, root, sep) {
  return target.length > root.length
    && target.startsWith(root.endsWith(sep) ? root : root + sep);
}
