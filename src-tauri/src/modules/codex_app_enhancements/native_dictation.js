(() => {
  const root = typeof window === 'object' ? window : globalThis;
  const marker = '__cockpitNativeDictation';
  const boundHandlers = new WeakMap();
  const admittedScopes = new WeakSet();
  const capabilityArguments = new WeakMap();

  function configured(host, isChatGPT = false) {
    return host === 'local' && isChatGPT !== true
      && root.__cockpitEnhancements?.apiDictation === true;
  }

  function allowed(host, isChatGPT = false) {
    const bridge = root.__cockpitApiDictation;
    return configured(host, isChatGPT) && bridge?.ready === true
      && typeof bridge.transcribe === 'function';
  }

  function capabilityArgs(nativeArgs, host, isChatGPT) {
    if (!allowed(host, isChatGPT) || nativeArgs?.name !== 'dictation.composer') return nativeArgs;
    const apiKeyAuthVerified = root.__cockpitEnhancements?.apiKeyAuthVerified === true;
    let compatible = capabilityArguments.get(nativeArgs);
    if (!compatible || compatible.cockpitApiAuthVerified !== apiKeyAuthVerified) {
      // Native wc families key the entire sorted parameter object. This selects
      // a new family member after a policy upgrade or host verification change.
      // Globals are not reactive atom dependencies: retaining the old key could
      // reuse false eligibility forever without calling policyOverride again.
      // Native authentication and local settings remain reactive dependencies.
      compatible = Object.freeze({ ...nativeArgs, hostId: 'local', cockpitApiDictation: true,
        cockpitApiDictationPolicyVersion: 2, cockpitApiAuthVerified: apiKeyAuthVerified });
      capabilityArguments.set(nativeArgs, compatible);
    }
    return compatible;
  }

  function policyOverride(args, policy, auth) {
    // A provider with requires_openai_auth=false legitimately reports no native
    // account (ZIn: account=null -> authMethod=null, requiresAuth=false). Only
    // accept that shape when the host has verified this profile's API route.
    const apiAuth = ['apiKey', 'apikey'].includes(auth?.authMethod)
      || (auth?.authMethod === null && auth.requiresAuth === false
        && root.__cockpitEnhancements?.apiKeyAuthVerified === true);
    if (args?.cockpitApiDictation !== true || args.name !== 'dictation.composer'
      || !allowed(args.hostId) || !apiAuth
      || !['dictation', 'workspace-dictation'].includes(policy)) return null;
    if (policy === 'dictation'
      && (!root.navigator?.mediaDevices?.getUserMedia || typeof root.MediaRecorder === 'undefined')) {
      return { isLoading: false, isError: false, isCapable: false };
    }
    // Both original policies describe ChatGPT service eligibility: rollout
    // 4100906017 and chatgpt.workspace.feature.dictation.access. A local API
    // recording uses neither service. The separate native configFeatures loop
    // still applies in_app_dictation, including explicit user disablement.
    const isLoading = auth.authLoading === true;
    return { isLoading, isError: false, isCapable: !isLoading };
  }

  function captureScope(host) {
    if (!configured(host)) return null;
    const bridge = root.__cockpitApiDictation;
    const scope = Object.freeze({ host, bridge, session: bridge?.session });
    admittedScopes.add(scope);
    return scope;
  }

  // Wrap the client's existing stable event callback without adding React hooks
  // or changing its memo-cache size. Each recording receives its own transport
  // snapshot, while future recordings use the latest host and bridge.
  function scopedHandlers(handler, host) {
    let entry = boundHandlers.get(handler);
    if (!entry) {
      entry = { host, wrapper: null };
      entry.wrapper = function (...args) {
        return { ...Reflect.apply(handler, this, args), cockpitDictationScope: captureScope(entry.host) };
      };
      boundHandlers.set(handler, entry);
    }
    entry.host = host;
    return entry.wrapper;
  }

  async function transcribe(scope, blob, options, nativeTranscribe) {
    options?.signal?.throwIfAborted();
    if (scope == null) return nativeTranscribe(blob, options);
    const bridge = root.__cockpitApiDictation;
    if (!admittedScopes.has(scope) || !allowed(scope.host)
      || scope.bridge !== bridge || scope.session !== bridge?.session) {
      throw new DOMException('', 'AbortError');
    }
    const response = await bridge.transcribe(blob, options);
    options?.signal?.throwIfAborted();
    // A stop/restart while the request is finishing must not insert stale text.
    if (!allowed(scope.host) || root.__cockpitApiDictation !== bridge
      || scope.session !== bridge.session) {
      throw new DOMException('', 'AbortError');
    }
    if (response == null || typeof response.text !== 'string') {
      throw new TypeError();
    }
    return response;
  }

  // This contract is deliberately exact. It adapts the checked desktop module
  // without replacing official microphone UI, recording, cancel, retry or editor
  // behavior. An unfamiliar client build stays unchanged as one atomic group.
  const edits = [
    {
      name: 'capability-scope',
      from: 'let R=abd(L),z=l6u(r!=null),B=s&&z===!0,V=o&&B',
      to: 'let R=abd(L),z=l6u(r!=null,a),B=s&&z===!0,V=o&&B',
    },
    {
      name: 'capability-hook',
      from: 'function l6u(e){let t=(0,u6u.c)(2),n=e!==void 0&&e?`dictation.chatgpt`:`dictation.composer`,r;t[0]===n?r=t[1]:(r={name:n},t[0]=n,t[1]=r);let i=Eu(ty,r);return i.isLoading?null:i.isCapable}',
      to: 'function l6u(e,cockpitDictationHost){let t=(0,u6u.c)(2),n=e!==void 0&&e?`dictation.chatgpt`:`dictation.composer`,r;t[0]===n?r=t[1]:(r={name:n},t[0]=n,t[1]=r);let i=Eu(ty,globalThis.__cockpitNativeDictation.capabilityArgs(r,cockpitDictationHost,e===true));return i.isLoading?null:i.isCapable}',
    },
    {
      name: 'api-auth-policy',
      from: 'n.accessPolicies.map(e=>{let n=zKt[e];return n==null?{isLoading:!1,isError:!0,isCapable:!1}:t(n)})',
      to: 'n.accessPolicies.map(cockpitPolicy=>{let cockpitOverride=e.cockpitApiDictation===true?globalThis.__cockpitNativeDictation.policyOverride(e,cockpitPolicy,t(Ag)):null;if(cockpitOverride!==null)return cockpitOverride;let n=zKt[cockpitPolicy];return n==null?{isLoading:!1,isError:!0,isCapable:!1}:t(n)})',
    },
    {
      name: 'presentation',
      from: 'I=Eu(xUt,r!=null)&&p!=null,L;',
      to: 'I=Eu(xUt,r!=null)&&p!=null&&!globalThis.__cockpitNativeDictation.configured(a,r!=null),L;',
    },
    {
      name: 'composer-scope',
      from: '}=W3u({chatgpt:r,enabled:B,productSurface:c,',
      to: '}=W3u({cockpitDictationHost:r==null?a:null,chatgpt:r,enabled:B,productSurface:c,',
    },
    {
      name: 'streaming',
      from: 'n=Eu(xUt,e.chatgpt!=null),r;',
      to: 'n=Eu(xUt,e.chatgpt!=null)&&!globalThis.__cockpitNativeDictation.configured(e.cockpitDictationHost),r;',
    },
    {
      name: 'recording-scope',
      from: 'let Me=fu(je),Ne;t[25]===E',
      to: 'let Me=globalThis.__cockpitNativeDictation.scopedHandlers(fu(je),e.cockpitDictationHost),Ne;t[25]===E',
    },
    {
      name: 'recording-snapshot',
      from: 'Ee.current!=null&&(Oq()||Ee.current.chatgpt!=null)?Ee.current:Me()',
      to: 'Ee.current!=null&&(Oq()||Ee.current.chatgpt!=null||Ee.current.cockpitDictationScope!=null)?Ee.current:Me()',
    },
    {
      name: 'transcription',
      from: 'return YLo(n,{signal:i.abortController.signal,language:i.language})',
      to: 'return globalThis.__cockpitNativeDictation.transcribe(c.cockpitDictationScope,n,{signal:i.abortController.signal,language:i.language},YLo)',
    },
  ];

  function transform(source, url) {
    const fail = reason => ({ ok: false, patchedSource: source, diagnostics: { reason } });
    if (typeof source !== 'string' || source.length > 24 * 1024 * 1024) return fail('unsupported-source');
    if (root.__cockpitEnhancements?.apiDictation !== true) return fail('disabled');
    try {
      const parsed = new URL(url);
      if (parsed.username || parsed.password || parsed.search || parsed.hash
        || !((parsed.protocol === 'app:' && parsed.hostname === '-')
          || (parsed.protocol === 'file:' && !parsed.hostname))
        || !/\/app-initial-[\w-]+\.js$/.test(parsed.pathname)) return fail('unsupported-url');
    } catch { return fail('unsupported-url'); }

    // These surrounding contracts prove the scope path and exclude an unrelated
    // occurrence of a short minified fragment. YLo/XLo themselves remain intact.
    const contracts = [
      'sourceComposerScope:n,chatgpt:r,conversationId:i,executionTargetHostId:a,isComposerInputVisible:o,isDictationEnabled:s,',
      'function W3u(e){',
      'r={...e,cleanupEnabled:!1,dictationAudio:Oi?.dictationAudio,streamingEnabled:n}',
      'function G3u(e){',
      'async function YLo(e,t={}){',
      'async function XLo(e,t){',
      'chatgpt:n,onTranscriptStart:u,onTranscriptUpdate:d,onTranscriptCancel:f,onTranscriptInsert:p,',
      'kKt=Y(U,({get:e})=>{if(!navigator?.mediaDevices?.getUserMedia||typeof MediaRecorder>`u`)return{isLoading:!1,isError:!1,isCapable:!1};let t=e(ig,`4100906017`),n=e(rg,`4100906017`),{authLoading:r,authMethod:i}=e(Ag),a=r||t;return{isLoading:a,isError:!1,isCapable:!a&&n&&i===`chatgpt`}})',
      'MKt=Y(U,({get:e})=>e(ig,`770071981`)?{isLoading:!0,isError:!1,isCapable:!1}:e(rg,`770071981`)?SKt(e,[`chatgpt.workspace.feature.dictation.access`]):{isLoading:!1,isError:!1,isCapable:!0})',
      'dictation:{accessPolicy:`workspace-dictation`,configFeatures:[{key:`in_app_dictation`,host:`default`,clients:[`electron`,`extension`]}],supportedClients:[`browser`,`chrome-extension`,`electron`,`extension`],children:',
    ];
    const count = value => source.split(value).length - 1;
    if (contracts.some(value => count(value) !== 1)) return fail('dictation-contract-mismatch');
    if (source.includes(marker)) {
      // Reconnects re-enable runtime flags without editing the same functions twice.
      if (edits.every(edit => count(edit.to) === 1 && count(edit.from) === 0))
        return { ok: true, patchedSource: source, diagnostics: { reason: 'already-adapted' } };
      return fail('partial-dictation-adaptation');
    }
    const counts = Object.fromEntries(edits.map(edit => [edit.name, count(edit.from)]));
    if (Object.values(counts).some(value => value !== 1)) return fail('dictation-gates-not-unique');
    let patchedSource = source;
    for (const edit of edits) patchedSource = patchedSource.replace(edit.from, edit.to);
    return { ok: true, patchedSource, diagnostics: { reason: 'ready', gates: counts } };
  }

  const api = { configured, allowed, capabilityArgs, policyOverride, scopedHandlers, transcribe, transform };
  root.__cockpitNativeDictation = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})();
