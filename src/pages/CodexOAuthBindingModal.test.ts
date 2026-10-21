import assert from "node:assert/strict";
import test from "node:test";
import { loadHookModule } from "../../tests/helpers/reactHookHarness";
function nodes(value: any): any[] {
  if (!value || typeof value !== "object") return [];
  if (Array.isArray(value)) return value.flatMap(nodes);
  return [value, ...nodes(value.props?.children)];
}
function modalHarness(focusCalls: any[] = [], escapeCalls: any[] = []) {
  const imports: Record<string, unknown> = {};
  imports["../hooks/useModalFocusTrap"] = {
    useModalFocusTrap: (ref: any, open: boolean, restore = true, active = true) =>
      focusCalls.push({ ref, open, restore, active }),
  };
  imports["../hooks/useEscClose"] = {
    useEscCloseTopmost: (open: boolean, close: () => void) => escapeCalls.push({ open, close }),
  };
  for (const component of ["AccountTagFilterDropdown", "ModalErrorMessage", "MultiSelectFilterDropdown", "PaginationControls", "SingleSelectFilterDropdown"]) {
    imports[`../components/${component}`] = { [component]: component };
  }
  return loadHookModule(new URL("./CodexOAuthBindingModal.tsx", import.meta.url), imports);
}


test("OAuth binding ignores legacy reserve props and exposes only one binding dialog", () => {
  const h = modalHarness();
  const props: any = {
    t: (key: string, fallback: any) => typeof fallback === "string" ? fallback : key,
    oauthBindingTargetActive: true, oauthAccounts: [],
    oauthBindingQuotaReserve: { hourlyPercent: 30, weeklyPercent: 10 },
    oauthBindingQuotaReserveEditorOpen: true,
  };
  h.render(() => h.exports.CodexOAuthBindingModal(props));
  const tree = nodes(h.flush());
  assert.equal(tree.filter(node => node.props?.role === "dialog").length, 1);
  assert.equal(tree.some(node => node.props?.type === "checkbox"), false);
  assert.equal(tree.some(node => /quota|reserve/.test(node.props?.className || "")), false);
  props.oauthBindingTargetActive = false;
  assert.equal(h.flush(), null, "obsolete editor flags must not keep a dialog open");
  h.unmount();
});

test("binding keeps focus, Escape, saving state and explicit-only close behavior", () => {
  const focus: any[] = [], escape: any[] = [];
  const h = modalHarness(focus, escape);
  let closed = 0;
  const props: any = {
    t: (key: string, fallback: any) => typeof fallback === "string" ? fallback : key,
    oauthBindingTargetActive: true, oauthAccounts: [],
    closeOAuthBindingModal: () => { closed++; },
  };
  h.render(() => { focus.length = 0; escape.length = 0; return h.exports.CodexOAuthBindingModal(props); });
  let tree = nodes(h.flush());
  const dialog = tree.find(node => node.props?.role === "dialog");
  assert.equal(dialog.props.ref, focus[0].ref);
  assert.equal(dialog.props.tabIndex, -1);
  assert.equal(tree.find(node => node.props?.className === "modal-overlay").props.onClick, undefined);
  assert.equal(escape.filter(entry => entry.open).length, 1);
  escape.find(entry => entry.open).close();
  assert.equal(closed, 1);
  props.oauthBindingSaving = true;
  h.flush();
  assert.equal(escape.some(entry => entry.open), false);
  h.unmount();
});
