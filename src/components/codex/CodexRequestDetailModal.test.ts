import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { loadHookModule, settlePromises } from '../../../tests/helpers/reactHookHarness';
import * as diagnostics from '../../utils/codexRequestDiagnostics';
import type { CodexLocalAccessRequestDetail } from '../../types/codexLocalAccess';

const identity = loadHookModule(new URL('./CodexRequestIdentityHeaders.tsx', import.meta.url), {
  'lucide-react': { Activity: 'Activity', Copy: 'Copy' },
});
const fallbackTrace = loadHookModule(new URL('./CodexCapabilityFallbackTrace.tsx', import.meta.url), {
  'react-i18next': { useTranslation: () => ({ t: (key: string) => key }) },
});

function text(value: any): string {
  if (value == null || typeof value === 'boolean') return '';
  if (Array.isArray(value)) return value.map(text).join('');
  if (typeof value?.type === 'function') return text(value.type(value.props));
  return typeof value === 'object' ? text(value.props?.children) : String(value);
}
const t = (key: string, values?: any) => values?.tier ? `${key}:${values.tier}` : values?.sequence ? `${key}:${values.sequence}` : values?.header ? `${key}:${values.header}` : key;
function harness(event: Record<string, unknown>, options: { detail?: CodexLocalAccessRequestDetail; writeText?: (value: string) => Promise<void>; onClose?: () => void } = {}) {
  const hook = loadHookModule(new URL('./CodexRequestDetailModal.tsx', import.meta.url), {
    'react-dom': { createPortal: (content: unknown) => content },
    'react-i18next': { useTranslation: () => ({ t }) },
    'lucide-react': Object.fromEntries(['Activity', 'CheckCircle2', 'ChevronDown', 'Clock3', 'Copy', 'FileJson', 'Gauge', 'Info', 'RefreshCw', 'Route', 'X', 'XCircle'].map((name) => [name, name])),
    '../../services/codexLocalAccessService': { getCodexLocalAccessRequestDetail: async () => options.detail ?? null },
    '../../utils/codexRequestDiagnostics': diagnostics,
    '../../hooks/useEscClose': { useEscCloseTopmost: () => {} },
    '../../hooks/useModalFocusTrap': { useModalFocusTrap: () => {} },
    '../../hooks/useModalScrollLock': { useModalScrollLock: () => {} },
    '../ModalErrorMessage': { ModalErrorMessage: 'ModalErrorMessage' },
    '../SingleSelectDropdown': { SingleSelectDropdown: 'SingleSelectDropdown' },
    './CodexRequestTimeoutHint': { CodexRequestTimeoutHint: 'CodexRequestTimeoutHint' },
    './CodexOutputSpeed': { CodexOutputSpeed: 'CodexOutputSpeed' },
    './CodexRequestIdentityHeaders': identity.exports,
    './CodexCapabilityFallbackTrace': fallbackTrace.exports,
  }, { document: { body: {} }, navigator: { clipboard: { writeText: options.writeText ?? (async () => {}) } } });
  hook.render(() => hook.exports.CodexRequestDetailModal({ event: { requestId: 'id', latencyMs: 100, ...event }, accountDisplayNames: new Map([['a','Account One'],['b','Account Two']]), maskAccountText: String, onClose: options.onClose ?? (() => {}) }));
  return hook;
}

test('a routing rejection shows its full error and local source without captured bodies or attempts', async () => {
  const hook = harness({ success: false, errorCategory: 'subscription_sharing_unsupported_capability', errorMessage: 'Standalone /alpha/search is not implemented by this gateway route' }, {
    detail: { requestId: 'id', failurePhase: 'routing', attempts: [], payloads: [], capturedAtMs: 1, truncated: false },
  });
  await settlePromises();
  const content = text(hook.flush());
  assert.match(content, /phases.routing/);
  assert.match(content, /sources.gateway/);
  assert.match(content, /subscription_sharing_unsupported_capability/);
  assert.match(content, /Standalone \/alpha\/search is not implemented/);
  assert.match(content, /toolExecutionHint/);
  hook.unmount();
});

test('an identical error code does not turn unknown history or a successful tool response into an upstream failure', async () => {
  const unknown = harness({ success: false, errorCategory: 'subscription_sharing_unsupported_capability', errorMessage: 'Recorded cause' });
  await settlePromises();
  assert.match(text(unknown.flush()), /sources.unknown/);
  unknown.unmount();
  const success = harness({ success: true, errorMessage: 'An MCP tool returned an error inside a successful model turn' });
  await settlePromises();
  assert.doesNotMatch(text(success.flush()), /requestDiagnostics.errorSource|sources.upstream/);
  success.unmount();
});

test('request details retain priority and raw default separately even without request-body recording', async () => {
  const hook = harness({ requestedServiceTier: 'priority', responseServiceTier: 'default', serviceTier: 'standard' });
  await settlePromises();
  const content = text(hook.flush());
  assert.match(content, /requestedTier:codex.speed.fast/);
  assert.match(content, /responseTier:default/);
  assert.match(content, /serviceTierHint/);
  assert.equal(content.includes('codex.speed.standard'), false);
  assert.equal(content.includes('legacyTier:'), false);
  hook.unmount();
});

function nodes(value: any, predicate: (value: any) => boolean): any[] {
  if (value == null || typeof value !== 'object') return [];
  if (Array.isArray(value)) return value.flatMap((node) => nodes(node, predicate));
  if (typeof value.type === 'function') return nodes(value.type(value.props), predicate);
  return [...(predicate(value) ? [value] : []), ...nodes(value.props?.children, predicate)];
}
function section(tree: any) {
  return nodes(tree, (node) => node.props?.className === 'codex-request-detail-section codex-request-identity')[0];
}
function detail(overrides: Partial<CodexLocalAccessRequestDetail> = {}): CodexLocalAccessRequestDetail {
  return { requestId:'id', attempts:[], payloads:[], capturedAtMs:1, truncated:false, ...overrides };
}
function attempt(sequence: number, overrides: Partial<CodexLocalAccessRequestDetail['attempts'][number]> = {}) {
  return { sequence, accountId:sequence===1?'a':'b', modelId:'m', transport:sequence===1?'http':'websocket', startedAtMs:1, latencyMs:1, success:true, ...overrides };
}

test('request details show recorded capability switches on their actual target attempts only', async () => {
  const hook = harness({}, { detail: detail({ attempts: [attempt(1), attempt(2, { capabilityFallback: {
    reason: 'upstream_unsupported', capabilities: ['web_search'], fromAccountId: 'a', fromModel: 'Source-Model', toAccountId: 'b', toModel: 'Target-Model',
  } })] }) });
  await settlePromises();
  const content = text(hook.flush());
  assert.equal((content.match(/capabilityFallback.traceTitle/g) ?? []).length, 1);
  for (const value of ['capabilityFallback.reasonUpstream', 'Source-Model', 'Target-Model', 'capabilityFallback.capability.web_search']) assert.ok(content.includes(value), value);
  assert.equal(content.includes('capabilityFallback.reasonPreflight'), false);
  hook.unmount();
});

test('session headers compare one client with each attempt independently of request body capture', async () => {
  const hook = harness({}, { detail:detail({ clientIdentityCaptured:true, clientSessionId:'original-root', clientThreadId:null,
    attempts:[attempt(1,{upstreamIdentityCaptured:true,upstreamSessionId:'mapped-root-a',upstreamThreadId:'mapped-thread-a'}),attempt(2,{upstreamIdentityCaptured:true,upstreamThreadId:'mapped-thread-b'})] }) });
  await settlePromises();
  const tree = section(hook.flush());
  const content = text(tree);
  for (const value of ['original-root','mapped-root-a','mapped-thread-a','mapped-thread-b','Account One','Account Two','http','websocket','identity.upstreamAttempt:1','identity.upstreamAttempt:2']) assert.ok(content.includes(value),value);
  assert.equal((content.match(/identity.notProvided/g) ?? []).length,2);
  assert.equal((content.match(/identity.notCaptured/g) ?? []).length,6);
  assert.equal(nodes(tree,(node)=>node.type==='button').length,4);
  assert.match(text(hook.flush()),/noPayloads/);
  hook.unmount();
});

test('old or explicit uncaptured headers are never inferred from body, payload headers or request id', async () => {
  for (const captured of [undefined,false]) {
    const hook = harness({}, { detail:detail({ clientIdentityCaptured:captured,clientSessionId:'must-ignore-client',clientThreadId:'must-ignore-thread',
      attempts:[attempt(1,{upstreamIdentityCaptured:captured,upstreamSessionId:'must-ignore-upstream',upstreamThreadId:'must-ignore-upstream-thread'})],
      payloads:[{stage:'client',transport:'http',contentType:'application/json',headers:{'Session-Id':'payload-header'},body:JSON.stringify({prompt_cache_key:'body-cache-key'}),truncated:false,originalBytes:1,sha256:''}] }) });
    await settlePromises();
    const tree = section(hook.flush());
    const content = text(tree);
    assert.equal((content.match(/identity.notCaptured/g) ?? []).length,8);
    assert.equal(content.includes('must-ignore'),false);
    assert.equal(content.includes('payload-header'),false);
    assert.equal(content.includes('body-cache-key'),false);
    assert.equal(nodes(tree,(node)=>node.type==='button').length,0);
    hook.unmount();
  }
});

test('request identity shows actual installation headers separately from the selected account profile and copies its complete scope', async () => {
  const scope = 'a'.repeat(64);
  const copied: string[] = [];
  const profile = {version:1,revision:2,scope,installationId:'11111111-1111-4111-8111-111111111111'};
  const hook = harness({}, {detail:detail({clientIdentityMetadataCaptured:true,clientInstallationId:'original-client-installation',clientChatgptAccountId:'original-client-workspace',
    attempts:[attempt(1,{upstreamIdentityMetadataCaptured:true,upstreamInstallationId:'actual-outbound-installation',upstreamChatgptAccountId:'actual-outbound-workspace',accountIdentity:profile}),
      attempt(2,{upstreamIdentityMetadataCaptured:true,accountIdentity:{...profile,scope:'b'.repeat(64),installationId:'22222222-2222-4222-8222-222222222222'}})]}),
    writeText:async value=>{copied.push(value);} });
  await settlePromises();
  const tree = section(hook.flush());
  const content = text(tree);
  for (const value of ['original-client-installation','original-client-workspace','actual-outbound-installation','actual-outbound-workspace',profile.installationId,scope,'22222222-2222-4222-8222-222222222222','identity.profileTitle','identity.profileHint']) assert.ok(content.includes(value),value);
  const cards = nodes(tree,node=>node.props?.className==='codex-request-identity-card');
  const headerLists = nodes(cards[2],node=>node.type==='dl');
  assert.equal((text(headerLists[0]).match(/identity.notProvided/g) ?? []).length,2);
  assert.equal(text(headerLists[0]).includes('22222222'),false,'a local profile is not evidence that an installation header was sent');
  const button = nodes(cards[1],node=>node.type==='button' && String(node.props['aria-label']).endsWith('identity.profileScope'))[0];
  button.props.onClick();
  await settlePromises();
  hook.flush();
  assert.deepEqual(copied,[scope]);
  hook.unmount();
});

test('older captured session headers do not imply installation metadata was captured', async () => {
  const hook = harness({}, {detail:detail({clientIdentityCaptured:true,clientSessionId:'known-session',clientInstallationId:'ignore-old-client-field',
    attempts:[attempt(1,{upstreamIdentityCaptured:true,upstreamThreadId:'known-thread',upstreamInstallationId:'ignore-old-upstream-field'})]})});
  await settlePromises();
  const content = text(section(hook.flush()));
  assert.ok(content.includes('known-session'));
  assert.ok(content.includes('known-thread'));
  assert.equal((content.match(/identity.notCaptured/g) ?? []).length,4);
  assert.equal(content.includes('ignore-old'),false);
  assert.equal(content.includes('identity.profileTitle'),false);
  hook.unmount();
});

test('captured missing headers and no send attempts have distinct states', async () => {
  const hook = harness({}, { detail:detail({clientIdentityCaptured:true,clientSessionId:'',clientThreadId:null}) });
  await settlePromises();
  const content = text(section(hook.flush()));
  assert.equal((content.match(/identity.notProvided/g) ?? []).length,2);
  assert.match(content,/identity.notSent/);
  assert.equal(content.includes('upstreamAttempt'),false);
  hook.unmount();
});

test('full long header copying keeps repeated failures in the dialog and clears them before retry', async () => {
  const longId = 'original/子-agent/'+'opaque'.repeat(1200);
  const copies:string[]=[];
  let fail = true;
  let closed = 0;
  const hook = harness({}, {detail:detail({clientIdentityCaptured:true,clientSessionId:longId}),writeText:async (value)=>{copies.push(value);if(fail)throw new Error('clipboard denied');},onClose:()=>{closed++;} });
  await settlePromises();
  for (let count=1;count<=2;count++) {
    const button = nodes(section(hook.flush()),(node)=>node.type==='button')[0];
    assert.match(button.props['aria-label'],/copyHeader:Session-Id/);
    button.props.onClick();
    await settlePromises();
    const tree = hook.flush();
    const error = nodes(tree,(node)=>node.type==='ModalErrorMessage')[0];
    assert.equal(error.props.message,'clipboard denied');
    assert.equal(error.props.position,'bottom');
    assert.equal(error.props.scrollKey,count);
    assert.equal(nodes(tree,(node)=>node.props?.className==='modal-overlay codex-request-detail-overlay')[0].props.onClick,undefined);
    assert.equal(closed,0);
  }
  fail=false;
  nodes(section(hook.flush()),(node)=>node.type==='button')[0].props.onClick();
  await settlePromises();
  assert.equal(nodes(hook.flush(),(node)=>node.type==='ModalErrorMessage')[0].props.message,'');
  assert.match(text(hook.flush()),/common.success/);
  assert.deepEqual(copies,[longId,longId,longId]);
  assert.ok(text(section(hook.flush())).includes(longId));
  hook.unmount();
});

test('identity layout wraps complete long values without changing modal sizing or hiding actions at short heights', () => {
  const css = readFileSync(new URL('./CodexRequestIdentityHeaders.css',import.meta.url),'utf8');
  const modal = readFileSync(new URL('./CodexRequestDiagnostics.css',import.meta.url),'utf8');
  assert.match(css,/grid-template-columns:\s*minmax\(0, 1fr\) auto/);
  assert.match(css,/\.codex-request-identity-value\s*\{[^}]*overflow-wrap:\s*anywhere/);
  assert.match(css,/@media\s*\(max-width:\s*560px\)/);
  assert.equal(/\.modal(?:\s|\.|\{|\-)/.test(css),false);
  assert.match(modal,/max-height:\s*calc\(100vh - 32px\)/);
  assert.match(modal,/\.codex-request-detail-body\s*\{[^}]*min-height:\s*0;[^}]*overflow-y:\s*auto/);
  for (const part of ['header','footer']) assert.match(modal,new RegExp(`\\.codex-request-detail-modal \\.modal-${part}\\s*\\{[^}]*flex:\\s*0 0 auto`));
});

test('legacy request details show unknown request/response sources instead of claiming standard processing', async () => {
  const hook = harness({ serviceTier: 'standard' });
  await settlePromises();
  const content = text(hook.flush());
  assert.match(content, /requestedTier:—/);
  assert.match(content, /responseTier:—/);
  assert.match(content, /legacyTier:standard/);
  assert.match(content, /legacyTierHint/);
  assert.equal(content.includes('codex.speed.standard'), false);
  hook.unmount();
});


test('request details distinguish the final route and individual fallback attempt routes', async () => {
  const hook = harness({ accountId: 'chatgpt_plan_saved' }, { detail: {
    requestId: 'id', attempts: [
      { sequence: 1, accountId: 'source', accountEmail: 'same@example.com', modelId: 'model', transport: 'http', startedAtMs: 0, status: 400, success: false, latencyMs: 1 },
      { sequence: 2, accountId: 'chatgpt_plan_saved', accountEmail: 'same@example.com', modelId: 'model', transport: 'http', startedAtMs: 0, status: 200, success: true, latencyMs: 1 },
    ], payloads: [], capturedAtMs: 0, truncated: false,
  } as CodexLocalAccessRequestDetail });
  await settlePromises();
  const content = text(hook.flush());
  assert.match(content, /codex.requestDiagnostics.authorizationRoute/);
  assert.equal(content.split('codex.requestDiagnostics.routeOfficial').length - 1, 2);
  assert.equal(content.split('codex.requestDiagnostics.routeLocal').length - 1, 1);
  hook.unmount();
});
