/**
 * Module-load smoke test: the host half must import cleanly with plain node
 * (no dsh runtime), export the cordis function-plugin shape, and the client
 * bundle file must exist and be syntactically loadable as a classic script.
 * Run with the bundled node:
 *   node dsh-session-delete/test/module-load.test.js
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const here = fileURLToPath(new URL('.', import.meta.url));
const pkgDir = join(here, '..');

// Host half: plain ESM import must succeed and expose the plugin shape.
const host = await import('../index.js');
assert.equal(typeof host.apply, 'function', 'apply export');
assert.equal(host.name, 'session-delete', 'name export');
assert.ok(Array.isArray(host.inject), 'inject export is an array');
for (const service of ['webServer', 'connection', 'workspaceRegistry', 'sessionPersistence', 'sessions']) {
  assert.ok(host.inject.includes(service), `inject lists ${service}`);
}

// Client half: parse as a classic script in a sandbox with a recording
// __ModuleLoader__ (no DOM needed); the factory must build the plugin shape
// when invoked with baseline requires.
const clientSource = readFileSync(join(pkgDir, 'client.js'), 'utf8');
let loaded = null;
const sandbox = {
  window: {},
  document: undefined,
  fetch: undefined,
};
sandbox.window.__ModuleLoader__ = {
  load(entry) {
    loaded = entry;
  },
};
sandbox.globalThis = sandbox;
vm.runInNewContext(clientSource, sandbox, { filename: 'client.js' });
assert.ok(loaded !== null, 'client bundle called __ModuleLoader__.load');
assert.equal(loaded.id, 'dsh-session-remove', 'client module id');
assert.equal(typeof loaded.factory, 'function', 'client factory');

const required = [];
const stubRequire = (specifier) => {
  required.push(specifier);
  if (specifier === 'react') {
    return {
      createElement: () => null,
      Fragment: 'Fragment',
    };
  }
  if (specifier === '@deepseek-ai/dsh-client-store') {
    return { createSnapshotStore: (initial) => ({ getSnapshot: () => initial, set() {}, subscribe: () => () => {} }) };
  }
  if (specifier === '@deepseek-ai/dsh-client-ui-primitives') {
    return new Proxy({}, { get: (_target, prop) => (typeof prop === 'string' ? function Stub() {} : undefined) });
  }
  throw new Error(`unexpected client require: ${specifier}`);
};
const clientModule = loaded.factory(stubRequire);
assert.equal(typeof clientModule.apply, 'function', 'client apply export');
assert.ok(Array.isArray(clientModule.inject), 'client inject export');
for (const service of ['slots', 'locale', 'uiWorkspace']) {
  assert.ok(clientModule.inject.includes(service), `client inject lists ${service}`);
}
// Baseline platform seeds only:
for (const specifier of required) {
  assert.ok(
    ['react', '@deepseek-ai/dsh-client-store', '@deepseek-ai/dsh-client-ui-primitives'].includes(specifier),
    `client requires only baseline modules (got ${specifier})`,
  );
}

console.log('module-load.test.js: all assertions passed');
