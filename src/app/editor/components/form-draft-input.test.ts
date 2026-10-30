// @vitest-environment happy-dom
import React, { act, createElement, type ComponentProps } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { PDFDict, PDFRef } from '@/engine/types';
import type { AcroFormWidget } from '@/engine/forms/types';
import { PropertiesSidebar } from './PropertiesSidebar';

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => { vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); container = document.createElement('div'); document.body.append(container); root = createRoot(container); });
afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals(); });

it('stages text without writing each keystroke and commits on Enter after IME composition', () => {
  const draft = vi.fn(), commit = vi.fn(), immediate = vi.fn(), composing = vi.fn();
  const field = { ref: new PDFRef(2, 0), dict: new PDFDict(), fieldName: 'Name', fieldType: 'Tx', readOnly: false } as AcroFormWidget;
  const props = { activeTool: 'select', displayItems: [], formFields: [field], selectedFormField: field,
    formFieldDraft: 'a', onFormFieldDraftChange: draft, onFormFieldCommit: commit,
    onFormFieldChange: immediate, onFormFieldCompositionChange: composing } as unknown as ComponentProps<typeof PropertiesSidebar>;
  act(() => root.render(createElement(PropertiesSidebar, props)));
  const input = [...container.querySelectorAll('input')].find(item => item.value === 'a')!;
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    setter.call(input, 'abc');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  expect(draft).toHaveBeenCalledWith('abc');
  expect(immediate).not.toHaveBeenCalled();
  expect(commit).not.toHaveBeenCalled();
  act(() => input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })));
  const enter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
  act(() => input.dispatchEvent(enter));
  expect(enter.defaultPrevented).toBe(false);
  expect(commit).not.toHaveBeenCalled();
  act(() => input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true })));
  act(() => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })));
  expect(commit).toHaveBeenCalledTimes(1);
  expect(composing.mock.calls).toEqual([[true], [false]]);
});

it('releases the composition guard when the input unmounts unexpectedly', () => {
  const composing = vi.fn();
  const field = { ref: new PDFRef(2, 0), dict: new PDFDict(), fieldName: 'Name', fieldType: 'Tx', readOnly: false } as AcroFormWidget;
  const props = { activeTool: 'select', displayItems: [], formFields: [field], selectedFormField: field,
    formFieldDraft: 'a', onFormFieldChange: vi.fn(), onFormFieldDraftChange: vi.fn(),
    onFormFieldCommit: vi.fn(), onFormFieldCompositionChange: composing } as unknown as ComponentProps<typeof PropertiesSidebar>;
  act(() => root.render(createElement(PropertiesSidebar, props)));
  const input = container.querySelector<HTMLInputElement>('#form-text-value')!;
  act(() => input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })));
  act(() => root.render(createElement(PropertiesSidebar, { ...props, selectedFormField: null })));
  expect(composing.mock.calls).toEqual([[true], [false]]);
});

it('uses the current button draft for rapid toggles while the PDF write is pending', () => {
  const calls: string[] = [];
  const field = { ref: new PDFRef(2, 0), dict: new PDFDict(), fieldName: 'Check', fieldType: 'Btn',
    readOnly: false, buttonFlags: 0, appearanceState: 'Off', value: 'Off' } as AcroFormWidget;
  function Harness() {
    const [value, setValue] = React.useState('Off');
    const props = { activeTool: 'select', displayItems: [], formFields: [field], selectedFormField: field,
      formFieldDraft: value, onFormFieldChange: (next: string) => { calls.push(next); setValue(next); } } as unknown as ComponentProps<typeof PropertiesSidebar>;
    return createElement(PropertiesSidebar, props);
  }
  act(() => root.render(createElement(Harness)));
  const button = [...container.querySelectorAll('button')].find(item => item.textContent?.includes('click to check'))!;
  act(() => button.click());
  expect(button.textContent).toContain('click to uncheck');
  act(() => button.click());
  expect(calls).toEqual(['Yes', 'Off']);
});

it('honors a read-only or no-toggle-to-off radio selection', () => {
  const field = { ref: new PDFRef(2, 0), dict: new PDFDict(), fieldName: 'Radio', fieldType: 'Btn',
    readOnly: false, buttonFlags: (1 << 15) | (1 << 14), appearanceState: 'Selected', value: 'Selected' } as AcroFormWidget;
  const props = { activeTool: 'select', displayItems: [], formFields: [field], selectedFormField: field,
    formFieldDraft: 'Yes', onFormFieldChange: vi.fn() } as unknown as ComponentProps<typeof PropertiesSidebar>;
  act(() => root.render(createElement(PropertiesSidebar, props)));
  const button = [...container.querySelectorAll('button')].find(item => item.textContent?.trim() === 'Checked')!;
  expect(button.disabled).toBe(true);
  expect(button.textContent).not.toContain('click');
});
