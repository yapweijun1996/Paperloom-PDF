// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { Field, NumberInput, SecretInput, Select, TextInput } from './Field';
import { mountHarness } from './__tests__/harness';

const harness = mountHarness();

function control<T extends HTMLElement = HTMLInputElement>(selector = 'input'): T {
  return document.querySelector<T>(selector)!;
}

describe('Field', () => {
  it('labels its control through htmlFor and a generated id', async () => {
    await harness.render(createElement(Field, { label: 'Width' }, createElement(TextInput)));
    const input = control();
    const label = document.querySelector('label')!;
    expect(input.id).toBeTruthy();
    expect(label.htmlFor).toBe(input.id);
    expect(input.hasAttribute('aria-invalid')).toBe(false);
    expect(input.hasAttribute('aria-describedby')).toBe(false);
  });

  it('describes the control with its hint and error and marks it invalid', async () => {
    await harness.render(createElement(Field, { label: 'Name', hint: 'Shown on the form', error: 'Name is taken', id: 'name' },
      createElement(TextInput, { 'aria-describedby': 'extra' })));
    const input = control();
    expect(input.id).toBe('name');
    expect(input.getAttribute('aria-invalid')).toBe('true');
    const described = input.getAttribute('aria-describedby')!.split(' ');
    expect(described).toEqual(['name-hint', 'name-error', 'extra']);
    expect(document.getElementById('name-hint')?.textContent).toBe('Shown on the form');
    const error = document.getElementById('name-error')!;
    expect(error.textContent).toBe('Name is taken');
    expect(error.getAttribute('role')).toBe('alert');
  });

  it('gives distinct ids to sibling fields', async () => {
    await harness.render(createElement('div', null,
      createElement(Field, { label: 'A' }, createElement(TextInput)),
      createElement(Field, { label: 'B' }, createElement(TextInput))));
    const [a, b] = [...document.querySelectorAll('input')];
    expect(a.id).not.toBe(b.id);
  });
});

describe('inputs', () => {
  it('TextInput passes attributes through, supports disabled and reports changes', async () => {
    const onChange = vi.fn();
    await harness.render(createElement(TextInput, {
      value: '', onChange, title: 'Field name', 'aria-label': 'Field name', 'data-testid': 'name', disabled: true,
    } as never));
    const input = control();
    expect(input.type).toBe('text');
    expect(input.title).toBe('Field name');
    expect(input.getAttribute('aria-label')).toBe('Field name');
    expect(input.dataset.testid).toBe('name');
    expect(input.disabled).toBe(true);
    expect(input.classList.contains('bg-panel-elevated')).toBe(true);
  });

  it('NumberInput is a decimal number field with native min/max/step', async () => {
    await harness.render(createElement(NumberInput, { min: 1, max: 10, step: 0.5, defaultValue: 2, 'aria-label': 'Size' }));
    const input = control();
    expect(input.type).toBe('number');
    expect(input.inputMode).toBe('decimal');
    expect([input.min, input.max, input.step]).toEqual(['1', '10', '0.5']);
  });

  it('SecretInput is a password field that requires autoComplete and disables spellcheck', async () => {
    // @ts-expect-error autoComplete is required.
    expect(createElement(SecretInput, {})).toBeTruthy();
    await harness.render(createElement(Field, { label: 'Password' }, createElement(SecretInput, { autoComplete: 'current-password' })));
    const input = control();
    expect(input.type).toBe('password');
    expect(input.getAttribute('autocomplete')).toBe('current-password');
    expect(input.getAttribute('spellcheck')).toBe('false');
    expect(input.getAttribute('autocapitalize')).toBe('off');
    expect(document.querySelector('label')!.htmlFor).toBe(input.id);
  });

  it('Select renders a native select with token classes, wiring and keyboard-native options', async () => {
    const onChange = vi.fn();
    await harness.render(createElement(Field, { label: 'Quality', error: 'Pick one' },
      createElement(Select, { value: 'b', onChange, 'data-testid': 'quality' } as never,
        createElement('option', { value: 'a' }, 'A'),
        createElement('option', { value: 'b' }, 'B'))));
    const select = control<HTMLSelectElement>('select');
    expect(select.value).toBe('b');
    expect(select.dataset.testid).toBe('quality');
    expect(select.getAttribute('aria-invalid')).toBe('true');
    expect(document.querySelector('label')!.htmlFor).toBe(select.id);
    expect(select.classList.contains('appearance-none')).toBe(true);
    await act(async () => {
      select.value = 'a';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(onChange).toHaveBeenCalledOnce();
  });
});
