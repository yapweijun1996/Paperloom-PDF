'use client';

import React from 'react';
import { Search, Replace, ChevronUp, ChevronDown, CaseSensitive, X } from 'lucide-react';
import { Button, IconButton, Notice, TextInput } from '../ui';

export interface FindReplacePanelProps {
  findText: string;
  onFindTextChange: (val: string) => void;
  replaceText: string;
  onReplaceTextChange: (val: string) => void;
  matchCount: number;
  currentMatchIndex: number;
  onNextMatch: () => void;
  onPrevMatch: () => void;
  onReplaceCurrent: () => void;
  onReplaceAll: () => void;
  caseSensitive: boolean;
  onToggleCaseSensitive: () => void;
  onClose?: () => void;
  busy?: boolean;
  /** Result of the last replace-all, announced politely. */
  status?: string | null;
}

export function FindReplacePanel({
  findText,
  onFindTextChange,
  replaceText,
  onReplaceTextChange,
  matchCount,
  currentMatchIndex,
  onNextMatch,
  onPrevMatch,
  onReplaceCurrent,
  onReplaceAll,
  caseSensitive,
  onToggleCaseSensitive,
  onClose,
  busy = false,
  status,
}: FindReplacePanelProps) {
  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (e.shiftKey) {
        onPrevMatch();
      } else {
        onNextMatch();
      }
    }
  };
  const replaceDisabled = busy || matchCount === 0 || !findText.trim();

  return (
    <div data-find-panel className="w-full space-y-2.5 rounded-xl border border-app bg-panel/95 p-3 font-sans text-app shadow-2xl backdrop-blur-md md:w-72">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider text-app-muted">
          <Search size={13} aria-hidden="true" className="text-accent" />
          Find & Replace
        </div>
        {onClose && (
          <IconButton
            size="sm"
            aria-label="Close search"
            title="Close Search"
            icon={<X size={14} />}
            onClick={onClose}
          />
        )}
      </div>

      <div className="flex items-center gap-1">
        <TextInput
          value={findText}
          onChange={(e) => onFindTextChange(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Search text in PDF..."
          aria-label="Search text"
          autoFocus
          className="min-w-0 flex-1"
        />
        {findText.trim() !== '' && (
          <span className="shrink-0 rounded bg-panel-elevated px-1.5 py-0.5 font-mono text-[10px] text-app-muted">
            {matchCount > 0 ? `${currentMatchIndex + 1}/${matchCount}` : '0'}
          </span>
        )}
        <IconButton
          size="sm"
          aria-label="Match case"
          aria-pressed={caseSensitive}
          icon={<CaseSensitive size={14} />}
          onClick={onToggleCaseSensitive}
          className="aria-pressed:bg-bloom-100 aria-pressed:text-accent"
        />
        <IconButton
          size="sm"
          aria-label="Previous match (Shift+Enter)"
          icon={<ChevronUp size={14} />}
          onClick={onPrevMatch}
          disabled={matchCount === 0}
        />
        <IconButton
          size="sm"
          aria-label="Next match (Enter)"
          icon={<ChevronDown size={14} />}
          onClick={onNextMatch}
          disabled={matchCount === 0}
        />
      </div>

      <TextInput
        value={replaceText}
        onChange={(e) => onReplaceTextChange(e.target.value)}
        placeholder="Replace with..."
        aria-label="Replace with"
      />

      <div className="grid grid-cols-2 gap-1.5 pt-0.5">
        <Button size="sm" onClick={onReplaceCurrent} disabled={replaceDisabled} loading={busy}>
          {!busy && <Replace size={12} aria-hidden="true" />}
          Replace
        </Button>
        <Button size="sm" variant="primary" onClick={onReplaceAll} disabled={replaceDisabled} loading={busy}>
          {!busy && <Replace size={12} aria-hidden="true" />}
          Replace All
        </Button>
      </div>

      {status && <Notice tone="success" className="text-xs">{status}</Notice>}
    </div>
  );
}
