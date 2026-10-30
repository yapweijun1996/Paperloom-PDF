'use client';

import { useEffect, useRef, type InputHTMLAttributes } from 'react';
import { isCompositionKey } from '../keyboard-actions';

interface FormDraftInputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'onChange' | 'onBlur' | 'onKeyDown' | 'onCompositionStart' | 'onCompositionEnd'> {
  onDraftChange: (value: string) => void;
  onCommit?: () => void;
  onCompositionChange?: (active: boolean) => void;
}

/** Keep IME editing local until it is safe to commit a form field. */
export function FormDraftInput({ onDraftChange, onCommit, onCompositionChange, ...props }: FormDraftInputProps) {
  const composing = useRef(false);
  const pendingBlur = useRef(false);
  const notifyRef = useRef(onCompositionChange);
  useEffect(() => { notifyRef.current = onCompositionChange; }, [onCompositionChange]);
  useEffect(() => () => {
    // A panel can be removed without a compositionend event. Do not leave the
    // document permanently blocked; any captured draft remains recoverable.
    if (composing.current) notifyRef.current?.(false);
  }, []);
  return <input
    {...props}
    onChange={event => onDraftChange(event.target.value)}
    onCompositionStart={() => { composing.current = true; onCompositionChange?.(true); }}
    onCompositionEnd={() => {
      composing.current = false;
      onCompositionChange?.(false);
      if (pendingBlur.current) {
        pendingBlur.current = false;
        // Give the final input event a chance to publish its value.
        setTimeout(() => onCommit?.(), 0);
      }
    }}
    onFocus={() => { pendingBlur.current = false; }}
    onBlur={() => {
      if (composing.current) pendingBlur.current = true;
      else onCommit?.();
    }}
    onKeyDown={event => {
      if (event.key === 'Enter' && !composing.current && !isCompositionKey(event.nativeEvent)) {
        event.preventDefault();
        onCommit?.();
      }
    }}
  />;
}
