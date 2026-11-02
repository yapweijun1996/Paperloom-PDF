// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { buttonByText, mountHarness, press } from '../ui/__tests__/harness';
import { FindReplacePanel, type FindReplacePanelProps } from './FindReplacePanel';

const harness = mountHarness();

function props(overrides: Partial<FindReplacePanelProps> = {}): FindReplacePanelProps {
  return {
    findText: 'alpha', onFindTextChange: vi.fn(), replaceText: '', onReplaceTextChange: vi.fn(),
    matchCount: 3, currentMatchIndex: 1, onNextMatch: vi.fn(), onPrevMatch: vi.fn(),
    onReplaceCurrent: vi.fn(), onReplaceAll: vi.fn(), caseSensitive: false,
    onToggleCaseSensitive: vi.fn(), onClose: vi.fn(), ...overrides,
  };
}

const find = () => document.querySelector<HTMLInputElement>('input[placeholder="Search text in PDF..."]')!;

describe('FindReplacePanel', () => {
  it('keeps the e2e hooks: panel marker, placeholders, close title and button names', async () => {
    const p = props();
    await harness.render(createElement(FindReplacePanel, p));
    expect(document.querySelector('[data-find-panel]')).not.toBeNull();
    expect(find()).not.toBeNull();
    expect(document.querySelector('input[placeholder="Replace with..."]')).not.toBeNull();
    expect(document.body.textContent).toContain('2/3');
    buttonByText('Replace').click();
    buttonByText('Replace All').click();
    expect(p.onReplaceCurrent).toHaveBeenCalledOnce();
    expect(p.onReplaceAll).toHaveBeenCalledOnce();
    await act(async () => document.querySelector<HTMLButtonElement>('[title="Close Search"]')!.click());
    expect(p.onClose).toHaveBeenCalledOnce();
  });

  it('follows the page theme instead of forcing dark chrome', async () => {
    await harness.render(createElement(FindReplacePanel, props()));
    const panel = document.querySelector('[data-find-panel]')!;
    expect(panel.closest('[data-theme]')).toBeNull();
    expect(panel.className).not.toMatch(/zinc-/);
  });

  it('navigates with Enter and Shift+Enter and toggles case sensitivity', async () => {
    const p = props();
    await harness.render(createElement(FindReplacePanel, p));
    await press('Enter', find());
    expect(p.onNextMatch).toHaveBeenCalledOnce();
    await act(async () => {
      find().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true, cancelable: true }));
    });
    expect(p.onPrevMatch).toHaveBeenCalledOnce();
    const caseToggle = document.querySelector<HTMLButtonElement>('button[aria-label="Match case"]')!;
    expect(caseToggle.getAttribute('aria-pressed')).toBe('false');
    caseToggle.click();
    expect(p.onToggleCaseSensitive).toHaveBeenCalledOnce();
  });

  it('disables navigation and replacement without matches and while busy', async () => {
    await harness.render(createElement(FindReplacePanel, props({ matchCount: 0 })));
    expect(document.body.textContent).toContain('0');
    expect(buttonByText('Replace').disabled).toBe(true);
    expect(buttonByText('Replace All').disabled).toBe(true);
    expect(document.querySelector<HTMLButtonElement>('button[aria-label^="Next match"]')!.disabled).toBe(true);
    await harness.render(createElement(FindReplacePanel, props({ busy: true })));
    expect(buttonByText('Replace All').disabled).toBe(true);
    expect(buttonByText('Replace All').getAttribute('aria-busy')).toBe('true');
  });

  it('announces the replace-all result as a status message', async () => {
    await harness.render(createElement(FindReplacePanel, props({ status: 'Replaced 24 matches' })));
    const status = [...document.querySelectorAll('[role="status"]')].find(node => node.textContent?.includes('Replaced 24 matches'));
    expect(status).toBeDefined();
  });
});
