import type { AcroFormWidget } from '@/engine/browser-core';
import { decodeMultiChoiceDraft } from '../multi-choice-draft';

/** For radio groups each widget's appearance can differ from the field value. */
export function isButtonWidgetChecked(widget: AcroFormWidget): boolean {
  if (widget.appearanceState) return widget.appearanceState !== 'Off';
  return widget.value === true || (typeof widget.value === 'string' && widget.value !== '' && widget.value !== 'Off');
}

/** Button drafts use Yes/Off while PDF fields can use any on-state name. */
export function hasPendingFormFieldDraft(widget: AcroFormWidget | null, draft: string): boolean {
  if (!widget) return false;
  if (widget.fieldType === 'Btn') {
    return (draft !== '' && draft !== 'Off') !== isButtonWidgetChecked(widget);
  }
  if (widget.fieldType === 'Ch' && (widget.choiceFlags & (1 << 21))) {
    try {
      const actual = Array.isArray(widget.value) ? widget.value : typeof widget.value === 'string' ? [widget.value] : [];
      const selected = decodeMultiChoiceDraft(draft);
      return selected.length !== actual.length || selected.some(value => !actual.includes(value));
    } catch { return true; }
  }
  return draft !== (typeof widget.value === 'string' ? widget.value : '');
}
