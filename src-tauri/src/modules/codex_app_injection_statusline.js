// Runs inside the serialized CDP wrapper. All user-facing labels come from i18n.
(() => {
  const root = window.__cockpitCodexInjection || (window.__cockpitCodexInjection = {});
  const ownSelector = '[data-cockpit-quota-footer], [data-cockpit-quota-details], [data-cockpit-quota-style]';
  if (root.statuslineVersion !== 11) {
    root.observer?.disconnect();
    root.layoutObserver?.disconnect();
    if (root.watchdogTimer) window.clearInterval(root.watchdogTimer);
    if (root.resizeHandler) window.removeEventListener('resize', root.resizeHandler);
    if (root.scrollHandler) window.removeEventListener('scroll', root.scrollHandler, true);
    if (root.keyHandler) window.removeEventListener('keydown', root.keyHandler);
    if (root.outsidePointerHandler) window.removeEventListener('pointerdown', root.outsidePointerHandler, true);
    document.querySelectorAll(ownSelector).forEach(node => node.remove());
    root.observer = null;
    root.watchdogTimer = null;
    root.resizeHandler = null;
    root.scrollHandler = null;
    root.keyHandler = null;
    root.outsidePointerHandler = null;
    root.layoutObserver = null;
    root.layoutNodes = null;
    root.metricNodes = null;
    root.metricHost = null;
    usageDialog.reset(root);
    root.statuslineVersion = 11;
  }
  const staleBalanceRoot = window.__cockpitDeepSeekBalance;
  if (staleBalanceRoot) {
    if (staleBalanceRoot.watchdogTimer) window.clearInterval(staleBalanceRoot.watchdogTimer);
    staleBalanceRoot.observer?.disconnect();
    if (staleBalanceRoot.resizeHandler) window.removeEventListener('resize', staleBalanceRoot.resizeHandler);
    if (staleBalanceRoot.scrollHandler) window.removeEventListener('scroll', staleBalanceRoot.scrollHandler, true);
    badgeLayout.disconnect(staleBalanceRoot);
    delete window.__cockpitDeepSeekBalance;
  }
  document.querySelectorAll('[data-cockpit-deepseek-balance], [data-cockpit-deepseek-balance-details]').forEach(node => node.remove());
  root.hostHeartbeatAt = Date.now();
  root.hostAvailable = true;
  root.providerName = providerName;
  root.weeklyPercent = weeklyPercent;
  root.fiveHourPercent = fiveHourPercent;
  const pendingRefreshToken = typeof root.refreshRequestToken === 'string' && root.refreshRequestToken !== handledRefreshToken
    ? root.refreshRequestToken : null;
  root.refreshing = refreshInProgress || Boolean(pendingRefreshToken);
  if (handledRefreshToken && root.refreshRequestToken === handledRefreshToken) root.refreshRequestToken = null;
  // A newly acknowledged request clears the preceding error even before it finishes.
  const refreshResultKey = String(handledRefreshToken || '') + '|' + String(refreshError || '');
  if (root.refreshing) root.refreshError = null;
  else if (root.refreshResultKey !== refreshResultKey) {
    root.refreshError = refreshError;
    root.refreshResultKey = refreshResultKey;
  }
  root.usageState = usageState;
  let observedModelThisRender = null;

  const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  const formatPercent = value => Number.isFinite(value) ? Math.round(value) + '%' : missingLabel;
  const shortProductLabel = value => {
    const text = String(value || '').trim();
    return text.replace(/^grok[\s_\-]*/i, '') || text || 'Grok';
  };
  const formatMoney = (value, currency) => {
    if (!Number.isFinite(value)) return missingLabel;
    const symbols = { CNY: '¥', RMB: '¥', USD: '$', EUR: '€' };
    const symbol = symbols[String(currency || '').toUpperCase()];
    return symbol ? symbol + value.toFixed(2) : value.toFixed(2) + (currency ? ' ' + currency : '');
  };
  const classifyModel = value => {
    const slug = String(value || '').trim().toLowerCase();
    if (!slug) return null;
    if (slug.includes('deepseek')) return 'deepseek';
    if (slug.includes('grok')) return 'grok';
    if (slug.includes('gpt') || slug.includes('codex') || slug.includes('openai') || /^[0-9]/.test(slug)) return 'codex';
    return null;
  };
  // Color the displayed remaining percentage exactly as the account overview.
  // Pool totals stay sums; speed, cache and monetary balances never use this scale.
  const quotaTone = usageDialog.quotaTone;
  const metricField = (key, label, value, hint, options = {}) => ({ key, label, value, hint,
    usage: Boolean(options.usage), stale: Boolean(options.stale), unknown: Boolean(options.unknown),
    tone: options.tone ?? null, unit: options.unit || '' });

  function syncMetrics(host, fields, count) {
    if (root.metricHost !== host || !root.metricNodes) {
      root.metricHost = host;
      root.metricNodes = new Map();
    }
    const keys = new Set(fields.map(field => field.key));
    for (const [key, node] of root.metricNodes) {
      if (!keys.has(key)) { node.remove(); root.metricNodes.delete(key); }
    }
    const visible = fields.slice(0, count);
    const visibleKeys = new Set(visible.map(field => field.key));
    for (const field of fields) {
      let node = root.metricNodes.get(field.key);
      if (!node) {
        node = document.createElement('span');
        node.setAttribute('data-cockpit-quota-metric', '');
        node.setAttribute('data-cockpit-metric-key', field.key);
        root.metricNodes.set(field.key, node);
      }
      // Keep labels, numbers and units distinct without replacing the focused
      // parent button or detaching unchanged metric nodes on every poll.
      const content = (field.key === 'speed' ? '<span data-cockpit-metric-icon aria-hidden="true">↗</span>' : '')
        + (field.label ? '<span data-cockpit-metric-label>' + escapeHtml(field.label) + ' </span>' : '')
        + '<span data-cockpit-metric-value>' + escapeHtml(field.value) + '</span>'
        + (field.unit ? '<span data-cockpit-metric-unit> ' + escapeHtml(field.unit) + '</span>' : '');
      if (node.__cockpitMetricContent !== content) {
        node.innerHTML = content;
        node.__cockpitMetricContent = content;
      }
      node.setAttribute('title', field.hint);
      node.setAttribute('aria-label', [field.label, field.value, field.unit].filter(Boolean).join(' '));
      if (field.usage) node.setAttribute('data-cockpit-session-metric', '');
      else node.removeAttribute('data-cockpit-session-metric');
      if (field.stale) node.setAttribute('data-stale', 'true');
      else node.removeAttribute('data-stale');
      if (field.tone) node.setAttribute('data-cockpit-quota-tone', field.tone);
      else node.removeAttribute('data-cockpit-quota-tone');
      if (field.unknown) node.setAttribute('data-cockpit-metric-unknown', '');
      else node.removeAttribute('data-cockpit-metric-unknown');
      if (!visibleKeys.has(field.key)) node.remove();
    }
    visible.forEach((field, index) => {
      const node = root.metricNodes.get(field.key);
      if (host.children[index] !== node) host.insertBefore(node, host.children[index] || null);
    });
  }
  function placeDetails(details, host) {
    const anchor = host.getBoundingClientRect();
    const width = Math.min(660, Math.max(0, window.innerWidth - 24));
    details.style.width = width + 'px';
    details.style.left = Math.max(12, Math.min(anchor.left + (anchor.width - width) / 2, window.innerWidth - width - 12)) + 'px';
    usageDialog.fit(details);
    const height = details.getBoundingClientRect().height;
    // Keep the complete dialog inside the viewport, even when it must overlap the composer.
    details.style.top = Math.max(12, Math.min(anchor.top - height - 8, window.innerHeight - height - 12)) + 'px';
  }
  function setDetailsOpen(open, trigger, restoreFocus = true) {
    root.quotaDetailsOpen = open;
    if (trigger) root.lastTrigger = trigger;
    if (!open) root.refreshError = null;
    root.render();
    if (open) document.querySelector('[data-cockpit-quota-close]')?.focus();
    else if (restoreFocus) {
      root.lastTrigger = document.querySelector('[data-cockpit-quota-footer]');
      if (root.lastTrigger?.isConnected) root.lastTrigger.focus();
    }
  }
  function render() {
    let host = document.querySelector('[data-cockpit-quota-footer]');
    let details = document.querySelector('[data-cockpit-quota-details]');
    const card = usageMetrics.visibleCard();
    const footer = card?.querySelector('[class*="_ComposerLayoutFooter_"], [class*="_footer_"]') || card;
    const permissions = footer && [...footer.querySelectorAll('[data-composer-navigation-target="permissions"]')].find(node => node.getClientRects().length > 0);
    if (!card || !permissions) {
      if (host) host.style.display = 'none';
      if (details) details.style.display = 'none';
      root.quotaDetailsOpen = false;
      root.threadId = '';
      root.visibleModelFooter = null;
      badgeLayout.disconnect(root);
      return;
    }
    const modelTrigger = [...footer.querySelectorAll('[data-composer-navigation-target="reasoning"]')].find(node => node.getClientRects().length > 0);
    const nextThreadId = usageMetrics.threadId(card);
    if (root.threadId !== nextThreadId || root.card !== card) {
      root.quotaDetailsOpen = false;
      root.refreshError = null;
      root.threadId = nextThreadId;
      root.card = card;
      root.lastTrigger = null;
      root.lastTriggerIndex = 0;
      usageDialog.reset(root);
    }
    if (!host) {
      host = document.createElement('button');
      host.setAttribute('type', 'button');
      host.setAttribute('data-cockpit-quota-footer', 'true');
      host.setAttribute('data-cockpit-quota-open', 'true');
      host.setAttribute('aria-haspopup', 'dialog');
      host.setAttribute('aria-controls', 'cockpit-quota-details');
      host.setAttribute('aria-label', usageLabels.title);
    }
    // Preserve the original adaptive toolbar gap without changing composer height.
    if (host.parentElement !== document.body) document.body.appendChild(host);
    host.style.display = 'flex';
    if (root.visibleModelFooter !== footer) {
      root.visibleModel = null;
      root.visibleModelAt = 0;
      root.visibleModelFooter = footer;
    }
    const readVisibleModel = () => {
      const nodes = [];
      if (modelTrigger) {
        nodes.push(modelTrigger.querySelector('[class*="ModelPickerTriggerModelLabel_"]'));
        nodes.push(modelTrigger.querySelector('[class*="ModelPickerTriggerModelGroup_"]'));
        nodes.push(modelTrigger.querySelector('[class*="ModelPickerTriggerContent_"]'));
        nodes.push(modelTrigger);
      }
      const dropdown = [...document.querySelectorAll('[class*="ModelPickerDropdownContent_"]')].find(node => node.getClientRects().length > 0);
      if (dropdown) {
        nodes.push(dropdown.querySelector('[data-model-picker-model-row]'));
        nodes.push(dropdown.querySelector('[class*="ViewToggleModelLabel_"]'));
      }
      for (const node of nodes) {
        if (!node || node.getClientRects().length === 0) continue;
        const text = String(node.textContent || '').replace(/\s+/g, ' ').trim();
        if (classifyModel(text)) return text;
      }
      return '';
    };
    const visibleModel = readVisibleModel();
    if (visibleModel) {
      root.visibleModel = visibleModel;
      root.visibleModelAt = Date.now();
      observedModelThisRender = visibleModel;
    }
    const modelStickyMs = 15000;
    const stickyFresh = Boolean(root.visibleModel) && Date.now() - (root.visibleModelAt || 0) <= modelStickyMs;
    const selectedModel = stickyFresh ? root.visibleModel : (fallbackModel || '');
    const badgeKind = classifyModel(selectedModel) || hostBadgeKind;
    const data = root.threadId && root.usageState[root.threadId];
    const snapshot = data?.threadId === root.threadId ? usageMetrics.snapshot(data.events, Date.now(), data.currentTurnId) : null;
    // Only an exact current-thread request-log measurement may supply speed.
    // Rollout token-count intervals include tool/wait time and are never a fallback.
    const measured = data?.threadId === root.threadId && data.outputSpeed?.threadId === root.threadId
      ? data.outputSpeed : null;
    const rate = typeof measured?.tokensPerSecond === 'number' && Number.isFinite(measured.tokensPerSecond)
      && measured.tokensPerSecond > 0 && Number.isInteger(measured.samples) && measured.samples > 0
      && Number.isFinite(measured.observedAtMs) && measured.observedAtMs > 0 ? measured.tokensPerSecond : null;
    const speedValue = rate === null ? missingLabel : rate >= 1 ? String(Math.round(rate))
      : rate < 0.1 ? '< 0.1' : rate.toFixed(1);
    const speedStale = rate !== null && Date.now() - measured.observedAtMs > 120000;
    const speed = speedValue + ' tok/s';
    const cache = snapshot?.cache == null ? missingLabel : snapshot.cache.toFixed(1) + '%';
    const fields = [];
    if (badgeKind === 'deepseek') {
      const line = balanceLines[0];
      const text = balanceLabel + ' ' + (line ? formatMoney(line.totalBalance, line.currency) : missingLabel);
      fields.push(metricField('deepseek', balanceLabel, line ? formatMoney(line.totalBalance, line.currency) : missingLabel, text,
        { unknown: !line }));
    } else if (badgeKind === 'grok') {
      const grokPercent = formatPercent(grokBadgePercent);
      const text = shortProductLabel(grokBadgeProduct) + ' ' + grokPercent;
      fields.push(metricField('grok', shortProductLabel(grokBadgeProduct), grokPercent, quotaOverviewLabel + ' ' + text,
        { tone: quotaTone(grokBadgePercent,'grok'), unknown: !Number.isFinite(grokBadgePercent) }));
    } else {
      if (Number.isFinite(fiveHourPercent)) {
        fields.push(metricField('five-hour', fiveHourLabel, Math.round(fiveHourPercent) + '%', usageLabels.aggregateHint,
          { tone: quotaTone(fiveHourPercent) }));
      }
      if (Number.isFinite(weeklyPercent)) {
        fields.push(metricField('weekly', weeklyLabel, Math.round(weeklyPercent) + '%', usageLabels.aggregateHint,
          { tone: quotaTone(weeklyPercent) }));
      }
      if (!fields.length) {
        fields.push(metricField('five-hour', fiveHourLabel, missingLabel, quotaEmptyLabel, { unknown: true }));
        fields.push(metricField('weekly', weeklyLabel, missingLabel, quotaEmptyLabel, { unknown: true }));
      }
    }
    // Keep summary numbers compact. Full precision and all four values remain in the dialog.
    const quotaFieldCount = fields.length;
    const cacheShort = snapshot?.cache == null ? missingLabel : Math.round(snapshot.cache) + '%';
    const sampleTime = rate !== null ? new Date(measured.observedAtMs).toLocaleString() : '';
    fields.push(metricField('speed', '', speedValue, usageLabels.speedHint
      + (speedStale ? ' ' + usageLabels.recent : '') + (sampleTime ? ' · ' + sampleTime : ''),
      { usage: true, stale: speedStale, unit: 'tok/s', unknown: rate === null }));
    fields.push(metricField('cache', usageLabels.cacheShort, cacheShort, usageLabels.cacheHint,
      { usage: true, unknown: snapshot?.cache == null }));
    let placement = null;
    // Keep the original measured gap. Yield cache first, then speed, without
    // moving native controls or changing the composer's height.
    for (let count = fields.length; count >= quotaFieldCount; count--) {
      // Keep stable nodes and measure the whole strip, including its shared shell.
      syncMetrics(host, fields, count);
      placement = badgeLayout.place(root, host, footer, permissions);
      if (placement) break;
    }
    if (!placement) root.quotaDetailsOpen = false;
    host.setAttribute('aria-expanded', String(Boolean(root.quotaDetailsOpen)));
    host.onclick = () => setDetailsOpen(!root.quotaDetailsOpen, host);
    if (!details) {
      details = document.createElement('section');
      details.setAttribute('id', 'cockpit-quota-details');
      details.setAttribute('data-cockpit-quota-details', 'true');
      details.setAttribute('role', 'dialog');
      details.setAttribute('aria-modal', 'false');
      details.setAttribute('aria-label', usageLabels.title);
      document.body.appendChild(details);
    }
    details.style.display = root.quotaDetailsOpen ? 'flex' : 'none';
    if (root.quotaDetailsOpen) {
      usageDialog.render(root, details, {badgeKind, speed, cache, formatMoney, shortProductLabel});
      details.querySelector('[data-cockpit-quota-close]').onclick = () => setDetailsOpen(false);
      const refreshButton = details.querySelector('[data-cockpit-quota-refresh]');
      refreshButton.onclick = () => {
        if (root.refreshing || root.hostAvailable === false) return;
        root.refreshError = null;
        usageDialog.refresh(root);
        root.refreshRequestToken = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
        root.refreshing = true;
        root.render();
      };
      placeDetails(details, host);
    }
  }
  root.render = render;
  root.scheduleRender = () => {
    if (root.renderScheduled) return;
    root.renderScheduled = true;
    requestAnimationFrame(() => { root.renderScheduled = false; root.render(); });
  };
  if (!root.resizeHandler) {
    root.resizeHandler = () => root.scheduleRender();
    window.addEventListener('resize', root.resizeHandler, {passive:true});
  }
  if (!root.scrollHandler) {
    root.scrollHandler = () => root.scheduleRender();
    window.addEventListener('scroll', root.scrollHandler, {passive:true,capture:true});
  }
  if (!root.keyHandler) {
    root.keyHandler = event => {
      if (event.key === 'Escape' && root.quotaDetailsOpen) {
        event.preventDefault();
        setDetailsOpen(false);
      }
    };
    window.addEventListener('keydown', root.keyHandler);
  }
  if (!root.outsidePointerHandler) {
    root.outsidePointerHandler = event => {
      if (!root.quotaDetailsOpen || !event.target) return;
      const path = event.composedPath?.() || [];
      const inside = ['[data-cockpit-quota-details]', '[data-cockpit-quota-footer]'].some(selector => {
        const node = document.querySelector(selector);
        return node && (path.includes(node) || node.contains(event.target));
      });
      // The user explicitly requested outside dismissal for this usage dialog.
      // Capture before inner controls re-render; leave the outside action and focus intact.
      if (!inside) setDetailsOpen(false, null, false);
    };
    window.addEventListener('pointerdown', root.outsidePointerHandler, true);
  }
  if (!root.observer) {
    root.observer = new MutationObserver(mutations => {
      const relevant = mutations.some(mutation => {
        if (mutation.target.closest?.(ownSelector)) return false;
        if (mutation.type !== 'childList') return true;
        const changed = [...mutation.addedNodes, ...mutation.removedNodes];
        return changed.some(node => node.nodeType === 1 && !node.matches?.(ownSelector));
      });
      if (relevant) root.scheduleRender();
    });
    root.observer.observe(document.documentElement, {childList:true,subtree:true,characterData:true,attributes:true,
      attributeFilter:['class','style','hidden','aria-hidden','data-state','data-dictation-view','data-above-composer-conversation-id','data-composer-placement','data-app-action-sidebar-thread-selected','data-app-action-sidebar-thread-id']});
  }
  const styleText = `
      [data-cockpit-quota-footer]{appearance:none;-webkit-appearance:none;position:fixed;transform:translate(-50%,-50%);z-index:2;display:flex;align-items:center;justify-content:center;gap:0;width:max-content;height:28px;box-sizing:border-box;font:inherit;font-size:12px;font-weight:500;line-height:17px;color:var(--color-token-text-secondary,#737373);background:var(--color-token-main-surface-primary,#fff);border:1px solid rgba(127,127,127,.12);border-radius:9px;padding:0 6px;margin:0;white-space:nowrap;pointer-events:auto;cursor:pointer;box-shadow:none}
      [data-cockpit-quota-footer]::before{content:"";width:4px;height:4px;flex:0 0 4px;align-self:center;margin-inline:3px 4px;border-radius:50%;background:#8b7cdf;box-shadow:0 0 0 2px rgba(139,124,223,.10)}
      [data-cockpit-quota-details] button{appearance:none;-webkit-appearance:none;font:inherit;font-weight:inherit;line-height:inherit;color:inherit;background:transparent;border:0;padding:0;margin:0;cursor:pointer}
      [data-cockpit-quota-footer] [data-cockpit-quota-metric]{display:inline-flex;align-items:baseline;justify-content:center;gap:4px;box-sizing:border-box;border:0;border-radius:0;padding:0 5px;background:transparent;color:var(--color-token-text-primary,inherit);box-shadow:none;font-variant-numeric:tabular-nums}
      [data-cockpit-quota-footer] [data-cockpit-metric-label]{font-size:11px;font-weight:400;color:var(--color-token-text-secondary,#737373)}
      [data-cockpit-quota-footer] [data-cockpit-metric-value]{font-size:12px;font-weight:500}
      [data-cockpit-quota-footer] [data-cockpit-metric-unit]{font-size:10px;font-weight:400;color:var(--color-token-text-secondary,#737373)}
      [data-cockpit-quota-footer] [data-cockpit-metric-key="speed"]{border-inline-start:1px solid rgba(127,127,127,.18);margin-inline-start:3px;padding-inline-start:8px}
      [data-cockpit-quota-footer] [data-cockpit-metric-key="speed"] [data-cockpit-metric-value],[data-cockpit-quota-footer] [data-cockpit-metric-icon]{color:#3f729f;color:color-mix(in srgb,var(--color-token-text-primary,#202123) 30%,#5594c7)}
      [data-cockpit-quota-footer] [data-cockpit-metric-icon]{display:inline-block;width:10px;font-size:11px;font-weight:500;text-align:center}
      [data-cockpit-quota-footer] [data-cockpit-quota-tone="high"] [data-cockpit-metric-value]{color:var(--cockpit-quota-high)}
      [data-cockpit-quota-footer] [data-cockpit-quota-tone="medium"] [data-cockpit-metric-value]{color:var(--cockpit-quota-medium)}
      [data-cockpit-quota-footer] [data-cockpit-quota-tone="low"] [data-cockpit-metric-value]{color:var(--cockpit-quota-low)}
      [data-cockpit-quota-footer] [data-cockpit-quota-tone="critical"] [data-cockpit-metric-value]{color:var(--cockpit-quota-critical)}
      [data-cockpit-quota-footer] [data-cockpit-metric-unknown] [data-cockpit-metric-value],[data-cockpit-quota-footer] [data-cockpit-metric-unknown] [data-cockpit-metric-icon]{color:var(--color-token-text-secondary,#737373);font-weight:400}
      [data-cockpit-quota-footer]:hover{background:var(--color-token-main-surface-secondary,#fafafa)}
      [data-cockpit-quota-footer]:disabled{opacity:.5;cursor:default}
      [data-cockpit-quota-footer]:focus-visible{outline:2px solid var(--color-token-text-primary,currentColor);outline-offset:2px}
    ` + dialogStyles;
  let style = document.querySelector('[data-cockpit-quota-style]');
  if (!style) {
    style = document.createElement('style');
    style.setAttribute('data-cockpit-quota-style', 'true');
    document.head.appendChild(style);
  }
  if (style.textContent !== styleText) {
    style.textContent = styleText;
    const details = document.querySelector('[data-cockpit-quota-details]');
    if (details) delete details.__cockpitDialogSize;
  }
  if (!root.watchdogTimer) {
    root.watchdogTimer = window.setInterval(() => {
      const hostAvailable = Date.now() - (root.hostHeartbeatAt || 0) <= hostHeartbeatTimeoutMs;
      if (root.hostAvailable === hostAvailable && (hostAvailable || (!root.refreshing && !root.refreshRequestToken))) return;
      root.hostAvailable = hostAvailable;
      if (!hostAvailable) {
        root.refreshing = false;
        root.refreshRequestToken = null;
      }
      root.render();
    }, 1000);
  }
  render();
  return {refreshRequestToken: pendingRefreshToken, selectedModel: observedModelThisRender, threadId: root.threadId || null, dialogRequest: usageDialog.query(root)};
})()
