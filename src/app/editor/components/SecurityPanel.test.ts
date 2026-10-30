// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { FullSecurityReport, PDFDocumentData } from '@/engine/browser-core';
import { SecurityPanel } from './SecurityPanel';

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

function report(score: number): FullSecurityReport {
  return {
    score, encrypted: false, metadata: { hasInfo: false, hasXmp: false },
    embeddedFiles: { count: 0 }, javascript: { present: false },
    integrity: { ok: true, issueCount: 0 }, redactionMarks: 0, recommendations: [],
  } as unknown as FullSecurityReport;
}

it('ignores an inspection result for a document that has been replaced', async () => {
  let finishFirst!: (value: FullSecurityReport) => void;
  const first = new Promise<FullSecurityReport>(resolve => { finishFirst = resolve; });
  const inspectFull = vi.fn().mockReturnValueOnce(first).mockResolvedValueOnce(report(88));
  const engine = {
    securityEngine: { inspector: { inspectFull }, policy: { listPolicies: () => [] } },
  } as unknown as typeof import('@/engine/browser-core');
  const doc = {} as PDFDocumentData;
  const props = { doc, engine, onDocChange: vi.fn() };
  await act(async () => root.render(createElement(SecurityPanel, props)));
  await act(async () => root.render(createElement(SecurityPanel, { ...props, doc: {} as PDFDocumentData })));
  expect(container.textContent).toContain('88/100');
  await act(async () => finishFirst(report(12)));
  expect(container.textContent).toContain('88/100');
  expect(container.textContent).not.toContain('12/100');
});

it.each(['success', 'failure'] as const)(
  'marks an asynchronous security edit dirty and busy before it settles, then clears busy on %s',
  async (outcome) => {
    let resolve!: () => void;
    let reject!: (error: Error) => void;
    const operation = new Promise<void>((ok, fail) => { resolve = ok; reject = fail; });
    const events: string[] = [];
    const encrypt = vi.fn(() => { events.push('encrypt'); return operation; });
    const onBusyChange = vi.fn((busy: boolean) => events.push(`busy:${busy}`));
    const markDirty = vi.fn(() => events.push('dirty'));
    const onDocChange = vi.fn();
    const doc = {} as PDFDocumentData;
    const engine = {
      securityEngine: {
        inspector: { inspectFull: vi.fn().mockResolvedValue(report(88)) },
        policy: { listPolicies: () => [] },
        isEncrypted: () => false,
        encrypt,
      },
    } as unknown as typeof import('@/engine/browser-core');
    await act(async () => root.render(createElement(SecurityPanel, { doc, engine, onDocChange, markDirty, onBusyChange })));
    const findButton = (label: string) => {
      const item = [...container.querySelectorAll('button')].find(button => button.textContent?.trim() === label);
      if (!item) throw new Error(`Missing button: ${label}`);
      return item;
    };
    await act(async () => findButton('Protect').click());
    expect(findButton('Encrypt PDF').disabled).toBe(true);
    const owner = container.querySelector('#security-protect-owner-password') as HTMLInputElement;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      setter.call(owner, 'synthetic-owner');
      owner.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => findButton('Encrypt PDF').click());
    expect(events).toEqual(['busy:true', 'dirty', 'encrypt']);
    expect(findButton('Encrypt PDF').disabled).toBe(true);
    expect(onDocChange).not.toHaveBeenCalled();

    await act(async () => {
      if (outcome === 'success') resolve();
      else reject(new Error('Encryption failed'));
      await operation.catch(() => {});
    });
    expect(onBusyChange.mock.calls).toEqual([[true], [false]]);
    expect(findButton('Encrypt PDF').disabled).toBe(false);
    if (outcome === 'success') {
      expect(onDocChange).toHaveBeenCalledWith(doc);
      expect(markDirty).toHaveBeenCalledTimes(2);
    } else {
      expect(onDocChange).not.toHaveBeenCalled();
      expect(markDirty).toHaveBeenCalledOnce();
      expect(container.textContent).toContain('Encryption failed');
    }
  },
);

it('requires explicit passwords on the policy screen before applying an encryption policy', async () => {
  const applyPolicy = vi.fn().mockResolvedValue(undefined);
  const doc = {} as PDFDocumentData;
  const engine = {
    securityEngine: {
      inspector: { inspectFull: vi.fn().mockResolvedValue(report(88)) },
      policy: {
        listPolicies: () => ['Confidential'],
        getPolicy: () => ({ name: 'Confidential', requireEncryption: true, requireUserPassword: true }),
        applyPolicy,
      },
    },
  } as unknown as typeof import('@/engine/browser-core');
  await act(async () => root.render(createElement(SecurityPanel, { doc, engine, onDocChange: vi.fn() })));
  const button = (label: string) => [...container.querySelectorAll('button')].find(item => item.textContent?.trim() === label)!;
  await act(async () => button('Policy').click());
  expect(button('Apply policy').disabled).toBe(true);
  const enter = async (selector: string, value: string) => {
    const input = container.querySelector(selector) as HTMLInputElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
  };
  await enter('#security-policy-owner-password', 'synthetic-owner');
  expect(button('Apply policy').disabled).toBe(true);
  await enter('#security-policy-user-password', 'synthetic-open');
  expect(button('Apply policy').disabled).toBe(false);
  await act(async () => button('Apply policy').click());
  expect(applyPolicy).toHaveBeenCalledWith(doc, 'Confidential', {
    userPassword: 'synthetic-open', ownerPassword: 'synthetic-owner',
  });
  await act(async () => root.render(createElement(SecurityPanel, { doc: {} as PDFDocumentData, engine, onDocChange: vi.fn() })));
  expect((container.querySelector('#security-policy-owner-password') as HTMLInputElement).value).toBe('');
  expect((container.querySelector('#security-policy-user-password') as HTMLInputElement).value).toBe('');
  expect(button('Apply policy').disabled).toBe(true);
});

it('reports the scope of JavaScript removal without claiming other actions were removed', async () => {
  const removeJavaScript = vi.fn().mockReturnValue({ removed: 2 });
  const doc = {} as PDFDocumentData;
  const engine = {
    securityEngine: {
      inspector: { inspectFull: vi.fn().mockResolvedValue(report(88)) },
      policy: { listPolicies: () => [] },
      javascript: { removeJavaScript },
    },
  } as unknown as typeof import('@/engine/browser-core');
  await act(async () => root.render(createElement(SecurityPanel, { doc, engine, onDocChange: vi.fn() })));
  const click = async (text: string) => {
    const button = [...container.querySelectorAll('button')].find(item => item.textContent?.trim() === text);
    if (!button) throw new Error(`Missing button: ${text}`);
    await act(async () => button.click());
  };
  await click('Clean');
  await click('Remove JavaScript');
  expect(removeJavaScript).toHaveBeenCalledWith(doc);
  expect(container.textContent).toContain('Removed 2 known JavaScript action link(s)');
  expect(container.textContent).toContain('other action types are unchanged');
  expect(container.textContent).toContain('Download a new copy to apply changes; the original file is unchanged.');
});

it.each([
  ['Sanitize document', 'Removed Info dictionary and XMP metadata'],
  ['Remove attachments', 'Removed 2 attachment(s)'],
  ['Strip metadata', 'Metadata cleanup prepared'],
] as const)('%s explains that cleanup requires a new download', async (label, outcome) => {
  const doc = {} as PDFDocumentData;
  const engine = {
    securityEngine: {
      inspector: { inspectFull: vi.fn().mockResolvedValue(report(88)) },
      policy: { listPolicies: () => [] },
      sanitization: { sanitize: vi.fn().mockResolvedValue({ report: ['Removed Info dictionary and XMP metadata'] }) },
      embeddedFiles: { removeAllAttachments: vi.fn().mockReturnValue(2) },
      metadata: { stripMetadata: vi.fn() },
    },
  } as unknown as typeof import('@/engine/browser-core');
  await act(async () => root.render(createElement(SecurityPanel, { doc, engine, onDocChange: vi.fn() })));
  const click = async (text: string) => {
    const button = [...container.querySelectorAll('button')].find(item => item.textContent?.trim() === text);
    if (!button) throw new Error(`Missing button: ${text}`);
    await act(async () => button.click());
  };
  await click('Clean');
  await click(label);
  expect(container.textContent).toContain(outcome);
  expect(container.textContent).toContain('Download a new copy to apply changes; the original file is unchanged.');
});

it.each(['success', 'failure'] as const)('runs secure redaction without marking failed operations dirty: %s', async outcome => {
  const onRedact = vi.fn().mockImplementation(async () => {
    if (outcome === 'failure') throw new Error('Unsupported content; document was not changed.');
    return { message: 'Redacted 1 page. Download a new copy to apply changes.', revision: 0, editRevision: 0, pageKey: '' };
  });
  const markDirty = vi.fn(), onDocChange = vi.fn(), onBusyChange = vi.fn();
  const doc = {} as PDFDocumentData;
  const engine = { securityEngine: {
    inspector: { inspectFull: vi.fn().mockResolvedValue(report(88)) },
    policy: { listPolicies: () => [] },
  } } as unknown as typeof import('@/engine/browser-core');
  await act(async () => root.render(createElement(SecurityPanel, { doc, engine, onDocChange, markDirty, onBusyChange, onRedact })));
  const click = async (label: string) => {
    const button = [...container.querySelectorAll('button')].find(item => item.textContent?.trim() === label);
    if (!button) throw new Error(`Missing button: ${label}`);
    await act(async () => button.click());
  };
  await click('Clean');
  await click('Redact entire current page');
  expect(onRedact).toHaveBeenCalledWith('page');
  expect(markDirty).not.toHaveBeenCalled();
  expect(onDocChange).not.toHaveBeenCalled();
  expect(onBusyChange.mock.calls).toEqual([[true], [false]]);
  if (outcome === 'failure') {
    expect(container.textContent).toContain('Unsupported content; document was not changed.');
    expect(container.textContent).not.toContain('Redacted 1 page.');
  } else expect(container.textContent).toContain('Download a new copy to apply changes.');
});

it.each(['revision', 'edit revision', 'page', 'document'] as const)(
  'does not revive a successful redaction message after a %s change', async kind => {
    const doc = {} as PDFDocumentData;
    const engine = { securityEngine: {
      inspector: { inspectFull: vi.fn().mockResolvedValue(report(88)) }, policy: { listPolicies: () => [] },
    } } as unknown as typeof import('@/engine/browser-core');
    const props = { doc, engine, onDocChange: vi.fn(), documentRevision: 1, documentEditRevision: 2, documentPageKey: '1_0',
      onRedact: vi.fn().mockResolvedValue({ message: 'Redacted one page.', revision: 1, editRevision: 2, pageKey: '1_0' }) };
    await act(async () => root.render(createElement(SecurityPanel, props)));
    const click = async (label: string) => {
      const button = [...container.querySelectorAll('button')].find(item => item.textContent?.trim() === label);
      if (!button) throw new Error(`Missing button: ${label}`);
      await act(async () => button.click());
    };
    await click('Clean'); await click('Redact entire current page');
    expect(container.textContent).toContain('Redacted one page.');
    const changed = kind === 'revision' ? { documentRevision: 2 } : kind === 'edit revision' ? { documentEditRevision: 3 }
      : kind === 'page' ? { documentPageKey: '2_0' } : { doc: {} as PDFDocumentData };
    await act(async () => root.render(createElement(SecurityPanel, { ...props, ...changed })));
    expect(container.textContent).not.toContain('Redacted one page.');
    await act(async () => root.render(createElement(SecurityPanel, props)));
    expect(container.textContent).not.toContain('Redacted one page.');
  },
);
