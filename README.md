# dsh-session-remove

DeepSeek Harness (cordis) bundle plugin adding **permanent session deletion** to
the Web GUI. Stock DSH only archives sessions: the sidebar session menu gets a
destructive **Delete session** entry (after pin/rename/fork/archive, behind a
separator), a confirmation dialog, and a host route that physically removes the
session's durable artifacts.

---

## 中文说明

在侧边栏会话菜单里加入**删除会话**：永久移除会话记录与完整历史，补足官方只能归档的限制。菜单项排在 置顶/重命名/分叉/归档 之后，带分隔线与危险色，点击后弹出确认对话框。

**安装**（三种方式任选）

```pwsh
# ① 从 GitHub 仓库安装（推荐；插件目录里展示的就是这条）
dsh plugin add github:rhl88/dsh-session-delete

# ② 从本地目录 / 预构建 tarball 安装
dsh plugin add D:\path\to\dsh-session-delete
dsh plugin add D:\path\to\local-dsh-session-delete-1.0.0.tgz

# ③ 等价的手工方式（在 profile 目录里）
cd C:\Users\Administrator\.dsh\profiles\desktop
pnpm add github:rhl88/dsh-session-delete
# 再把 dsh.profile.bundles 设为：
#   ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-session-remove"]

# 装完重启 DeepSeek Harness，并刷新 GUI 页面
```

`dsh plugin add` 与插件页安装会**默认启用**该 bundle；只有手工 `pnpm add` 才需要自己改 `dsh.profile.bundles`。

**删除内容**：会话日志目录 `~/.dsh/sessions/<项目目录>/<会话id>/`、投影缓存 `~/.dsh/storages/session_projcache/sessions/<会话id>.json`，并从工作区记账、置顶集合、归档集合中清除该会话 id，随后广播 `api-session/removed`，侧边栏立即更新。不删除（v1）：内容寻址的附件字节（跨会话共享）、子代理会话日志、全文检索索引行（下次搜索会自动对账剔除）。

**安全侧设计**：所有注册表调用都带超时且失败不致命——工作区操作队列卡住时仍会删除文件，并在响应里返回 `degraded` 说明；活动会话未释放句柄则返回 409 且不动文件，稍后重试即可。

**两点注意**：① 只装一份——行 id 与浏览器插槽 id 固定，同时选中两份安装会冲突；② 改宿主端代码需要重启应用——desktop 组合关闭了模块热重载（HMR `root: []`），且重新导入同一模块 URL 会命中 ESM 缓存。包内**没有声明任何依赖**（宿主只用 node 内置模块，客户端只用浏览器模块基线），因此没有版本兼容门槛。

**中文详细说明见 [INSTALL.zh.md](INSTALL.zh.md)**；宿主逐步日志 `session-delete.debug.log`、浏览器进度标记 `session-delete.client.log` 都写在已部署的 `index.js` 同目录，便于排查。自测：`node test/paths.test.js`、`node test/module-load.test.js`、`node test/delete-flow.test.js`。

> 以下为英文文档 / English documentation follows.

---

## What a delete removes

1. The JSONL backend's session directory
   `~/.dsh/sessions/<projectKey(cwd)>/<encodeSegment(sessionId)>/` (all format
   generations, compression variants, and lease files).
2. The projection-cache record
   `~/.dsh/storages/session_projcache/sessions/<sessionId>.json`.
3. Registry accounting: the id is detached from its workspace record and
   dropped from the pin and archive sets; `api-session/removed` is emitted so
   every connected browser reconciles immediately.

Deliberately **not** removed in v1: content-addressed attachment bytes (shared
across sessions by design), descendant subagent session logs (hidden from the
sidebar anyway), and full-text index rows (the SQLite index reconciles against
persistence on the next search — deleted sessions drop out by themselves).

## How it works

**Host half** (`index.js`, row `session-delete`): registers
`POST /session-delete/delete` on the composition's `webServer`, behind the
`connection` trust fence (Host/Origin + browser auth — same gate as the shipped
app routes). One delete:

1. Resolve the session (live store, then `sessionPersistence.stat`); unknown →
   `404`, nothing written.
2. `workspaceRegistry.archiveSession(id, { stopActivity: true })` — the
   registry's own machinery stops the running turn, jobs, subagent descendants,
   and reminders; the archive set gates every wake the stops induce. Idempotent
   when already archived.
3. Bounded wait (`timeoutMs`, default 20 s) for the live session to leave
   `ctx.sessions` — i.e. for `session/disposed` to drain and close the
   persistence write handle (Windows blocks file removal while it is open).
   Timeout → `409 session-busy`; the session stays archived, retry later.
4. `rm -r` the session directory (path functions replicate the JSONL backend's
   `encodeSegment`/`projectKey` verbatim; every candidate is containment-checked
   inside the configured root, with a bounded retry against transient locks and
   a project-directory scan fallback when the header cwd disagrees with the
   physical layout).
5. Remove the projection-cache record document.
6. Detach from the workspace record, unpin, unarchive — each write publishes
   its ordinary feed increment, so sidebars drop the row live.
7. Emit `api-session/removed`.

**Client half** (`client.js`, web platform): menu entry on
`sidebar.workspaces.session.menu.item` (order 500, `danger` + separator) and a
`shell.overlay` confirmation `Modal`. Confirm runs
`ctx.uiWorkspace.archiveSession(id, { stopActivity: true })` first (stops work
and clears the main view when the deleted session is open, releasing the client
reference that keeps it live), then POSTs the delete route. Failures surface
the host message in the dialog; a failed delete after the archive step leaves
the session archived — hidden but restorable via “unarchive”.

Requires only baseline browser modules (`react`, `@deepseek-ai/dsh-client-store`,
`@deepseek-ai/dsh-client-ui-primitives`) and node builtins on the host — the
package declares **no dependencies and no dsh peer ranges**, so it raises no
version-exemption friction and resolves in any dsh runtime. The slot owner's
README explicitly instructs resolving `MenuItemButton` through the loader
require; the tradeoff is coupling to the pinned composition's primitives.

## Install

The package is a cordis bundle: `package.json` declares
`dsh.bundle.patch` + `dsh.client`, `cordis.patch.yml` inserts the
`session-delete` row, and the profile's `dsh.profile.bundles` selects it.

```pwsh
# 1. install (any of these)
dsh plugin add github:rhl88/dsh-session-delete        # from this repository (recommended)
dsh plugin add D:\path\to\dsh-session-delete          # from a local directory
dsh plugin add D:\path\to\local-dsh-session-delete-1.0.0.tgz   # from a packed tarball

# equivalently, by hand, from the profile directory:
cd C:\Users\Administrator\.dsh\profiles\desktop
pnpm add github:rhl88/dsh-session-delete

# 2. `dsh plugin add` and the Plugins page enable the bundle by default.
#    Only the manual `pnpm add` route needs the selection written into
#    "dsh": { "profile": { "bundles": [
#       "@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-session-remove" ] } }

# 3. restart the app, then refresh the GUI page
```

Two notes:

- **Install exactly one copy.** The row id (`session-delete`) and the browser
  slot ids are fixed, so two installations of this plugin — for example the
  published `dsh-session-remove` *and* a local revisioned mirror such as the
  `-v2` copy this desktop profile was verified with — selected at once collide.
  Remove the other one first: `pnpm remove @local/dsh-session-delete-v2`.
- **Host-half changes need an app restart.** The desktop composition sets the
  HMR row to `root: []` — module watching is off, only profile configuration
  reloads — and re-importing the *same* module URL returns the cached copy.

This workspace directory is the canonical source. The live desktop profile was
verified with a *revisioned mirror* of it,
`C:\Users\Administrator\.dsh\local-plugins\dsh-session-delete-v2\` (identical
files, package name suffixed `-v2`, matching client module id), created so a
fixed host half could be loaded without an app restart. Switching the profile
back to this canonical package is a bundle-list edit plus a restart.


## Debugging a stalled delete

Both halves record progress, so a hang can be located without a browser console:

- `session-delete.debug.log` next to the deployed `index.js` — one line per host
  step (request, fence, body, stat, locate, archive, dispose wait, rm, cache,
  accounting, response), plus a 90 s request watchdog.
- `session-delete.client.log` — the browser half's markers (`confirm`,
  `archive`, `delete: posting`, status), posted to `POST /session-delete/trace`.

Both are plain append-only debug artifacts, safe to delete. The delete route is
deliberately independent of the registry: every registry call is timeout-guarded
and non-fatal, so a wedged workspace operation queue cannot strand a delete —
the files are removed and the response reports the degraded steps.

## Tests

```pwsh
node test/paths.test.js         # path encoding, checked against the real ~/.dsh layout
node test/module-load.test.js   # host/client module shape, baseline-only requires
node test/delete-flow.test.js   # the real route against fixture directories:
                                # plain delete, wedged registry, busy session,
                                # trust fence, unknown id, malformed bodies,
                                # hung persistence stat (scan fallback)
```


## Configuration (cordis row config)

| key | default | meaning |
| --- | --- | --- |
| `timeoutMs` | `20000` | bounded wait for live-session dispose (clamped 1 s–5 min) |
| `sessionsRoot` | `$DSH_HOME/sessions` | JSONL backend root override |
| `storagesRoot` | `$DSH_HOME/storages` | storage root override (projection cache) |

## Development notes

- `paths.js` holds the pure path helpers (import-free); `test/paths.test.js`
  unit-tests them, including spot checks against this machine's real
  `~/.dsh` layout (read-only).
- Session ids never touch the filesystem raw: `encodeSegment` is injective and
  traversal-safe; record-file names are restricted to the storage backends'
  path-safe key class.
- Deleting a session with subagent descendants removes only the named session;
  descendant logs stay on disk (their rows are sidebar-hidden).
