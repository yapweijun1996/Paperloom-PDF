import { AlertTriangle, CheckCircle2, Info, XCircle, type LucideIcon } from 'lucide-react';
import type { ComponentPropsWithoutRef, ReactNode } from 'react';
import { cx } from './cx';

export type NoticeTone = 'info' | 'success' | 'warning' | 'danger';

// Foreground tokens are contrast-tested on their -soft fills (design-tokens.test.ts).
const TONE_CLASSES: Record<NoticeTone, string> = {
  info: 'border-info bg-info-soft text-info',
  success: 'border-success bg-success-soft text-success',
  warning: 'border-warning bg-warning-soft text-warning',
  danger: 'border-danger bg-danger-soft text-danger',
};

const TONE_ICONS: Record<NoticeTone, LucideIcon> = {
  info: Info,
  success: CheckCircle2,
  warning: AlertTriangle,
  danger: XCircle,
};

export interface NoticeProps extends Omit<ComponentPropsWithoutRef<'div'>, 'title' | 'role'> {
  tone?: NoticeTone;
  title?: ReactNode;
  children?: ReactNode;
}

/** Inline status message. Danger is announced assertively (role=alert); other tones politely (role=status). */
export function Notice({ tone = 'info', title, children, className, ...rest }: NoticeProps) {
  const Icon = TONE_ICONS[tone];
  return (
    <div
      {...rest}
      role={tone === 'danger' ? 'alert' : 'status'}
      data-tone={tone}
      className={cx('flex items-start gap-2 rounded-xl border px-3 py-2 text-sm', TONE_CLASSES[tone], className)}
    >
      <Icon aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
      <div className="min-w-0">
        {title && <p className="font-semibold">{title}</p>}
        {children}
      </div>
    </div>
  );
}
