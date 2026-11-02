import React from 'react';
import Image from 'next/image';
import Link from 'next/link';
import { ChevronLeft, ChevronRight, ZoomOut, ZoomIn, X, Undo2, Redo2, Search, FileOutput, Sun, Moon, Focus, PanelRight } from 'lucide-react';
import type { DrawnPath } from '../types';
import type { PDFDocumentData } from '@/engine/browser-core';
import { DownloadDropdown } from './DownloadDropdown';
import type { CompressedDownloadOptions } from './downloadQualityOptions';
import { useTheme } from '@/app/theme/ThemeProvider';
import { BRAND_BASE_PATH, BRAND_NAME } from '@/lib/brand';

// Touch screens get a 44px hit area; desktop sizing is unchanged.
const TOUCH_TARGET = 'inline-flex items-center justify-center pointer-coarse:min-h-11 pointer-coarse:min-w-11';

interface ToolbarProps {
  fileName: string;
  /** Shows the unsaved-changes badge beside the file name. */
  isDirty?: boolean;
  currentPage: number;
  totalPages: number;
  scale: number;
  drawnPaths: DrawnPath[];
  isSaving: boolean;
  canUndo: boolean;
  canRedo: boolean;
  onClose: () => void;
  onPrevPage: () => void;
  onNextPage: () => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onUndo: () => void;
  onRedo: () => void;
  onClearPaths: () => void;
  onDownload: () => void;
  saveMode?: 'quick' | 'optimized';
  onSaveModeChange?: (mode: 'quick' | 'optimized') => void;
  onToggleSearch?: () => void;
  isSearchOpen?: boolean;
  /** Open the export panel */
  onExport?: () => void;
  /** PDF document for size estimation */
  doc?: PDFDocumentData | null;
  /** Compressed download handler */
  onCompressedDownload?: (opts: CompressedDownloadOptions) => void;
  /** Focus Mode hides the options and pages panels; omit to hide the control. */
  isFocusMode?: boolean;
  onToggleFocusMode?: () => void;
  /** Pages panel visibility; omit the handler to hide the control. */
  isThumbnailsOpen?: boolean;
  onToggleThumbnails?: () => void;
}

export function Toolbar({
  fileName,
  isDirty = false,
  currentPage,
  totalPages,
  scale,
  drawnPaths,
  isSaving,
  canUndo,
  canRedo,
  onClose,
  onPrevPage,
  onNextPage,
  onZoomIn,
  onZoomOut,
  onUndo,
  onRedo,
  onClearPaths,
  onDownload,
  saveMode,
  onSaveModeChange,
  onToggleSearch,
  isSearchOpen,
  onExport,
  doc,
  onCompressedDownload,
  isFocusMode = false,
  onToggleFocusMode,
  isThumbnailsOpen = true,
  onToggleThumbnails,
}: ToolbarProps) {
  const { theme, toggleTheme } = useTheme();
  // Z_LAYERS.toolbar (120): above sidebars, below global drawers.

  return (
    <header className="flex flex-wrap items-center justify-between gap-y-1 px-2 md:px-4 py-1 md:py-0 min-h-12 md:h-14 bg-panel/90 backdrop-blur-lg border-b border-app shrink-0 z-[120]">
      {/* ── Left: close + logo + filename ── */}
      <div className="flex items-center gap-1.5 md:gap-3 shrink-0">
        <button 
          onClick={onClose} 
          className={`p-1.5 text-app-muted hover:text-red-400 hover:bg-red-500/10 rounded-lg transition-all duration-200 ${TOUCH_TARGET}`}
          title="Close file & return home"
        >
          <X size={18} />
        </button>
        <Link href="/" className="flex items-center gap-2 mr-1.5 group">
          <Image
            src={`${BRAND_BASE_PATH}/brand/paperloom-mark.svg`}
            alt={BRAND_NAME}
            width={32}
            height={32}
            className="w-6 h-6 md:w-7 md:h-7 object-contain shrink-0"
            priority
          />
          <span className="hidden sm:inline font-bold text-sm tracking-tight text-app group-hover:text-accent transition-colors">
            {BRAND_NAME}
          </span>
        </Link>
        <div className="w-[1px] h-4 bg-[var(--border)] hidden md:block" />
        <span className="hidden md:inline text-app font-medium text-xs sm:text-sm truncate max-w-[200px] opacity-90">{fileName}</span>
        {isDirty && (
          <span
            role="status"
            title="This document has changes that are not downloaded yet"
            className="shrink-0 rounded-md border border-accent/40 bg-bloom-100 px-1.5 py-0.5 text-[10px] font-semibold text-accent"
          >
            Unsaved
          </span>
        )}
      </div>

      {/* ── Center: undo/redo, page nav, zoom ── */}
      <div className="order-3 basis-full md:order-none md:basis-auto flex items-center justify-center gap-1 pointer-coarse:gap-0 md:gap-2 bg-panel-elevated px-1.5 md:px-2 py-1 md:py-1.5 rounded-lg border border-app shadow-sm overflow-x-auto scrollbar-hide">
        <button
          onClick={onUndo}
          disabled={!canUndo}
          className={`p-1 text-app-muted hover:text-app disabled:opacity-30 disabled:hover:text-app-muted transition-colors shrink-0 ${TOUCH_TARGET}`}
          title="Undo (Ctrl+Z)"
        >
          <Undo2 size={16} />
        </button>
        <button
          onClick={onRedo}
          disabled={!canRedo}
          className={`p-1 text-app-muted hover:text-app disabled:opacity-30 disabled:hover:text-app-muted transition-colors shrink-0 ${TOUCH_TARGET}`}
          title="Redo (Ctrl+Shift+Z)"
        >
          <Redo2 size={16} />
        </button>

        <div className="w-[1px] h-4 bg-[var(--border)] mx-0.5 md:mx-1 hidden sm:block shrink-0" />

        <button aria-label="Previous page" onClick={onPrevPage} disabled={currentPage === 0} className={`p-1 text-app-muted hover:text-app disabled:opacity-30 disabled:hover:text-app-muted transition-colors shrink-0 ${TOUCH_TARGET}`}>
          <ChevronLeft size={18} />
        </button>
        <span className="text-app-muted text-xs font-medium w-12 md:w-16 text-center tracking-wider shrink-0">
          {currentPage + 1} / {totalPages}
        </span>
        <button aria-label="Next page" onClick={onNextPage} disabled={currentPage >= totalPages - 1} className={`p-1 text-app-muted hover:text-app disabled:opacity-30 disabled:hover:text-app-muted transition-colors shrink-0 ${TOUCH_TARGET}`}>
          <ChevronRight size={18} />
        </button>

        <div className="w-[1px] h-4 bg-[var(--border)] mx-0.5 md:mx-2 hidden sm:block shrink-0" />

        <button aria-label="Zoom out" onClick={onZoomOut} disabled={scale <= 0.5} className={`p-1 text-app-muted hover:text-app disabled:opacity-30 disabled:hover:text-app-muted transition-colors shrink-0 ${TOUCH_TARGET}`}>
          <ZoomOut size={16} />
        </button>
        <span className="text-app-muted text-xs font-medium w-10 md:w-12 text-center shrink-0">
          {Math.round(scale * 100)}%
        </span>
        <button aria-label="Zoom in" onClick={onZoomIn} disabled={scale >= 4} className={`p-1 text-app-muted hover:text-app disabled:opacity-30 disabled:hover:text-app-muted transition-colors shrink-0 ${TOUCH_TARGET}`}>
          <ZoomIn size={16} />
        </button>
      </div>

      {/* ── Right: actions ── */}
      <div className="flex items-center gap-1 md:gap-2 shrink-0">
        <button
          onClick={toggleTheme}
          className={`p-1.5 md:p-2 rounded-lg transition-colors border bg-panel-elevated text-app-muted hover:text-app border-app ${TOUCH_TARGET}`}
          title={theme === 'dark' ? 'Switch to white mode' : 'Switch to dark mode'}
        >
          {theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}
        </button>

        {onToggleFocusMode && (
          <button
            onClick={onToggleFocusMode}
            aria-pressed={isFocusMode}
            aria-label="Focus mode"
            className={`hidden md:inline-flex items-center justify-center pointer-coarse:min-h-11 pointer-coarse:min-w-11 p-1.5 md:p-2 rounded-lg transition-colors border ${isFocusMode ? 'bg-bloom-100 text-accent border-accent/50' : 'bg-panel-elevated text-app-muted hover:text-app border-app'}`}
            title={isFocusMode ? 'Exit focus mode' : 'Focus mode: hide options and pages panels'}
          >
            <Focus size={16} />
          </button>
        )}

        {onToggleThumbnails && (
          <button
            onClick={onToggleThumbnails}
            aria-pressed={isThumbnailsOpen}
            aria-label="Pages panel"
            className={`hidden md:inline-flex items-center justify-center pointer-coarse:min-h-11 pointer-coarse:min-w-11 p-1.5 md:p-2 rounded-lg transition-colors border ${isThumbnailsOpen ? 'bg-bloom-100 text-accent border-accent/50' : 'bg-panel-elevated text-app-muted hover:text-app border-app'}`}
            title={isThumbnailsOpen ? 'Hide pages panel' : 'Show pages panel'}
          >
            <PanelRight size={16} />
          </button>
        )}

        {onToggleSearch && (
          <button
            onClick={onToggleSearch}
            className={`p-1.5 md:p-2 rounded-lg transition-colors border ${TOUCH_TARGET} ${isSearchOpen ? 'bg-bloom-100 text-accent border-accent/50' : 'bg-panel-elevated text-app-muted hover:text-app border-app'}`}
            title="Toggle Find & Replace"
          >
            <Search size={16} />
          </button>
        )}

        {drawnPaths.length > 0 && (
          <button
            onClick={onClearPaths}
            className="hidden sm:block text-xs font-medium px-3 py-1.5 text-red-400 bg-red-400/10 hover:bg-red-400/20 rounded-md transition-colors"
          >
            Clear
          </button>
        )}

        {onExport && (
          <>
            <div className="w-[1px] h-6 bg-[var(--border)] hidden md:block" />
            <button
              onClick={onExport}
              className="
                flex items-center justify-center gap-1.5 text-xs font-medium px-2 md:px-3 py-1.5 md:py-2
                pointer-coarse:min-h-11 pointer-coarse:min-w-11
                bg-panel-elevated hover:opacity-90
                text-app-muted hover:text-app
                border border-app
                rounded-xl transition-all duration-200
              "
              title="Export to PNG, JPEG, SVG, or text"
            >
              <FileOutput size={14} />
              <span className="hidden sm:inline">Export</span>
            </button>
          </>
        )}

        <div className="w-[1px] h-6 bg-[var(--border)] hidden sm:block" />

        <DownloadDropdown
          isSaving={isSaving}
          onDownload={onDownload}
          saveMode={saveMode ?? 'optimized'}
          onSaveModeChange={onSaveModeChange ?? (() => {})}
          doc={doc ?? null}
          onCompressedDownload={onCompressedDownload}
        />
      </div>
    </header>
  );
}
