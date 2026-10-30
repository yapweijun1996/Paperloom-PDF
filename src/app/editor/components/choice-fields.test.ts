// @vitest-environment happy-dom
import { act, createElement, type ComponentProps } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { PDFDict, PDFRef } from '@/engine/types';
import type { AcroFormWidget } from '@/engine/forms/types';
import { PropertiesSidebar } from './PropertiesSidebar';
import { encodeMultiChoiceDraft } from '../multi-choice-draft';

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => { vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); container = document.createElement('div'); document.body.append(container); root = createRoot(container); });
afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals(); });

function render(flags = 0, readOnly = false) {
  const onFormFieldChange = vi.fn();
  const field = { ref: new PDFRef(2, 0), dict: new PDFDict(), fieldName: 'Choice', fieldType: 'Ch',
    choiceFlags: flags, choiceOptions: [{ value: 'a', label: 'First' }, { value: 'b', label: 'Second label' }], readOnly } as AcroFormWidget;
  const props = { activeTool: 'select', displayItems: [], formFields: [field], selectedFormField: field,
    formFieldDraft: flags & (1 << 21) ? encodeMultiChoiceDraft(['a']) : 'a', onFormFieldChange } as unknown as ComponentProps<typeof PropertiesSidebar>;
  act(() => root.render(createElement(PropertiesSidebar, props)));
  return onFormFieldChange;
}

it('offers the field labels but sends the PDF export value when selected', () => {
  const change = render();
  const select = container.querySelector<HTMLSelectElement>('#form-choice-value')!;
  expect([...select.options].map(option => [option.value, option.textContent])).toEqual([['a', 'First'], ['b', 'Second label']]);
  act(() => { select.value = 'b'; select.dispatchEvent(new Event('change', { bubbles: true })); });
  expect(change).toHaveBeenCalledExactlyOnceWith('b');
});

it('offers suggestions for editable combos and multi-select options', () => {
  render(1 << 18);
  expect(container.querySelector('input[list="form-choice-options"]')).not.toBeNull();
  expect(container.querySelectorAll('datalist option')).toHaveLength(2);
  const onChange = render(1 << 21);
  const list = container.querySelector<HTMLSelectElement>('#form-choice-value')!;
  expect(list.disabled).toBe(false);
  expect(list.multiple).toBe(true);
  expect([...list.selectedOptions].map(option => option.value)).toEqual(['a']);
  act(() => { list.options[1].selected = true; list.dispatchEvent(new Event('change', { bubbles: true })); });
  expect(onChange).toHaveBeenCalledWith(encodeMultiChoiceDraft(['a', 'b']));
});

it('does not let a read-only choice field be changed', () => {
  render(0, true);
  expect(container.querySelector<HTMLSelectElement>('#form-choice-value')?.disabled).toBe(true);
});
