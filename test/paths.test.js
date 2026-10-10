/**
 * Unit tests for the pure path helpers. Run with the bundled node:
 *   node dsh-session-delete/test/paths.test.js
 *
 * The final block asserts the computed layout against the real DSH home of
 * this machine (read-only existence checks; the tests never mutate anything).
 */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { encodeSegment, projectKey, projectDirName, isSafeRecordKey, isContainedPath, resolveDshHome, dshHomePath } from '../paths.js';

// --- resolveDshHome / dshHomePath -------------------------------------------
const expectedHome = process.env.DSH_HOME?.trim() ? resolve(process.env.DSH_HOME) : join(homedir(), '.dsh');
assert.equal(resolveDshHome(), expectedHome);
assert.equal(dshHomePath('sessions'), join(expectedHome, 'sessions'));
assert.equal(dshHomePath(), expectedHome);

// --- encodeSegment ---------------------------------------------------------
assert.equal(encodeSegment('session-c851bf9f-803d-4f55-9c51-263c389e4b07'), 'session-c851bf9f-803d-4f55-9c51-263c389e4b07');
assert.equal(encodeSegment('.'), '~002E');
assert.equal(encodeSegment('..'), '~002E~002E');
assert.equal(encodeSegment('~'), '~007E');
assert.equal(encodeSegment('a b'), 'a~0020b');
assert.equal(encodeSegment('会'), '~4F1A');
assert.equal(encodeSegment('a.b_c-d'), 'a.b_c-d');
assert.throws(() => encodeSegment(''));

// --- projectKey ------------------------------------------------------------
// Real observed directory names on this machine:
assert.equal(projectKey('D:\\Backup\\Documents\\deepseek-harness\\default-workspace'), '--D-Backup-Documents-deepseek-harness-default-workspace--');
assert.equal(projectKey('E:\\wwwroot\\cmspro'), '--E-wwwroot-cmspro--');
assert.equal(projectKey('/home/user/x'), '--home-user-x--');
assert.equal(projectKey('C:\\'), '--C---');
assert.equal(projectKey('/'), '--root--');
// Separator runs collapse to a single dash:
assert.equal(projectKey('a//b\\\\c: d'), '--a-b-c-~0020d--');
// Unsafe units escape:
assert.equal(projectKey('C:\\projects\\会场'), '--C-projects-~4F1A~573A--');
// Bound: at most 251 readable chars between the sentinels:
const long = 'D:\\' + 'x'.repeat(400);
const key = projectKey(long);
assert.equal(key.length, 2 + 251 + 2);
assert.ok(key.startsWith('--D-') && key.endsWith('--'));
assert.throws(() => projectKey(''));

// --- projectDirName ---------------------------------------------------------
assert.equal(projectDirName(undefined), '_no-cwd');
assert.equal(projectDirName('E:\\wwwroot\\cmspro'), '--E-wwwroot-cmspro--');

// --- isSafeRecordKey --------------------------------------------------------
assert.equal(isSafeRecordKey('session-c851bf9f-803d-4f55-9c51-263c389e4b07'), true);
assert.equal(isSafeRecordKey('a.b_c-d'), true);
assert.equal(isSafeRecordKey('.'), false);
assert.equal(isSafeRecordKey('..'), false);
assert.equal(isSafeRecordKey('a/b'), false);
assert.equal(isSafeRecordKey('a\\b'), false);
assert.equal(isSafeRecordKey(''), false);
assert.equal(isSafeRecordKey('a b'), false);

// --- isContainedPath --------------------------------------------------------
// The helper is a pure prefix check over ALREADY-RESOLVED paths (callers run
// resolve() first, which normalizes '..' segments away).
const sep = '\\';
assert.equal(isContainedPath('C:\\root\\child', 'C:\\root', sep), true);
assert.equal(isContainedPath('C:\\root\\child', 'C:\\root\\', sep), true);
assert.equal(isContainedPath('C:\\root', 'C:\\root', sep), false);
assert.equal(isContainedPath('C:\\rootx\\child', 'C:\\root', sep), false);
assert.equal(isContainedPath('C:\\other\\child', 'C:\\root', sep), false);
assert.equal(isContainedPath(resolve('C:\\root\\..\\..\\etc'), 'C:\\root', sep), false);

// --- real layout spot check (read-only) -------------------------------------
const dshHome = resolveDshHome();
const sessionsRoot = join(dshHome, 'sessions');
const storagesRoot = join(dshHome, 'storages');
const liveId = 'session-c851bf9f-803d-4f55-9c51-263c389e4b07';
const liveCwd = 'D:\\Backup\\Documents\\deepseek-harness\\default-workspace';
const expectedDir = join(sessionsRoot, projectDirName(liveCwd), encodeSegment(liveId));
assert.ok(existsSync(expectedDir), `expected live session directory at ${expectedDir}`);
const expectedCache = join(storagesRoot, 'session_projcache', 'sessions', `${liveId}.json`);
if (existsSync(expectedCache)) {
  console.log(`cache record confirmed at ${expectedCache}`);
} else {
  console.log(`note: no projection-cache record at ${expectedCache} (acceptable: cache is lazily built)`);
}

console.log('paths.test.js: all assertions passed');
