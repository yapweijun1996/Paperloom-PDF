'use client';

import React, { useState } from 'react';
import { Hash } from 'lucide-react';
import { Button, Field, NumberInput, TextInput } from '../ui';
import {
  DEFAULT_HEADER_FOOTER,
  HEADER_FOOTER_SLOTS,
  unsupportedHeaderFooterText,
  type HeaderFooterOptions,
  type HeaderFooterSlot,
} from '@/engine/watermark/header-footer';

const SLOT_LABELS: Record<HeaderFooterSlot, string> = {
  headerLeft: 'Header left',
  headerCenter: 'Header centre',
  headerRight: 'Header right',
  footerLeft: 'Footer left',
  footerCenter: 'Footer centre',
  footerRight: 'Footer right',
};

interface HeaderFooterPanelProps {
  totalPages: number;
  onApply: (options: HeaderFooterOptions) => Promise<void> | void;
}

/** Headers, footers, page numbers and Bates numbers for a page range. */
export function HeaderFooterPanel({ totalPages, onApply }: HeaderFooterPanelProps) {
  const [text, setText] = useState(DEFAULT_HEADER_FOOTER.text);
  const [fontSize, setFontSize] = useState(DEFAULT_HEADER_FOOTER.fontSize);
  const [margin, setMargin] = useState(DEFAULT_HEADER_FOOTER.margin);
  const [pageFrom, setPageFrom] = useState(1);
  const [pageTo, setPageTo] = useState(totalPages);
  const [startNumber, setStartNumber] = useState(DEFAULT_HEADER_FOOTER.startNumber);
  const [batesPrefix, setBatesPrefix] = useState('');
  const [busy, setBusy] = useState(false);

  const allText = [...Object.values(text), batesPrefix].join('');
  const badChar = unsupportedHeaderFooterText(allText);
  const empty = HEADER_FOOTER_SLOTS.every(slot => !text[slot]?.trim());
  const from = Math.min(Math.max(1, pageFrom), totalPages);
  const to = Math.min(Math.max(from, pageTo), totalPages);
  const error = badChar
    ? `"${badChar}" is not supported. Use English letters, digits and punctuation.`
    : undefined;

  return (
    <section aria-label="Header and footer" className="border-t border-app p-4 flex flex-col gap-3">
      <div className="flex items-center gap-2 text-[10px] font-bold tracking-widest text-app-muted uppercase">
        <Hash size={14} />
        Header, footer &amp; page numbers
      </div>
      <p className="text-[10px] text-app-faint">
        Tokens: {'{page}'}, {'{total}'}, {'{date}'}, {'{bates}'}
      </p>
      <div className="grid grid-cols-1 gap-2">
        {HEADER_FOOTER_SLOTS.map(slot => (
          <Field key={slot} label={SLOT_LABELS[slot]}>
            <TextInput
              value={text[slot] ?? ''}
              placeholder={slot === 'footerCenter' ? 'Page {page} of {total}' : ''}
              onChange={event => setText(prev => ({ ...prev, [slot]: event.target.value }))}
            />
          </Field>
        ))}
      </div>
      <div className="grid grid-cols-2 gap-2">
        <Field label="Font size (pt)">
          <NumberInput min={6} max={36} value={fontSize} onChange={event => setFontSize(Number(event.target.value) || DEFAULT_HEADER_FOOTER.fontSize)} />
        </Field>
        <Field label="Margin (pt)">
          <NumberInput min={0} max={144} value={margin} onChange={event => setMargin(Math.max(0, Number(event.target.value) || 0))} />
        </Field>
        <Field label="From page">
          <NumberInput min={1} max={totalPages} value={pageFrom} onChange={event => setPageFrom(Number(event.target.value) || 1)} />
        </Field>
        <Field label="To page">
          <NumberInput min={1} max={totalPages} value={pageTo} onChange={event => setPageTo(Number(event.target.value) || totalPages)} />
        </Field>
        <Field label="Start number">
          <NumberInput min={0} value={startNumber} onChange={event => setStartNumber(Math.max(0, Math.floor(Number(event.target.value) || 0)))} />
        </Field>
        <Field label="Bates prefix">
          <TextInput value={batesPrefix} placeholder="ABC" onChange={event => setBatesPrefix(event.target.value)} />
        </Field>
      </div>
      {error && <p role="alert" className="text-[11px] text-danger">{error}</p>}
      <Button
        variant="primary"
        loading={busy}
        disabled={!!badChar || empty}
        onClick={async () => {
          setBusy(true);
          try {
            await onApply({
              ...DEFAULT_HEADER_FOOTER,
              text,
              fontSize: Math.min(36, Math.max(6, fontSize)),
              margin,
              pageFrom: from - 1,
              pageTo: to - 1,
              startNumber,
              batesPrefix,
            });
          } finally {
            setBusy(false);
          }
        }}
      >
        Add header &amp; footer
      </Button>
    </section>
  );
}
