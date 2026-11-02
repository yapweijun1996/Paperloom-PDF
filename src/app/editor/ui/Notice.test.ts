// @vitest-environment happy-dom
import { createElement } from 'react';
import { describe, expect, it } from 'vitest';
import { Notice, type NoticeTone } from './Notice';
import { mountHarness } from './__tests__/harness';

const harness = mountHarness();

describe('Notice', () => {
  it.each([
    ['info', 'status', ['bg-info-soft', 'text-info', 'border-info']],
    ['success', 'status', ['bg-success-soft', 'text-success', 'border-success']],
    ['warning', 'status', ['bg-warning-soft', 'text-warning', 'border-warning']],
    ['danger', 'alert', ['bg-danger-soft', 'text-danger', 'border-danger']],
  ] as [NoticeTone, string, string[]][])('%s uses role=%s and semantic tokens', async (tone, role, classes) => {
    await harness.render(createElement(Notice, { tone }, 'Saved'));
    const notice = document.querySelector(`[role="${role}"]`)!;
    expect(notice).not.toBeNull();
    expect(notice.textContent).toBe('Saved');
    expect(notice.getAttribute('data-tone')).toBe(tone);
    for (const name of classes) expect(notice.classList.contains(name), name).toBe(true);
    expect(notice.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
  });

  it('defaults to info, renders a title and passes attributes through', async () => {
    await harness.render(createElement(Notice, { title: 'Heads up', 'aria-label': 'Conformance', 'data-testid': 'notice', id: 'n1' } as never, 'Body'));
    const notice = document.querySelector('[role="status"]')!;
    expect(notice.getAttribute('data-tone')).toBe('info');
    expect(notice.textContent).toBe('Heads upBody');
    expect(notice.getAttribute('aria-label')).toBe('Conformance');
    expect(notice.getAttribute('data-testid')).toBe('notice');
    expect(notice.id).toBe('n1');
  });
  it('drops the live-region role when live is false, keeping tone and content', async () => {
    await harness.render(createElement(Notice, { tone: 'danger', live: false }, 'Quiet'));
    expect(document.querySelector('[role]')).toBeNull();
    const notice = document.querySelector('[data-tone="danger"]')!;
    expect(notice.textContent).toBe('Quiet');
    expect(notice.classList.contains('bg-danger-soft')).toBe(true);
  });
});
