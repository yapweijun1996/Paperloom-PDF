import { describe, expect, it } from 'vitest';
import type { AcroFormWidget } from '@/engine/browser-core';
import { hasPendingFormFieldDraft, isButtonWidgetChecked } from './button-field-state';

describe('button field selection state', () => {
  it.each([
    ['Accepted', 'Accepted', true],
    ['Accepted', 'Off', false],
    ['Accepted', null, true],
    ['Off', null, false],
    [null, null, false],
  ])('handles field value %s and widget state %s', (value, appearanceState, expected) => {
    expect(isButtonWidgetChecked({ value, appearanceState } as AcroFormWidget)).toBe(expected);
  });
});

it('compares button drafts by state rather than a PDF-specific on name', () => {
  const button = { fieldType: 'Btn', value: 'Accepted', appearanceState: 'Accepted' } as AcroFormWidget;
  expect(hasPendingFormFieldDraft(button, 'Yes')).toBe(false);
  expect(hasPendingFormFieldDraft(button, 'Off')).toBe(true);
  expect(hasPendingFormFieldDraft({ ...button, appearanceState: 'Off' }, 'Yes')).toBe(true);
  expect(hasPendingFormFieldDraft({ ...button, fieldType: 'Tx', value: 'Accepted' }, 'Yes')).toBe(true);
});
