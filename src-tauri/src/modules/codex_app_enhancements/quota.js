(() => {
  const root = typeof window === 'object' ? window : globalThis;
  const identifier = '[A-Za-z_$][\\w$]*';
  const selector = new RegExp(
    `(?<name>${identifier})=${identifier}\\(${identifier},\\((?<host>${identifier}),\\{get:(?<get>${identifier})\\}\\)=>(?<expression>\\k<get>\\((?<family>${identifier}),\\k<host>\\)\\.hardBlocked)\\)`,
    'g',
  );

  function enabledFor(host) {
    return host === 'local' && root.__cockpitEnhancements?.quotaCompat === true;
  }

  // Change only the derived send guard. Server usage, image limits, credits and
  // query cache objects remain untouched. Unknown client structures fail closed.
  function transform(source, url) {
    const failed = reason => ({ ok: false, patchedSource: source, diagnostics: { reason } });
    if (typeof source !== 'string' || source.includes('__cockpitQuotaCompat.enabledFor')) {
      return failed('unsupported-source');
    }
    try {
      const parsed = new URL(url);
      if (!((parsed.protocol === 'app:' && parsed.hostname === '-')
        || (parsed.protocol === 'file:' && !parsed.hostname))) return failed('unsupported-url');
    } catch { return failed('unsupported-url'); }
    const matches = [...source.matchAll(selector)];
    if (matches.length !== 1) return failed('quota-selector-not-unique');
    const match = matches[0];
    const { family, expression, host } = match.groups;
    const context = source.slice(Math.max(0, match.index - 6000), match.index);
    const familyStart = context.lastIndexOf(`${family}=`);
    const familySource = familyStart < 0 ? '' : context.slice(familyStart);
    if (!familySource.includes('hardBlocked:')
      || !familySource.includes('rate_limit?.allowed')
      || !(familySource.includes('`chatgpt`')
        || (familySource.includes('authenticatedAccountId') && familySource.includes('user_id')))) {
      return failed('quota-contract-mismatch');
    }
    const offset = match.index + match[0].lastIndexOf(expression);
    const replacement = `(${expression}&&!globalThis.__cockpitQuotaCompat.enabledFor(${host}))`;
    return {
      ok: true,
      patchedSource: source.slice(0, offset) + replacement + source.slice(offset + expression.length),
      diagnostics: { reason: 'ready', selectors: 1 },
    };
  }

  const api = { enabledFor, transform };
  root.__cockpitQuotaCompat = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})();
