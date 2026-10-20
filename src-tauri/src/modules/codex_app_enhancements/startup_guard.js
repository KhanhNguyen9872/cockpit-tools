// A startup-only document reload may activate prepared native modules. Never
// turn a background reattachment into a reload of an editor already in use.
(() => {
  const root = typeof window === 'object' ? window : globalThis;
  if (root.__cockpitStartupGuard) return;
  const doc = root.document;
  const started = Date.now();
  const quietMs = 1000;
  let claimed = false, pointerHeld = false, composing = false;
  const events = ['pointerdown', 'pointerup', 'pointercancel', 'keydown', 'keyup',
    'beforeinput', 'input', 'paste', 'drop', 'compositionstart', 'compositionend'];
  // Counts also cover input before CDP attached. They are an idle signal, not
  // evidence that an empty composer has unsaved work for the rest of its life.
  const readCounts = () => {
    const counts = root.performance?.eventCounts;
    return counts && typeof counts.get === 'function'
      ? events.map(name => Number(counts.get(name) || 0)) : null;
  };
  let previousCounts = readCounts();
  let lastActivity = previousCounts?.some(Boolean) ? started : started - quietMs;
  const onInput = event => {
    if (event.isTrusted === false) return;
    lastActivity = Date.now();
    if (event.type === 'pointerdown') pointerHeld = true;
    if (event.type === 'pointerup' || event.type === 'pointercancel') pointerHeld = false;
    if (event.type === 'compositionstart') composing = true;
    if (event.type === 'compositionend') composing = false;
  };
  events.forEach(name => doc?.addEventListener(name, onInput, true));
  const visible = node => node?.isConnected !== false && node.getClientRects().length > 0
    && !node.closest('[hidden],[inert],[aria-hidden="true"]');
  function inspect() {
    if (root.top !== root || root.location?.protocol !== 'app:' || root.location?.hostname !== '-')
      return 'unsupported-document';
    if (claimed) return 'already-claimed';
    if (Date.now() - started > 45000) return 'startup-expired';
    const counts = readCounts();
    if (counts && previousCounts && counts.some((value, index) => value !== previousCounts[index]))
      lastActivity = Date.now();
    previousCounts = counts;
    if (pointerHeld || composing) return 'ui-busy';
    if (Date.now() - lastActivity < quietMs) return 'interaction-settling';
    if (!doc || doc.readyState !== 'complete') return 'document-loading';
    if (root.__cockpitEnhancements?.nativePatchState === 'active') return 'already-active';
    if ([...doc.querySelectorAll('[role="menu"], [role="listbox"], [role="dialog"], dialog[open], .codex-dialog-overlay')].some(visible))
      return 'ui-busy';
    const editors = [...doc.querySelectorAll('.ProseMirror[contenteditable="true"], textarea')].filter(visible);
    if (!editors.length) return 'composer-unavailable';
    for (const editor of editors) {
      if (String(editor.value ?? editor.textContent ?? '').trim()) return 'draft-present';
      if (editor.querySelector('[contenteditable="false"], img, audio, video, pre')) return 'draft-present';
    }
    const protectedSelector = '[data-composer-attachment-pill], [data-attachment-thumbnail-source], '
      + '[data-appshot-attachment], [data-dictation-view], '
      + '[aria-busy="true"], [role="progressbar"], [data-message-id], [data-turn-id], '
      + '[data-message-author-role], [data-local-conversation-user-anchor], '
      + '[data-virtualized-turn-content], [data-turn-key], [data-user-message-bubble], '
      + '[data-content-search-turn-key], article, '
      + '[class*="ConversationTurn"], [class*="UserMessage"], [class*="AssistantMessage"]';
    if ([...doc.querySelectorAll(protectedSelector)].some(visible)) return 'conversation-busy';
    return null;
  }
  function claim() {
    const reason = inspect();
    if (reason) return { ok: false, reason };
    claimed = true;
    return { ok: true, reason: 'clean-startup' };
  }
  function reload() {
    const result = claim();
    if (!result.ok) return result;
    try {
      // Check and navigation run synchronously, so no input event can arrive
      // between the final draft check and initiating this single reload.
      root.location.reload();
      return result;
    } catch { return { ok: false, reason: 'reload-failed' }; }
  }
  function dispose() {
    events.forEach(name => doc?.removeEventListener(name, onInput, true));
  }
  root.__cockpitStartupGuard = { inspect, claim, reload, dispose };
})();
