'use client';

import { ChevronDown } from 'lucide-react';
import { createContext, useContext, useId, type ComponentPropsWithRef, type ReactNode } from 'react';
import { cx } from './cx';

interface FieldControl {
  id: string;
  describedBy?: string;
  invalid: boolean;
}

const FieldContext = createContext<FieldControl | null>(null);

export interface FieldProps {
  label: ReactNode;
  /** Exactly one control (TextInput, Select, NumberInput, SecretInput). */
  children?: ReactNode;
  hint?: ReactNode;
  /** Error text; marks the control aria-invalid and is announced as an alert. */
  error?: ReactNode;
  /** Control id; generated with useId when omitted. */
  id?: string;
  className?: string;
}

/** Label, hint and error wiring for one control: htmlFor, aria-describedby and aria-invalid. */
export function Field({ label, children, hint, error, id, className }: FieldProps) {
  const generated = useId();
  const controlId = id ?? generated;
  const hintId = hint ? `${controlId}-hint` : undefined;
  const errorId = error ? `${controlId}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(' ') || undefined;
  return (
    <div className={cx('flex flex-col gap-1', className)}>
      <label htmlFor={controlId} className="text-xs font-medium text-app-muted">{label}</label>
      <FieldContext.Provider value={{ id: controlId, describedBy, invalid: Boolean(error) }}>
        {children}
      </FieldContext.Provider>
      {hint && <p id={hintId} className="text-xs text-app-muted">{hint}</p>}
      {error && <p id={errorId} role="alert" className="text-xs text-danger">{error}</p>}
    </div>
  );
}

const CONTROL_CLASSES = 'h-9 w-full rounded-xl border border-border-strong bg-panel-elevated px-3 text-sm text-app placeholder:text-app-faint focus:border-accent disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-danger pointer-coarse:h-11';

/** Merges Field wiring into a control's own props; explicit props win. */
function useFieldControl(props: { id?: string; 'aria-describedby'?: string; 'aria-invalid'?: ComponentPropsWithRef<'input'>['aria-invalid'] }) {
  const field = useContext(FieldContext);
  const describedBy = [field?.describedBy, props['aria-describedby']].filter(Boolean).join(' ') || undefined;
  return {
    id: props.id ?? field?.id,
    'aria-describedby': describedBy,
    'aria-invalid': props['aria-invalid'] ?? (field?.invalid || undefined),
  };
}

export type TextInputProps = Omit<ComponentPropsWithRef<'input'>, 'type'> & {
  type?: 'text' | 'email' | 'url' | 'search' | 'tel';
};

export function TextInput({ className, type = 'text', ...rest }: TextInputProps) {
  const wiring = useFieldControl(rest);
  return <input {...rest} {...wiring} type={type} className={cx(CONTROL_CLASSES, className)} />;
}

export type NumberInputProps = Omit<ComponentPropsWithRef<'input'>, 'type'>;

export function NumberInput({ className, inputMode = 'decimal', ...rest }: NumberInputProps) {
  const wiring = useFieldControl(rest);
  return <input {...rest} {...wiring} type="number" inputMode={inputMode} className={cx(CONTROL_CLASSES, 'tabular-nums', className)} />;
}

export type SecretAutoComplete = 'current-password' | 'new-password' | 'one-time-code' | 'off';

export type SecretInputProps = Omit<ComponentPropsWithRef<'input'>, 'type' | 'autoComplete' | 'spellCheck'> & {
  /** Required so password managers handle the field correctly. */
  autoComplete: SecretAutoComplete;
};

/** Password-style input: never spell-checked, autocapitalised or autocorrected. */
export function SecretInput({ className, autoComplete, ...rest }: SecretInputProps) {
  const wiring = useFieldControl(rest);
  return (
    <input
      {...rest}
      {...wiring}
      type="password"
      autoComplete={autoComplete}
      spellCheck={false}
      autoCapitalize="off"
      autoCorrect="off"
      className={cx(CONTROL_CLASSES, className)}
    />
  );
}

const TEXTAREA_CLASSES = 'w-full resize-y rounded-xl border border-border-strong bg-panel-elevated px-3 py-2 text-sm text-app placeholder:text-app-faint focus:border-accent disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-danger';

export type TextAreaProps = ComponentPropsWithRef<'textarea'> & {
  /** For keys, certificates and tokens: no spellcheck, autocomplete, autocapitalise or autocorrect. */
  secret?: boolean;
};

/** Multi-line text control. `secret` keeps pasted key material out of spellcheck and autofill. */
export function TextArea({ className, secret = false, ...rest }: TextAreaProps) {
  const wiring = useFieldControl(rest);
  const secretProps = secret
    ? { spellCheck: false, autoComplete: 'off', autoCapitalize: 'off', autoCorrect: 'off', 'data-secret': '' }
    : {};
  return <textarea {...rest} {...wiring} {...secretProps} className={cx(TEXTAREA_CLASSES, className)} />;
}

export type SelectProps = ComponentPropsWithRef<'select'>;

/** Native select styled with tokens; keeps platform pickers on touch devices. */
export function Select({ className, children, ...rest }: SelectProps) {
  const wiring = useFieldControl(rest);
  return (
    <div className="relative">
      <select {...rest} {...wiring} className={cx(CONTROL_CLASSES, 'appearance-none pr-8', className)}>
        {children}
      </select>
      <ChevronDown aria-hidden="true" className="pointer-events-none absolute right-2.5 top-1/2 size-4 -translate-y-1/2 text-app-muted" />
    </div>
  );
}
