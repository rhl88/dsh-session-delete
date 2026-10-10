/**
 * Browser half of @local/dsh-session-delete.
 *
 * Adds a destructive "delete session" entry to the sidebar session context
 * menu (`sidebar.workspaces.session.menu.item`, order 500 — after pin/rename/
 * fork/archive — behind a separator) and a confirmation dialog on
 * `shell.overlay`.
 *
 * Confirm flow:
 *   1. Best-effort `ctx.uiWorkspace.archiveSession(id, { stopActivity: true })`
 *      — the shipped archive path stops running work and clears the main view
 *      when the deleted session is open, so the client releases its reference.
 *      A hop that stalls is logged and skipped after 20 s: the Host route
 *      archives on its own, and a stalled archive must not strand the dialog.
 *   2. `POST session-delete/delete` — the Host half removes durable artifacts;
 *      sidebar rows drop via the ordinary workspace feed.
 *
 * Every hop reports a marker to `POST session-delete/trace`, which the Host
 * half appends to `session-delete.client.log` next to the plugin — a stalled
 * delete can then be told apart from a stalled archive hop without a browser
 * console.
 *
 * Module requires are baseline platform seeds only (react, dsh-client-store,
 * dsh-client-ui-primitives), so no dsh.client.external/inject declarations
 * are needed. The ui-workspace README (the slot owner) explicitly instructs
 * resolving MenuItemButton through the loader require; these packages are
 * version-pinned in the shipped composition, the documented tradeoff for
 * slot plugins.
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-session-delete',
  factory(require) {
    var module = { exports: {} };
    var exports = module.exports;
    const React = require('react');
    const { createSnapshotStore } = require('@deepseek-ai/dsh-client-store');
    const {
      Button,
      IconTrashOutlineRegular,
      MenuItemButton,
      Modal,
    } = require('@deepseek-ai/dsh-client-ui-primitives');
    const h = React.createElement;

    /** Locale namespace owned by this plugin. */
    const NS = 'sessionDelete';

    /** Document-relative routes (same origin, cookies ride along). */
    const DELETE_ROUTE = 'session-delete/delete';
    const TRACE_ROUTE = 'session-delete/trace';

    /** Hop bounds: the archive hop is optional, the delete hop is the request. */
    const ARCHIVE_HOP_TIMEOUT_MS = 20000;
    const DELETE_HOP_TIMEOUT_MS = 120000;

    /** Scoped class names; token colors only, injected once per document. */
    const STYLE_ID = 'dsh-session-delete-style';
    const STYLE_TEXT = [
      '.dshsd-delete-action:not(:disabled){color:var(--dsw-alias-state-error-primary)}',
      '.dshsd-delete-error{color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:18px;margin-top:8px}',
    ].join('');

    const zh = {
      'menu.deleteSession': '删除会话',
      'confirm.title': '删除会话',
      'confirm.desc': '将永久删除“{title}”的会话记录及其完整历史，此操作不可恢复。如只需从列表移除，请改用归档。',
      'confirm.action': '删除',
      'confirm.archiving': '正在停止并归档会话…',
      'confirm.deleting': '正在删除会话…',
      'confirm.cancel': '取消',
      'confirm.close': '关闭',
    };

    const en = {
      'menu.deleteSession': 'Delete session',
      'confirm.title': 'Delete session',
      'confirm.desc': 'Permanently deletes the record of "{title}" with its full history. This cannot be undone — use Archive to only move it out of the list.',
      'confirm.action': 'Delete',
      'confirm.archiving': 'Stopping and archiving…',
      'confirm.deleting': 'Deleting session…',
      'confirm.cancel': 'Cancel',
      'confirm.close': 'Close',
    };

    /** Reject a promise that does not settle inside `ms`. */
    const withTimeout = (promise, ms, label) => new Promise((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => rejectPromise(new Error(`${label} timeout after ${ms} ms`)), ms);
      promise.then((value) => {
        clearTimeout(timer);
        resolvePromise(value);
      }, (error) => {
        clearTimeout(timer);
        rejectPromise(error);
      });
    });

    /** Menu entry: closes the menu and opens the confirmation dialog. */
    function DeleteSessionMenuItem({ sessionId, displayTitle, useMenuOpenState, requestSessionDelete, t }) {
      const [, setMenuOpen] = useMenuOpenState();
      return h(MenuItemButton, {
        danger: true,
        separatorBefore: true,
        icon: h(IconTrashOutlineRegular, { size: 14 }),
        onSelect: () => {
          setMenuOpen(false);
          requestSessionDelete(sessionId, displayTitle);
        },
      }, t('menu.deleteSession'));
    }

    /** Confirmation modal over the pending delete request, if any. */
    function SessionDeleteConfirmDialog({ useDeleteRequest, cancelSessionDelete, runSessionDelete, t }) {
      const request = useDeleteRequest((pending) => pending);
      if (request === null || request === undefined) return null;
      const busy = request.phase !== 'idle';
      const close = () => {
        if (!busy) cancelSessionDelete();
      };
      const label = request.phase === 'archiving' ? t('confirm.archiving')
        : request.phase === 'deleting' ? t('confirm.deleting')
          : t('confirm.action');
      return h(Modal, {
        open: true,
        onClose: close,
        closeLabel: t('confirm.close'),
        title: t('confirm.title'),
        description: t('confirm.desc', { title: request.displayTitle || request.sessionId }),
        footer: h(React.Fragment, null,
          h(Button, { variant: 'outline', disabled: busy, onClick: close }, t('confirm.cancel')),
          h(Button, {
            variant: 'outline',
            className: 'dshsd-delete-action',
            disabled: busy,
            onClick: () => runSessionDelete(request.sessionId),
          }, label)),
      }, request.error === null || request.error === undefined ? null
        : h('div', { className: 'dshsd-delete-error', role: 'alert' }, request.error));
    }

    /** Cordis services this browser plugin needs before it activates. */
    const inject = ['slots', 'locale', 'uiWorkspace'];

    /**
     * Plugin entry: registers dictionaries, the menu entry, and the overlay
     * dialog for the lifetime of the row.
     * @param ctx - browser plugin context.
     */
    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'session-delete: locale dictionaries');

      ctx.effect(() => {
        if (document.getElementById(STYLE_ID) !== null) return undefined;
        const style = document.createElement('style');
        style.id = STYLE_ID;
        style.textContent = STYLE_TEXT;
        document.head.appendChild(style);
        return () => style.remove();
      }, 'session-delete: scoped styles');

      /** Browser-side marker sink; never blocks or fails the flow. */
      const trace = (message) => {
        try {
          fetch(TRACE_ROUTE, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ message }),
          }).catch(() => {});
        } catch {
          // Tracing is diagnostic only.
        }
      };

      /** Pending confirmation: { sessionId, displayTitle, phase, error } | null. */
      const deleteRequest = createSnapshotStore(null);

      /** Open the confirmation dialog for one sidebar row. */
      const requestSessionDelete = (sessionId, displayTitle) => {
        deleteRequest.set({ sessionId, displayTitle, phase: 'idle', error: null });
      };

      /** Dismiss the dialog (never while a delete is in flight). */
      const cancelSessionDelete = () => {
        const pending = deleteRequest.getSnapshot();
        if (pending !== null && pending.phase === 'idle') deleteRequest.set(null);
      };

      /** One failure as a short user-facing string. */
      const messageOf = (error) => {
        if (error === null || error === undefined) return String(error);
        return error?.rpcError?.message ?? error?.message ?? String(error);
      };

      /** Archive (best effort, bounded), then delete; the dialog reports the outcome. */
      const runSessionDelete = async (sessionId) => {
        const pending = deleteRequest.getSnapshot();
        if (pending === null || pending.phase !== 'idle') return;
        trace(`confirm: ${sessionId}`);
        deleteRequest.set({ ...pending, phase: 'archiving', error: null });
        try {
          await withTimeout(
            Promise.resolve(ctx.uiWorkspace.archiveSession(sessionId, { stopActivity: true })),
            ARCHIVE_HOP_TIMEOUT_MS,
            'archive',
          );
          trace(`archive: ok ${sessionId}`);
        } catch (error) {
          trace(`archive: skipped ${messageOf(error)}`);
        }
        const current = deleteRequest.getSnapshot();
        deleteRequest.set({ ...(current ?? pending), phase: 'deleting', error: null });
        try {
          trace(`delete: posting ${sessionId}`);
          const response = await withTimeout(fetch(DELETE_ROUTE, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ sessionId }),
          }), DELETE_HOP_TIMEOUT_MS, 'delete');
          let payload = null;
          try {
            payload = await response.json();
          } catch {
            payload = null;
          }
          trace(`delete: status ${response.status} ${JSON.stringify(payload)}`);
          if (!response.ok || payload?.ok !== true) {
            throw new Error(`${payload?.message ?? 'delete failed'} (HTTP ${response.status})`);
          }
          deleteRequest.set(null);
        } catch (error) {
          trace(`delete: error ${messageOf(error)}`);
          deleteRequest.set({ sessionId, displayTitle: pending.displayTitle, phase: 'idle', error: messageOf(error) });
        }
      };

      const menuInjected = () => ({
        hooks: { deleteRequest },
        requestSessionDelete,
      });

      ctx.slots.inject('sidebar.workspaces.session.menu.item', () => ctx.slots.register({
        name: 'sidebar.workspaces.session.menu.item',
        id: 'delete',
        order: 500,
        locale: NS,
        inject: menuInjected,
      }, DeleteSessionMenuItem));

      const overlayInjected = () => ({
        hooks: { deleteRequest },
        cancelSessionDelete,
        runSessionDelete,
      });

      ctx.slots.inject('shell.overlay', () => ctx.slots.register({
        name: 'shell.overlay',
        id: 'session-delete-confirm',
        locale: NS,
        inject: overlayInjected,
      }, SessionDeleteConfirmDialog));
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
