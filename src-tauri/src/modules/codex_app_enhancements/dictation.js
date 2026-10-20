(function installCockpitDictation(config) {
  "use strict";
  if (window.top !== window || location.protocol !== "app:") return;
  const previous = globalThis.__cockpitApiDictation;
  if (previous?.session === config.session) return;
  previous?.dispose?.();

  // Only the transport is replaced. The client owns the microphone, recording
  // state, retry/cancel controls and editor transactions, including explicit send.
  const listeners = new Set();
  let disposed = false, acknowledged = false, lastAck = Date.now(), revision = 0, pending = null, reconnectTimer = null;
  const error = key => new Error(config.labels[key] || config.labels.failed);
  const aborted = () => new DOMException("", "AbortError");
  const notify = () => {
    revision++;
    for (const listener of listeners) { try { listener(); } catch {} }
  };
  function send(action, extra = {}) {
    if (disposed || typeof globalThis[config.binding] !== "function") return false;
    try {
      globalThis[config.binding](JSON.stringify({ session: config.session, action, ...extra }));
      return true;
    } catch { return false; }
  }
  function settle(request, failure, value, cancel = false) {
    if (pending !== request) return;
    if (cancel && request.sent) send("cancel", { requestId: request.id });
    pending = null;
    clearTimeout(request.timer);
    request.signal?.removeEventListener("abort", request.abort);
    if (failure) request.reject(failure);
    else request.resolve(value);
  }
  async function encode(blob, request) {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let output = "";
    for (let i = 0; i < bytes.length; i += 49152) {
      if (pending !== request) return null;
      output += btoa(String.fromCharCode(...bytes.subarray(i, i + 49152)));
      if (i && i % (49152 * 8) === 0) await new Promise(resolve => setTimeout(resolve, 0));
    }
    return output;
  }
  function transcribe(blob, options = {}) {
    if (options.signal?.aborted) return Promise.reject(aborted());
    if (!api.ready || pending) return Promise.reject(error("failed"));
    if (!(blob instanceof Blob) || !blob.size || blob.size > config.maxBytes)
      return Promise.reject(error(blob?.size > config.maxBytes ? "tooLarge" : "failed"));
    const mime = options.contentType || blob.type || "audio/webm";
    if (!/^audio\/(webm|mp4|ogg|wav|x-wav|mpeg)(;|$)/.test(mime))
      return Promise.reject(error("unsupported"));
    if (options.language != null && options.language !== "" && (typeof options.language !== "string"
      || !/^[A-Za-z-]{1,32}$/.test(options.language))) return Promise.reject(error("unsupported"));
    return new Promise((resolve, reject) => {
      const request = { id: crypto.randomUUID(), resolve, reject, signal: options.signal, sent: false,
        abort: null, timer: null, sentAt: 0, options };
      pending = request;
      request.abort = () => settle(request, aborted(), undefined, true);
      options.signal?.addEventListener("abort", request.abort, { once: true });
      request.timer = setTimeout(() => settle(request, error("timedOut"), undefined, true), config.timeoutMs);
      void (async () => {
        try {
          const audio = await encode(blob, request);
          if (audio === null || pending !== request) return;
          const extra = { requestId: request.id, audio, mime };
          if (typeof options.language === "string" && options.language) extra.language = options.language;
          request.sentAt = Date.now();
          request.sent = true;
          if (!send("transcribe", extra)) { settle(request, error("failed")); return; }
          try { options.onRequestStart?.({ audioSentTs: request.sentAt }); } catch {}
        } catch { settle(request, error("failed")); }
      })();
    });
  }
  function dispose() {
    if (disposed) return;
    if (pending) settle(pending, aborted(), undefined, true);
    disposed = true;
    acknowledged = false;
    clearInterval(heartbeat);
    clearTimeout(reconnectTimer);
    window.removeEventListener("pagehide", dispose);
    notify();
    listeners.clear();
    try { delete globalThis[config.binding]; } catch {}
    if (globalThis.__cockpitApiDictation === api) delete globalThis.__cockpitApiDictation;
  }
  const api = {
    session: config.session,
    get ready() { return !disposed && acknowledged && Date.now() - lastAck <= 10000; },
    get revision() { return revision; },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    transcribe, dispose,
    receive(result) {
      if (disposed || result?.session !== config.session) return;
      lastAck = Date.now();
      clearTimeout(reconnectTimer); reconnectTimer = null;
      if (!acknowledged) { acknowledged = true; notify(); }
      if (result.alive) return;
      const request = pending;
      if (!request || !request.sent || result.requestId !== request.id) return;
      if (result.error) { settle(request, error(result.error)); return; }
      if (typeof result.text !== "string" || !result.text.trim() || result.text.length > 262144) {
        settle(request, error("failed")); return;
      }
      const text = result.text.trim(), receivedAt = Date.now();
      try { request.options.onRequestSuccess?.({ transcriptReceivedTs: receivedAt,
        transcriptLatencyMs: receivedAt - request.sentAt, transcriptLength: text.length }); } catch {}
      settle(request, null, { text });
    },
  };
  globalThis.__cockpitApiDictation = api;
  const heartbeat = setInterval(() => {
    if (Date.now() - lastAck > 10000 && acknowledged) { acknowledged = false; notify(); }
    // Renderer timers can resume late after sleep. Probe the still-live backend
    // once before disposing; pending scopes remain unavailable until its ACK.
    if (!acknowledged && reconnectTimer === null)
      reconnectTimer = setTimeout(dispose, 3000);
    if (!send("alive")) dispose();
  }, 2000);
  window.addEventListener("pagehide", dispose);
  send("ready");
})(__COCKPIT_DICTATION_CONFIG__);
