'use client';

import { useEffect, useLayoutEffect, useState, useRef, useCallback, useMemo, type SetStateAction } from 'react';
import { useRouter } from 'next/navigation';
import {
  loadPdfFromStorage,
  clearPdfFromStorage,
  loadEditorSession,
  saveEditorSession,
  captureEditorSessionGeneration,
  commitDownloadedPdf,
  type EditorSessionRecord,
  type EditorSessionOverlay,
  type RecoveredFormDraft,
} from '@/lib/pdfStorage';
import { encryptRecoveryOverlay, decryptRecoveryOverlay } from '@/lib/recoveryEncryption';
import { X, Loader2, ChevronLeft, Image, Type } from 'lucide-react';
import { BRAND_NAME } from '@/lib/brand';

// We import types only — the engine modules are loaded dynamically
// because they require browser APIs (canvas, DecompressionStream)
import type { PDFDocumentData, RenderResult, TextRun, TextLine, ImageItem, PathItem, DisplayItem, TextWatermark, ImageWatermark, Watermark, DetectedWatermark, AcroFormWidget, BloomPage, DetectedTable, VisualSignature, SignatureField, ManagedIdentity, ValidationReport } from '@/engine/browser-core';

import type { EditorTool, ToolDef, PathType, DrawnPath, FloatingText, FloatingImage, DrawMode } from './types';
import type { WatermarkPosition } from '@/engine/watermark/watermark-engine';
import { TOOLS } from './types';
import {
  canvasToPdf, pdfToCanvas, hexToRGB,
  hitTestTextLine, findNearestTextLine, caretIndexFromLineX,
  getLineBounds, getOverlayFontFamily, getOverlayFontStyle, getDisplayFontFamily,
} from './utils';
import { buildDisplayListIndex, hitTestDisplayList, isSelectableDisplayItem, captureHistoryEntry, restoreAnnotSnapshot, restoreDocumentStructure, parseOverlaySnapshot, deleteObject, visualFontSize, resolveRunStyleFlags, transformObject, applyObjectTransform, distributeTextChangeToSegments, segmentAtIndex, createVisualSignature, hitTestSignature, moveSignature, rotateSignature, setSignatureOpacity, setSignatureLocked, deleteSignature, updateSignature, getSignatureLibrary, DEFAULT_SIGNATURE_SIZE, detectSignatureFieldsOnPage, hitTestSignatureField, applySignatureFieldAppearanceAsync, getCertificateManager, validateDocumentSignatures, enableLongTermValidation, getLtvStatus, listManagedSignatures, buildRevisionViewer, lockSignaturesAfterSigning, pushRecentSignatureId, SIGNATURE_SHORTCUTS } from '@/engine/browser-core';
import type { Annotation, QuadTree, SelectableItem, EditableObject, EditorHistoryEntry, PDFRef } from '@/engine/browser-core';
import { UnsupportedGlyphsError, SessionDocumentEditor } from '@/engine/browser-core';
import { SessionEditorHistory } from '@/engine/session/editor-history';
import { addDrawingAnnotations, collectDrawingRemovals, collectMarkupRemovals, previewMarkupRemoval, removeMarkupReferences } from '@/engine/session/document-edit';
import { signDocumentTransaction } from '@/engine/session/signature-transaction';
import { findVisualSignatureRefs, placeVisualSignature, removeVisualSignature } from '@/engine/session/signature-edit';
import { PDFDict, PDFString } from '@/engine/types';
import { findMatchingFlowLine } from './flowLineMatch';
import { EditorDocumentOwner } from './document-owner';
import { parseRecoveryOverlay } from './recovery-overlay';
import { FormDraftController, resolveRecoveredFormDraft } from './form-draft-controller';
import { decodeMultiChoiceDraft, encodeMultiChoiceDraft } from './multi-choice-draft';
import { useDrawingPointer } from './drawing-pointer';
import { pageOverlayGroups, restoreOverlayPages, snapshotOverlayItems } from './overlay-pages';
import { timestampFallbackMessage } from './timestamp-fallback';
import { UnassignedOverlays, type OverlayKind } from './components/UnassignedOverlays';
import { openDocumentLink } from './document-link';
import {
  resolveTypingStyleFromCaret,
  runAtDistributedEditIndex,
  remapStyleRange,
  coalesceFontSizePatches,
  expandFontSizePatchesThroughSpaces,
  cssFontFamilyFromUI,
  runHasPathUnderline,
  type EditStyleOverride,
  type TypingStyle,
} from './textStyleUtils';

import { Toolbar } from './components/Toolbar';
import type { CompressedDownloadOptions } from './components/downloadQualityOptions';
import { ToolsSidebar } from './components/ToolsSidebar';
import { PropertiesSidebar } from './components/PropertiesSidebar';
import { EditableLineBox, type OverlaySegmentStyle } from './components/EditableLineBox';
import { runOcrOperation, supportsOcrPageGeometry } from './ocr-operation';
import { normalizePageContent } from './normalize-page-content';
import { canvasToImageData } from '@/lib/ocr/adapter';
import { LinkPopover, type LinkPopoverMode } from './components/LinkPopover';
import { EmbeddedImageOverlay } from './components/EmbeddedImageOverlay';
import { SignatureOverlay } from './components/signatures/SignatureOverlay';
import { SignatureCreateDialog, type SignatureCreateResult } from './components/signatures/SignatureCreateDialog';
import { CertificateImportDialog } from './components/signatures/CertificateImportDialog';
import { WatermarkPreview } from './components/WatermarkPreview';
import { ThumbnailsSidebar } from './components/ThumbnailsSidebar';
import { generateThumbnails, ThumbnailCoordinator } from './thumbnail-generation';
import { captureFormThumbnailSnapshot, changedFormThumbnailPages, type FormThumbnailSnapshot } from './form-thumbnail-pages';
import { FieldRenameNotice } from './components/FieldRenameNotice';
import { FindReplacePanel } from './components/FindReplacePanel';
import { StatusBar } from './components/StatusBar';
import { ExportPanel } from './components/ExportPanel';
import { PasswordDialog } from './components/PasswordDialog';
import { PdfConformanceNotice } from './components/PdfConformanceNotice';
import { UnsavedChangesDialog } from './components/UnsavedChangesDialog';
import { SecurityPanel } from './components/SecurityPanel';
import { hasPendingFormFieldDraft, isButtonWidgetChecked } from './components/button-field-state';
import { useTextStyleActions, type TextStyleUI } from './hooks/useTextStyleActions';
import { useIsMobile } from './hooks/useIsMobile';
import { usePanelLayout } from './hooks/usePanelLayout';
import { useSignatureLibrary } from './hooks/useSignatureLibrary';
import { editorKeyboardAction } from './keyboard-actions';
import { floatingTextPdfDelta, shouldStartFloatingTextDrag } from './components/pointerDragGeometry';
import { initialFloatingTextSelection } from './components/floatingTextSelection';
import { resizeBox } from './components/resizeGeometry';
import { findImagePlacement, sameImagePlacement } from './components/imageSelection';
import { resolveSelectedObject } from './components/selectedObject';
import type { ImageBox } from './components/imageBoxEdit';
import { DocumentSearchIndex, SearchChangedError, SearchPageError, assertCurrentReplaceSupported, replaceSearchMatches, searchLatestDocument, type SearchMatch } from './search-index';
import { searchHighlightBounds } from './search-highlight';
import { redactionRegionFromDrag } from './redaction-selection';
import { hasDocumentSignature } from '@/engine/writer/save-pipeline';

async function restoreHistoryGraph(
  doc: PDFDocumentData,
  entry: EditorHistoryEntry,
  engine: typeof import('@/engine/browser-core'),
): Promise<void> {
  if (entry.pages) {
    await restoreDocumentStructure(doc, entry, engine.updatePageContent);
    return;
  }
  const page = entry.pageKey ? doc.pages.find(candidate => candidate.ref.toKey() === entry.pageKey) : doc.pages[entry.pageIndex];
  if (!page) return;
  await engine.updatePageContent(page.contentRefs, entry.contentBytes, doc.objects);
  restoreAnnotSnapshot(page.dict, doc.objects, entry.annotSnapshot);
}



// ─── Component ──────────────────────────────────────────────────────────────

export default function EditorPage() {
  const router = useRouter();

  // ── Core state ──
  const [doc, setDocumentState] = useState<PDFDocumentData | null>(null);
  const documentOwnerRef = useRef(new EditorDocumentOwner());
  useEffect(() => () => { documentOwnerRef.current.replace(null); }, []);
  const setDoc = useCallback((next: PDFDocumentData | null) => {
    documentOwnerRef.current.replace(next);
    setDocumentState(next);
  }, []);
  const [fileName, setFileName] = useState('');
  const [currentPage, setCurrentPage] = useState(0);
  const currentPageRef = useRef(0);
  const [totalPages, setTotalPages] = useState(0);
  const [scale, setScale] = useState(1.0);
  const [isLoading, setIsLoading] = useState(true);
  const [isRendering, setIsRendering] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [glyphWarning, setGlyphWarning] = useState<string | null>(null);
  const [renamedFields, setRenamedFields] = useState<Array<{ from: string; to: string }>>([]);
  const [loadingFont, setLoadingFont] = useState(false);
  const showUnsupportedGlyphWarning = useCallback((cause: unknown): boolean => {
    if (!(cause instanceof UnsupportedGlyphsError)) return false;
    setGlyphWarning(cause.message);
    return true;
  }, []);
  const [needsPassword, setNeedsPassword] = useState(false);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [isVerifyingPassword, setIsVerifyingPassword] = useState(false);
  const pendingEncryptedDocRef = useRef<PDFDocumentData | null>(null);
  const pendingRecoveryRef = useRef<EditorSessionRecord | null>(null);
  const recoveryPasswordRef = useRef<string | null>(null);
  const [renderResult, setRenderResult] = useState<RenderResult | null>(null);
  const [renderedPage, setRenderedPage] = useState<{
    doc: PDFDocumentData; page: number; scale: number; dpr: number; revision: number; retry: number;
  } | null>(null);
  const [pageRenderError, setPageRenderError] = useState<string | null>(null);
  const renderReadyRef = useRef(false);
  const [thumbnails, setThumbnails] = useState<string[]>([]);
  const [thumbnailKey, setThumbnailKeyState] = useState(0);
  const thumbnailCoordinator = useRef(new ThumbnailCoordinator<PDFDocumentData>());
  const setThumbnailKey = useCallback((value: SetStateAction<number>) => {
    thumbnailCoordinator.current.invalidate();
    setThumbnailKeyState(value);
  }, []);
  const [isGeneratingThumbnails, setIsGeneratingThumbnails] = useState(false);

  const [activeTool, setActiveTool] = useState<EditorTool>('text');
  const isMobile = useIsMobile();
  const { isPanelOpen, setIsPanelOpen, isThumbnailsOpen, setIsThumbnailsOpen, isFocusMode, setIsFocusMode } = usePanelLayout(isMobile);
  const [showMobileThumbnails, setShowMobileThumbnails] = useState(false);
  const [selectedLine, setSelectedLine] = useState<TextLine | null>(null);
  const [editingLineState, setEditingLineState] = useState<TextLine | null>(null);
  const editingLineRef = useRef<TextLine | null>(null);
  const editingLine = editingLineState;
  const setEditingLine = useCallback((line: TextLine | null | ((prev: TextLine | null) => TextLine | null)) => {
    if (typeof line === 'function') {
      setEditingLineState((prev: TextLine | null) => {
        const next = line(prev);
        editingLineRef.current = next;
        return next;
      });
    } else {
      editingLineRef.current = line;
      setEditingLineState(line);
    }
  }, []);
  const initialRunTextRef = useRef<string>('');
  const editAnchorLineRef = useRef<TextLine | null>(null);
  const [editAnchorLine, setEditAnchorLineState] = useState<TextLine | null>(null);
  const setEditAnchorLine = useCallback((line: TextLine | null) => {
    editAnchorLineRef.current = line;
    setEditAnchorLineState(line);
  }, []);
  /** Pending style patches queued while typing, each with a char range. */
  const pendingStylesRef = useRef<Array<{ patch: Partial<TextStyleUI>; start: number; end: number }>>([]);
  /** Word-like typing style: applies to newly typed chars when caret is collapsed. */
  const typingStyleRef = useRef<Partial<Pick<TextStyleUI, 'bold' | 'italic' | 'underline' | 'color' | 'fontSize' | 'fontFamily'>>>({});
  const [typingStyle, setTypingStyleState] = useState<typeof typingStyleRef.current>({});
  const setTypingStyle = useCallback((style: typeof typingStyleRef.current) => {
    typingStyleRef.current = style;
    setTypingStyleState(style);
  }, []);
  /** True while the pointer is over the link popover (keeps hover open). */
  const linkPopoverHoverRef = useRef(false);
  const editTextRef = useRef('');
  const [editText, setEditText] = useState('');
  const [caretPos, setCaretPos] = useState(0); // character index for caret
  const editSelRef = useRef({ start: 0, end: 0 });
  const [editSel, setEditSel] = useState({ start: 0, end: 0 });
  /** Live style overrides for the edit overlay (selection-scoped). */
  const [editStyleOverrides, setEditStyleOverrides] = useState<EditStyleOverride[]>([]);
  /** CSS-pixel offset of the edit box from its natural position. */
  const [editOffsetCss, setEditOffsetCss] = useState({ x: 0, y: 0 });
  /** Snap guide positions (CSS px in page overlay space) shown while dragging a text box. */
  const [snapGuides, setSnapGuides] = useState<{ x: number | null; y: number | null }>({ x: null, y: null });
  /** Manual size override in CSS px (null = auto-grow from content). */
  const [editManualSize, setEditManualSize] = useState<{ w: number | null; h: number | null }>({ w: null, h: null });
  const [isSaving, setIsSaving] = useState(false);
  const [securityBusy, setSecurityBusy] = useState(false);
  const [isDownloading, setIsDownloading] = useState(false);
  const [isCheckingClose, setIsCheckingClose] = useState(false);
  const [closeDialogOpen, setCloseDialogOpen] = useState(false);
  const [closeBusy, setCloseBusy] = useState(false);
  const [closeError, setCloseError] = useState<string | null>(null);
  const closeOperationRef = useRef(false);
  const downloadOperationRef = useRef(false);
  const securityBusyRef = useRef(false);
  const [renderKey, setRenderKey] = useState(0);
  const [renderRetry, setRenderRetry] = useState(0);
  const [redactionSelecting, setRedactionSelecting] = useState(false);
  const [redactionRegion, setRedactionRegion] = useState<{
    pageKey: string; scale: number; revision: number;
    pdf: { x: number; y: number; width: number; height: number };
    screen: { x: number; y: number; width: number; height: number };
  } | null>(null);
  const redactionDragRef = useRef<{ pointerId: number; x: number; y: number; width: number; height: number;
    doc: PDFDocumentData; pageKey: string; page: number; scale: number; revision: number } | null>(null);
  const [redactionPreview, setRedactionPreview] = useState<{ x: number; y: number; width: number; height: number } | null>(null);
  const renderReady = !!renderResult && !!renderedPage && renderedPage.doc === doc &&
    renderedPage.page === currentPage && renderedPage.scale === scale &&
    renderedPage.revision === renderKey && renderedPage.retry === renderRetry;
  const redactionViewRef = useRef({ doc, page: currentPage, scale, revision: renderKey, tool: activeTool });
  useLayoutEffect(() => { redactionViewRef.current = { doc, page: currentPage, scale, revision: renderKey, tool: activeTool }; },
    [doc, currentPage, scale, renderKey, activeTool]);
  useLayoutEffect(() => { renderReadyRef.current = renderReady; }, [renderReady]);
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      setRedactionSelecting(false);
      setRedactionRegion(null);
      setRedactionPreview(null);
      redactionDragRef.current = null;
    });
    return () => cancelAnimationFrame(frame);
  }, [doc, currentPage, scale, renderKey]);

  // Bloom Engine — Word-like page model (source of truth for text editing)
  const [bloomPage, setBloomPage] = useState<BloomPage | null>(null);
  const bloomPageRef = useRef<BloomPage | null>(null);
  const editingBlockIdRef = useRef<string | null>(null);
  const setBloomPageBoth = useCallback((page: BloomPage | null) => {
    bloomPageRef.current = page;
    setBloomPage(page);
  }, []);

  // Drawing state
  const [isDrawing, setIsDrawing] = useState(false);
  const isDrawingRef = useRef(false);
  const [drawnPaths, setDrawnPaths] = useState<DrawnPath[]>([]);
  const [drawMode, setDrawMode] = useState<DrawMode>('freehand');
  const currentDrawPath = useRef<{ x: number; y: number }[]>([]);
  const shapeStartRef = useRef<{ x: number; y: number } | null>(null);
  const shapeEndRef = useRef<{ x: number; y: number } | null>(null);
  /** True after a freehand highlight/draw stroke so click doesn't also add a PDF annotation. */
  const skipNextHighlightClickRef = useRef(false);
  /** True once the pointer moved enough during highlight/draw to count as a drag. */
  const drawDraggedRef = useRef(false);
  /** Last eraser sample point — used to interpolate when the pointer jumps. */
  const lastErasePosRef = useRef<{ x: number; y: number } | null>(null);
  /** True if the current erase gesture removed anything (for one undo step). */
  const eraseChangedRef = useRef(false);
  /** Text-markup and Ink hits commit together at the existing erase-gesture boundary. */
  const erasedAnnotationsRef = useRef(new Map<string, PDFRef>());
  const annotationCommitPendingRef = useRef<Promise<void> | null>(null);
  const [pageLinks, setPageLinks] = useState<import('@/engine/browser-core').PageLinkInfo[]>([]);
  const [selectedLink, setSelectedLink] = useState<import('@/engine/browser-core').PageLinkInfo | null>(null);
  const [linkDraftUrl, setLinkDraftUrl] = useState('');
  const [linkDisplayDraft, setLinkDisplayDraft] = useState('');
  /** Only after "Scan for links" — highlights + hover popovers on the PDF. */
  const [linksHighlighted, setLinksHighlighted] = useState(false);
  const [linkPopoverMode, setLinkPopoverMode] = useState<LinkPopoverMode | null>(null);
  const linkHoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Pending "add link" flow: waiting for URL in the text sidebar. */
  const [linkCreatePending, setLinkCreatePending] = useState(false);


  const [floatingTexts, setFloatingTexts] = useState<FloatingText[]>([]);
  const [activeFloatingTextId, setActiveFloatingTextId] = useState<string | null>(null);

  const [floatingImages, setFloatingImages] = useState<FloatingImage[]>([]);
  const [activeFloatingImageId, setActiveFloatingImageId] = useState<string | null>(null);
  const activePageKey = doc?.pages[currentPage]?.ref.toKey();
  if (activeFloatingTextId && !floatingTexts.some(item => item.id === activeFloatingTextId && item.pageKey === activePageKey)) {
    setActiveFloatingTextId(null);
  }
  if (activeFloatingImageId && !floatingImages.some(item => item.id === activeFloatingImageId && item.pageKey === activePageKey)) {
    setActiveFloatingImageId(null);
  }
  const formDraftControllerRef = useRef(new FormDraftController());
  const formComposingRef = useRef(false);
  // Central page transition; page-owned overlays remain in their original page.
  const changePage = useCallback((next: number | ((previous: number) => number)) => {
    const page = typeof next === 'function' ? next(currentPageRef.current) : next;
    if (page === currentPageRef.current) return;
    if (formDraftControllerRef.current.get()) {
      setError('Finish the form field edit before changing pages.');
      return;
    }
    currentPageRef.current = page;
    setActiveFloatingTextId(null);
    setActiveFloatingImageId(null);
    setCurrentPage(page);
  }, []);
  const replacingImageIdRef = useRef<string | null>(null);
  /** When set, next file pick replaces this embedded PDF image in-place. */
  const replacingEmbeddedImageRef = useRef<ImageItem | null>(null);

  const dragInfo = useRef<{ id: string; type: 'text' | 'image'; startX: number; startY: number; startPdfX: number; startPdfY: number } | null>(null);

  /** Viewport grab-to-pan while zoomed (or Space held). */
  const [isPanning, setIsPanning] = useState(false);
  const [spacePanHeld, setSpacePanHeld] = useState(false);
  const panDragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    scrollLeft: number;
    scrollTop: number;
    moved: boolean;
  } | null>(null);

  // Tool properties
  const [drawColor, setDrawColor] = useState('#ff3b30');
  const [drawSize, setDrawSize] = useState(2);
  const [highlightColor, setHighlightColor] = useState('#fffb00');
  const [highlightSize, setHighlightSize] = useState(16);
  const [eraserSize, setEraserSize] = useState(20);

  // Watermark tool properties
  const [watermarkType, setWatermarkType] = useState<'text' | 'image' | 'shape'>('text');
  const [watermarkShapeType, setWatermarkShapeType] = useState<'rectangle' | 'circle' | 'pill'>('circle');
  const [watermarkShapeColor, setWatermarkShapeColor] = useState('#000000');
  const [watermarkText, setWatermarkText] = useState<string>(BRAND_NAME);
  const [watermarkFontName, setWatermarkFontName] = useState('Arial');
  const [watermarkOpacity, setWatermarkOpacity] = useState(50);
  const [watermarkRotation, setWatermarkRotation] = useState(45);
  const [watermarkSize, setWatermarkSize] = useState(50);
  const [watermarkPosition, setWatermarkPosition] = useState<WatermarkPosition>('center');
  const [watermarkMosaic, setWatermarkMosaic] = useState(false);
  const [watermarkLivePreview, setWatermarkLivePreview] = useState(true);
  const [showApplySuccessModal, setShowApplySuccessModal] = useState(false);
  const [watermarkPageFrom, setWatermarkPageFrom] = useState(1);
  const [watermarkPageTo, setWatermarkPageTo] = useState(1);
  const [watermarkLayer, setWatermarkLayer] = useState<'above' | 'below'>('above');
  const [watermarkColor, setWatermarkColor] = useState('#000000');
  const [watermarkImageFile, setWatermarkImageFile] = useState<File | null>(null);
  const [watermarkImageBytes, setWatermarkImageBytes] = useState<Uint8Array | null>(null);
  const [watermarkImageDims, setWatermarkImageDims] = useState<{ width: number; height: number } | null>(null);
  const [watermarkBlendMode, setWatermarkBlendMode] = useState('Normal');

  const [detectedWatermarks, setDetectedWatermarks] = useState<DetectedWatermark[] | null>(null);
  const [isConfirmingRemoval, setIsConfirmingRemoval] = useState(false);

  // Display items (images/paths) for selection overlays
  const [displayItems, setDisplayItems] = useState<(ImageItem | PathItem)[]>([]);
  /** Thin stroke paths (underlines) excluded from selection but needed for edit overlay. */
  const [strokePaths, setStrokePaths] = useState<PathItem[]>([]);
  const [selectedDisplayItem, setSelectedDisplayItem] = useState<ImageItem | PathItem | null>(null);
  // Pending arrow-key events can refer to the same pre-move selection.
  const movedImageSuccessorsRef = useRef(new WeakMap<ImageItem, ImageItem>());
  const [imageBoxPreview, setImageBoxPreview] = useState<{ item: ImageItem; box: ImageBox } | null>(null);
  const handleImageBoxPreview = useCallback((box: ImageBox | null) => {
    setImageBoxPreview(box && selectedDisplayItem?.type === 'image' ? { item: selectedDisplayItem, box } : null);
  }, [selectedDisplayItem]);
  const selectionPageRef = useRef(doc?.pages[currentPage]);
  const spatialIndexRef = useRef<QuadTree<SelectableItem> | null>(null);

  // AcroForm fields on current page
  const [formFields, setFormFields] = useState<AcroFormWidget[]>([]);
  const [selectedFormField, setSelectedFormField] = useState<AcroFormWidget | null>(null);
  const [formFieldDraft, setFormFieldDraft] = useState('');
  /** Auto-detected PDF tables (grid of text cells). */
  const [detectedTables, setDetectedTables] = useState<DetectedTable[]>([]);
  const [activeTableId, setActiveTableId] = useState<string | null>(null);

  // One chronological toolbar stack for legacy snapshots and session boundaries.
  const historyRef = useRef(new SessionEditorHistory());
  // Keep placement identity on both sides of a resize, even for reused XObjects.
  const imageResizeHistoryRef = useRef(new WeakMap<EditorHistoryEntry, { pageKey: string; before: ImageItem; after: ImageItem }>());
  const sessionEditorRef = useRef(new SessionDocumentEditor());
  const historyBusyRef = useRef(false);
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);
  const undoSnapshotRef = useRef<{ pageIndex: number; contentBytes: Uint8Array } | null>(null);

  const drawnPathsRef = useRef<DrawnPath[]>([]);
  const floatingTextsRef = useRef<FloatingText[]>([]);
  const floatingImagesRef = useRef<FloatingImage[]>([]);
  const floatingTextEditStartRef = useRef<FloatingText[] | null>(null);
  const pendingFloatingTextSelectionRef = useRef<string | null>(null);
  const signaturesRef = useRef<VisualSignature[]>([]);

  const syncTxState = useCallback(() => {
    setCanUndo(historyRef.current.canUndo());
    setCanRedo(historyRef.current.canRedo());
  }, []);

  const [textFontFamily, setTextFontFamily] = useState('Helvetica');
  const [textFontSize, setTextFontSize] = useState(12);
  const [textColor, setTextColor] = useState('#000000');
  const [textBold, setTextBold] = useState(false);
  const [textItalic, setTextItalic] = useState(false);
  const [textUnderline, setTextUnderline] = useState(false);
  const [textAlign, setTextAlign] = useState<'left' | 'center' | 'right'>('left');
  const [textOpacity, setTextOpacity] = useState(100);
  const [saveMode, setSaveMode] = useState<'quick' | 'optimized'>('optimized');
  const [isDirty, setIsDirtyState] = useState(false);
  const [editRevision, setEditRevision] = useState(0);
  const isDirtyRef = useRef(false);
  const editRevisionRef = useRef(0);
  const setIsDirty = useCallback((value: boolean) => {
    isDirtyRef.current = value;
    if (value) { editRevisionRef.current++; setEditRevision(editRevisionRef.current); }
    setIsDirtyState(value);
  }, []);
  // Saving clears unsaved state, not the fact that the upload has been edited.
  const hasEditedRef = useRef(true);
  const uploadBytesRef = useRef<Uint8Array | null>(null);

  // Keep an existing Add Text Box synchronized with the active formatting
  // controls, so later colour/font/style changes are exported too.
  const textSyncValues = [activeFloatingTextId, textFontFamily, textFontSize, textColor,
    textBold, textItalic, textUnderline, textOpacity] as const;
  const [previousTextSyncValues, setPreviousTextSyncValues] = useState(textSyncValues);
  if (textSyncValues.some((value, index) => value !== previousTextSyncValues[index])) {
    setPreviousTextSyncValues(textSyncValues);
    if (activeFloatingTextId) {
      setFloatingTexts(prev => prev.map(p => p.id === activeFloatingTextId ? {
        ...p,
        fontFamily: textFontFamily,
        fontSize: textFontSize,
        color: /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(textColor) ? textColor : p.color,
        bold: textBold,
        italic: textItalic,
        underline: textUnderline,
        opacity: textOpacity / 100,
      } : p));
    }
  }
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [findText, setFindText] = useState('');
  const [replaceText, setReplaceText] = useState('');
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [searchResults, setSearchResults] = useState<SearchMatch[]>([]);
  const [activeMatchIndex, setActiveMatchIndex] = useState<number>(0);
  const activeMatchIndexRef = useRef(0);
  const updateActiveMatchIndex = useCallback((index: number) => {
    activeMatchIndexRef.current = index;
    setActiveMatchIndex(index);
  }, []);
  const [searchBusy, setSearchBusy] = useState(false);
  const searchBusyRef = useRef(false);
  const lastSearchRef = useRef<{ doc: PDFDocumentData | null; query: string; caseSensitive: boolean } | null>(null);
  const [showExportPanel, setShowExportPanel] = useState(false);

  // Editable signature overlays backed by transactional native appearances.
  const [signatures, setSignatures] = useState<VisualSignature[]>([]);
  const [selectedSignatureId, setSelectedSignatureId] = useState<string | null>(null);
  const { entries: signatureLibraryEntries, refresh: refreshSignatureLibrary } = useSignatureLibrary();
  const [activeLibraryId, setActiveLibraryId] = useState<string | null>(null);
  const [signatureCreateOpen, setSignatureCreateOpen] = useState(false);
  const [pdfSignatureFields, setPdfSignatureFields] = useState<SignatureField[]>([]);
  const [selectedPdfSigFieldId, setSelectedPdfSigFieldId] = useState<string | null>(null);
  const [certificateImportOpen, setCertificateImportOpen] = useState(false);
  const [certificateIdentities, setCertificateIdentities] = useState<ManagedIdentity[]>([]);
  const [selectedCertificateId, setSelectedCertificateId] = useState<string | null>(null);
  const [cryptoSignBusy, setCryptoSignBusy] = useState(false);
  const cryptoSignBusyRef = useRef(false);
  const [enableTimestamp, setEnableTimestamp] = useState(false);
  const [validationBusy, setValidationBusy] = useState(false);
  const [validationReport, setValidationReport] = useState<ValidationReport | null>(null);
  const [signatureSummaryVersion, setSignatureSummaryVersion] = useState(0);
  const refreshMultiSigPanel = useCallback(() => setSignatureSummaryVersion(version => version + 1), []);
  const { ltvStatus, managedSignatures, revisionEntries } = useMemo(() => {
    // The PDF engine mutates document objects in place; these values signal relevant changes.
    void pdfSignatureFields;
    void signatureSummaryVersion;
    return doc ? {
      ltvStatus: getLtvStatus(doc),
      managedSignatures: listManagedSignatures(doc),
      revisionEntries: buildRevisionViewer(doc).revisions,
    } : { ltvStatus: null, managedSignatures: [], revisionEntries: [] };
  }, [doc, pdfSignatureFields, signatureSummaryVersion]);
  const originalIsCurrentRef = useRef(false);
  // Publish only committed render state to asynchronous editing and download handlers.
  useLayoutEffect(() => {
    selectionPageRef.current = doc?.pages[currentPage];
    drawnPathsRef.current = drawnPaths;
    floatingTextsRef.current = floatingTexts;
    floatingImagesRef.current = floatingImages;
    signaturesRef.current = signatures;
    if (isDirty || renderKey !== 0 || thumbnailKey !== 0) hasEditedRef.current = true;
    originalIsCurrentRef.current =
    !isDirty && !hasEditedRef.current && !isLoading &&
    renderKey === 0 && thumbnailKey === 0 &&
    !historyRef.current.canUndo() && !historyRef.current.canRedo() &&
    historyRef.current.peek()?.label === 'initial' &&
    drawnPaths.length === 0 && floatingTexts.length === 0 &&
    floatingImages.length === 0 && signatures.length === 0 &&
    !isDrawing && currentDrawPath.current.length === 0 &&
    !shapeStartRef.current && !shapeEndRef.current && !eraseChangedRef.current &&
    !editingLineRef.current && !editingBlockIdRef.current &&
    !editAnchorLineRef.current && !undoSnapshotRef.current &&
    pendingStylesRef.current.length === 0 && editStyleOverrides.length === 0 &&
    !floatingTextEditStartRef.current && !dragInfo.current &&
    !selectedFormField && !formFieldDraft &&
    !linkPopoverMode && !linkCreatePending &&
    !replacingImageIdRef.current && !replacingEmbeddedImageRef.current &&
    !signatureCreateOpen && !cryptoSignBusy && !searchBusy &&
    uploadBytesRef.current !== null && doc?.rawBytes === uploadBytesRef.current;
  });

  // ── Refs (declared early for hooks that need them) ──
  const canvasContainerRef = useRef<HTMLDivElement>(null);
  const scrollViewportRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const hiddenInputRef = useRef<HTMLTextAreaElement>(null);
  const blurTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const engineRef = useRef<typeof import('@/engine/browser-core') | null>(null);
  const [engineModule, setEngineModule] = useState<typeof import('@/engine/browser-core') | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const pdfCanvasRef = useRef<HTMLCanvasElement | null>(null);

  const pushEditorHistory = useCallback((
    label: string,
    overlayOverride?: {
      drawnPaths?: DrawnPath[];
      floatingTexts?: FloatingText[];
      floatingImages?: FloatingImage[];
      signatures?: VisualSignature[];
    },
    pageIndexOverride?: number,
    replaceCurrent = false,
    sessionEditor?: SessionDocumentEditor,
  ) => {
    if (!doc || !engineRef.current) return;
    const pageIndex = pageIndexOverride ?? currentPage;
    const page = doc.pages[pageIndex];
    if (!page) return;
    const bytes = engineRef.current.getPageContentBytes(page, doc.objects);
    const entry = captureHistoryEntry(
      doc,
      pageIndex,
      bytes,
      {
        drawnPaths: overlayOverride?.drawnPaths ?? drawnPathsRef.current,
        floatingTexts: overlayOverride?.floatingTexts ?? floatingTextsRef.current,
        floatingImages: overlayOverride?.floatingImages ?? floatingImagesRef.current,
        signatures: overlayOverride?.signatures ?? signaturesRef.current,
      },
      label,
    );
    if (replaceCurrent) {
      const previous = historyRef.current.peek();
      const resize = previous ? imageResizeHistoryRef.current.get(previous) : undefined;
      historyRef.current.replace(entry, true, sessionEditor);
      if (resize) imageResizeHistoryRef.current.set(entry, resize);
    } else historyRef.current.push(entry, sessionEditor);
    setIsDirty(true);
    syncTxState();
  }, [doc, currentPage, setIsDirty, syncTxState]);

  const assignRecoveredOverlay = useCallback((kind: OverlayKind, id: string, pageKey: string) => {
    if (!pageKey || !doc?.pages.some(page => page.ref.toKey() === pageKey)) return;
    if (kind === 'drawnPaths') {
      const next = drawnPathsRef.current.map(item => item.id === id && !item.pageKey ? { ...item, pageKey } : item);
      drawnPathsRef.current = next;
      setDrawnPaths(next);
      pushEditorHistory('assign-recovered-overlay', { drawnPaths: next });
    } else if (kind === 'floatingTexts') {
      const next = floatingTextsRef.current.map(item => item.id === id && !item.pageKey ? { ...item, pageKey } : item);
      floatingTextsRef.current = next;
      setFloatingTexts(next);
      pushEditorHistory('assign-recovered-overlay', { floatingTexts: next });
    } else {
      const next = floatingImagesRef.current.map(item => item.id === id && !item.pageKey ? { ...item, pageKey } : item);
      floatingImagesRef.current = next;
      setFloatingImages(next);
      pushEditorHistory('assign-recovered-overlay', { floatingImages: next });
    }
    setIsDirty(true);
  }, [doc, pushEditorHistory, setIsDirty]);

  // Keep rapid field input and signature gestures in chronological order.
  const queueNativeEdit = useCallback((source: PDFDocumentData, apply: (isCurrent: () => boolean) => Promise<void>): Promise<void> => {
    return documentOwnerRef.current.enqueue(source, () => annotationCommitPendingRef.current, apply);
  }, []);

  const commitFormFieldDraft = useCallback(async (): Promise<boolean> => {
    if (formComposingRef.current) { setError('Finish composing the form field before continuing.'); return false; }
    if (!doc || !engineRef.current) return !formDraftControllerRef.current.get();
    const engine = engineRef.current;
    try {
      await formDraftControllerRef.current.commit(async draft => {
        await queueNativeEdit(doc, async isCurrent => {
          const pageIndex = doc.pages.findIndex(page => page.ref.toKey() === draft.pageKey);
          if (pageIndex < 0) throw new Error('The form field page is no longer available. Your draft is preserved.');
          const current = engine.detectFormFieldsOnPage(doc, pageIndex).find(field => field.ref.toKey() === draft.fieldKey);
          if (!current) throw new Error('The form field is no longer available. Your draft is preserved.');
          if (!hasPendingFormFieldDraft(current, draft.value)) return;
          let beforeThumbnails: FormThumbnailSnapshot | null = null;
          try { beforeThumbnails = captureFormThumbnailSnapshot(doc); } catch { /* Rebuild all thumbnails if the snapshot is unsafe. */ }
          const editor = new SessionDocumentEditor();
          await editor.edit(doc, 'form-value', async staged => {
            const widget = engine.detectFormFieldsOnPage(staged, pageIndex).find(field => field.ref.toKey() === draft.fieldKey);
            if (!widget) throw new Error('Form field is unavailable');
            if (widget.fieldType === 'Btn') engine.setButtonFieldValue(staged, widget, draft.value === 'true' || draft.value === 'Yes' || draft.value === 'On');
            else if (widget.fieldType === 'Ch') engine.setChoiceFieldValue(staged, widget, widget.choiceFlags & (1 << 21) ? decodeMultiChoiceDraft(draft.value) : draft.value);
            else engine.setFormFieldValue(staged, widget, draft.value);
          }, { isCurrent });
          pushEditorHistory('form-value', undefined, pageIndex, false, editor);
          const fields = engine.detectFormFieldsOnPage(doc, pageIndex);
          if (currentPageRef.current === pageIndex) {
            setFormFields(fields);
            setSelectedFormField(selected => selected?.ref.toKey() === draft.fieldKey
              ? fields.find(field => field.ref.toKey() === draft.fieldKey) ?? selected : selected);
          }
          setIsDirty(true);
          setRenderKey(k => k + 1);
          let changedPages: number[] | null = null;
          try { if (beforeThumbnails) changedPages = changedFormThumbnailPages(beforeThumbnails, captureFormThumbnailSnapshot(doc)); } catch { /* Fall back to a full rebuild. */ }
          if (changedPages === null) setThumbnailKey(k => k + 1);
          else if (changedPages.length) {
            try {
              const pageKeys = doc.pages.map(page => page.ref.toKey());
              const result = await thumbnailCoordinator.current.refresh(doc, pageKeys, changedPages, async index => {
                const res = await engine.renderPage(doc, index, { scale: 0.15, renderText: true, renderPaths: true, renderImages: true, renderWidgets: true });
                return res.canvas.toDataURL('image/jpeg', 0.6);
              }, isCurrent, () => doc.pages.map(page => page.ref.toKey()));
              if (result.status === 'updated') setThumbnails(result.thumbnails);
              else if (result.status === 'rebuild' && isCurrent()) setThumbnailKey(k => k + 1);
            } catch (error) {
              console.warn('[Editor] Form thumbnail refresh failed:', error);
              if (isCurrent()) setThumbnailKey(k => k + 1);
            }
          }
        });
      });
      return true;
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Form value edit failed');
      return false;
    }
  }, [doc, queueNativeEdit, pushEditorHistory, setIsDirty, setThumbnailKey]);

  const handleFormFieldDraftChange = useCallback((value: string) => {
    if (!doc || !selectedFormField || !doc.pages[currentPage]) return;
    formDraftControllerRef.current.set({ pageKey: doc.pages[currentPage].ref.toKey(), fieldKey: selectedFormField.ref.toKey(), value });
    setFormFieldDraft(value);
    setIsDirty(true);
  }, [doc, selectedFormField, currentPage, setIsDirty]);

  const handleFormFieldChange = useCallback((value: string) => {
    handleFormFieldDraftChange(value);
    void commitFormFieldDraft();
  }, [handleFormFieldDraftChange, commitFormFieldDraft]);

  const handleFormFieldSelect = useCallback(async (field: AcroFormWidget) => {
    if (!await commitFormFieldDraft()) return;
    if (!doc || !engineRef.current) return;
    const latest = engineRef.current.detectFormFieldsOnPage(doc, currentPageRef.current)
      .find(candidate => candidate.ref.toKey() === field.ref.toKey());
    if (!latest) { setError('The form field is no longer available.'); return; }
    setSelectedFormField(latest);
    setFormFieldDraft(latest.fieldType === 'Btn' ? (isButtonWidgetChecked(latest) ? 'Yes' : 'Off')
      : latest.fieldType === 'Ch' && (latest.choiceFlags & (1 << 21))
        ? encodeMultiChoiceDraft(Array.isArray(latest.value) ? latest.value : typeof latest.value === 'string' ? [latest.value] : [])
        : typeof latest.value === 'string' ? latest.value : '');
    setActiveTool('select');
  }, [doc, commitFormFieldDraft]);

  const commitSignatureChange = useCallback(async (
    update: (current: VisualSignature[]) => VisualSignature[],
    label: string,
  ) => {
    if (!doc) return false;
    try {
      await queueNativeEdit(doc, async isCurrent => {
        const previous = signaturesRef.current;
        const next = update(previous);
        const editor = new SessionDocumentEditor();
        await editor.edit(doc, label, async staged => {
          for (const signature of previous) {
            if (!next.some(item => item.id === signature.id)) removeVisualSignature(staged, signature.id);
          }
          for (const signature of next) {
            if (previous.includes(signature)) continue;
            const image = signature.appearanceImageDataUrl ?? getSignatureLibrary().get(signature.appearanceId)?.imageDataUrl;
            if (!image) throw new Error('Signature appearance is unavailable');
            await placeVisualSignature(staged, signature, image);
          }
        }, { isCurrent });
        signaturesRef.current = next;
        setSignatures(next);
        pushEditorHistory(label, { signatures: next }, undefined, false, editor);
        setIsDirty(true);
        setRenderKey(k => k + 1);
        setThumbnailKey(k => k + 1);
      });
      return true;
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Signature edit failed');
      return false;
    }
  }, [doc, pushEditorHistory, queueNativeEdit, setThumbnailKey]);

  const pushSignatureSnapshot = useCallback((next: VisualSignature[], label: string, editor?: SessionDocumentEditor) => {
    setSignatures(next);
    signaturesRef.current = next;
    pushEditorHistory(label, { signatures: next }, undefined, false, editor);
    setIsDirty(true);
  }, [pushEditorHistory]);

  const applyHistoryEntry = useCallback(async (
    entry: EditorHistoryEntry,
    restoredDocument = false,
    resizeSelection?: { pageKey?: string; image?: ImageItem; signatureId?: string },
  ) => {
    if (!doc || !engineRef.current) return;
    const engine = engineRef.current;
    if (!restoredDocument) await restoreHistoryGraph(doc, entry, engine);
    const restoredOverlays = restoreOverlayPages({
      drawnPaths: parseOverlaySnapshot<DrawnPath[]>(entry.overlays.drawnPathsJson),
      floatingTexts: parseOverlaySnapshot<FloatingText[]>(entry.overlays.floatingTextsJson),
      floatingImages: parseOverlaySnapshot<FloatingImage[]>(entry.overlays.floatingImagesJson),
    }, doc.pages.length === 1 ? doc.pages[0].ref.toKey() : null);
    const { drawnPaths: paths, floatingTexts: texts, floatingImages: images } = restoredOverlays;
    setDrawnPaths(paths);
    drawnPathsRef.current = paths;
    setFloatingTexts(texts);
    floatingTextsRef.current = texts;
    setFloatingImages(images);
    floatingImagesRef.current = images;
    const sigs = parseOverlaySnapshot<VisualSignature[]>(entry.overlays.signaturesJson);
    setSignatures(sigs);
    signaturesRef.current = sigs;
    const pageKey = resizeSelection?.image || resizeSelection?.signatureId ? resizeSelection.pageKey : entry.pageKey;
    setSelectedSignatureId(resizeSelection?.signatureId && sigs.some(sig => sig.id === resizeSelection.signatureId)
      ? resizeSelection.signatureId : null);
    let restoredImage: ImageItem | null = null;
    if (resizeSelection?.image) {
      const page = pageKey ? doc.pages.find(candidate => candidate.ref.toKey() === pageKey) : doc.pages[entry.pageIndex];
      if (page) {
        const content = engine.getPageContentBytes(page, doc.objects);
        const { displayList } = engine.interpretPage(content, page, doc.objects, new engine.OptionalContentVisibility(doc.catalog, doc.objects));
        const items = displayList.filter(item => isSelectableDisplayItem(item, page.mediaBox)) as (ImageItem | PathItem)[];
        setDisplayItems(items);
        spatialIndexRef.current = buildDisplayListIndex(items, page.mediaBox);
        restoredImage = findImagePlacement(items, resizeSelection.image);
      }
    }
    setSelectedDisplayItem(restoredImage);
    setSelectedLine(null);
    setSelectedFormField(null);
    setFormFieldDraft('');
    setSelectedPdfSigFieldId(null);
    setTotalPages(doc.pages.length);
    setIsDirty(true);
    const stablePageIndex = pageKey ? doc.pages.findIndex((page) => page.ref.toKey() === pageKey) : entry.pageIndex;
    const nextPage = stablePageIndex >= 0 ? stablePageIndex : Math.min(entry.pageIndex, doc.pages.length - 1);
    if (nextPage !== currentPage) changePage(nextPage);
    syncTxState();
    setRenderKey((k) => k + 1);
    setThumbnailKey((k) => k + 1);
  }, [doc, currentPage, syncTxState, setThumbnailKey]);

  const bumpRender = useCallback(() => {
    setIsDirty(true);
    setRenderKey(k => k + 1);
  }, []);

  const getEditSelectionRange = useCallback(() => {
    if (!editingLineRef.current) return null;
    return editSelRef.current;
  }, []);

  const resolveEditStyleRange = useCallback((line: TextLine, start: number, end: number) => {
    const s = Math.max(0, Math.min(start, line.text.length));
    const e = Math.max(s, Math.min(end, line.text.length));
    // Collapsed caret is handled as typing-style (no existing-text restyle).
    if (e <= s) return { start: s, end: s };
    return { start: s, end: e };
  }, []);

  const { applyStyle } = useTextStyleActions(
    engineRef,
    doc,
    currentPage,
    selectedLine,
    bumpRender,
    getEditSelectionRange,
  );

  // Apply style changes from properties sidebar to the PDF
  const queueOrApplyStyle = useCallback((patch: Partial<TextStyleUI>) => {
    if (!selectedLine) return;
    if (editingLineRef.current) {
      const sel = editSelRef.current;
      const line = editAnchorLineRef.current ?? selectedLine;
      // Collapsed caret → typing style only (Word-like). Do NOT restyle existing text.
      if (sel.end <= sel.start) {
        setTypingStyle({
          ...typingStyleRef.current,
          ...(patch.bold != null ? { bold: patch.bold } : {}),
          ...(patch.italic != null ? { italic: patch.italic } : {}),
          ...(patch.underline != null ? { underline: patch.underline } : {}),
          ...(patch.color != null ? { color: patch.color } : {}),
          ...(patch.fontSize != null ? { fontSize: patch.fontSize } : {}),
          ...(patch.fontFamily != null ? { fontFamily: patch.fontFamily } : {}),
        });
        return;
      }
      // Real selection (drag / double-click word / select-all) → style only that range
      const range = resolveEditStyleRange(line, sel.start, sel.end);
      if (range.end <= range.start) return;
      pendingStylesRef.current = [...pendingStylesRef.current, { patch, ...range }];
      setEditStyleOverrides(prev => [
        ...prev,
        {
          start: range.start,
          end: range.end,
          bold: patch.bold,
          italic: patch.italic,
          underline: patch.underline,
          color: patch.color,
          fontSize: patch.fontSize,
          fontFamily: patch.fontFamily,
        },
      ]);
      return;
    }
    void applyStyle(patch);
  }, [selectedLine, applyStyle, resolveEditStyleRange, setTypingStyle]);

  const handleEditSelection = useCallback((start: number, end: number) => {
    editSelRef.current = { start, end };
    setEditSel({ start, end });
    setCaretPos(start);
    // A real selection clears typing-style (Word-like)
    if (end > start) setTypingStyle({});

    // Sync sidebar toggles from the run under the caret / selection start
    const line = editAnchorLineRef.current;
    if (!line || !renderResult) return;
    const styleIndex = start > 0 ? start - 1 : 0;
    const currentText = editTextRef.current;
    const initialText = initialRunTextRef.current || line.text;
    const run = runAtDistributedEditIndex(line, initialText, currentText, styleIndex)
      ?? segmentAtIndex(line, Math.min(styleIndex, line.text.length))?.run;
    if (!run) {
      return;
    }
    const flags = resolveRunStyleFlags(run.fontName, renderResult.fonts.get(run.fontName));
    let bold = flags.bold;
    let italic = flags.italic;
    let underline = !!run.isUnderline || runHasPathUnderline(run, strokePaths);
    let fontSize = visualFontSize(run);
    const fontData = renderResult.fonts.get(run.fontName);
    let fontFamily = getDisplayFontFamily(run.fontName, fontData);
    for (const ov of editStyleOverrides) {
      if (start >= ov.start && start < ov.end) {
        if (ov.bold != null) bold = ov.bold;
        if (ov.italic != null) italic = ov.italic;
        if (ov.underline != null) underline = ov.underline;
        if (ov.fontSize != null) fontSize = ov.fontSize;
        if (ov.fontFamily) fontFamily = ov.fontFamily;
        if (ov.color) setTextColor(ov.color.startsWith('#') ? ov.color : textColor);
      }
    }
    // Collapsed caret: typing style wins (user just toggled bold off to type normal)
    if (start === end) {
      const ts = typingStyleRef.current;
      if (ts.bold != null) bold = ts.bold;
      if (ts.italic != null) italic = ts.italic;
      if (ts.underline != null) underline = ts.underline;
      if (ts.fontSize != null) fontSize = ts.fontSize;
      if (ts.fontFamily) fontFamily = ts.fontFamily;
      if (ts.color) setTextColor(ts.color);
    }
    setTextBold(bold);
    setTextItalic(italic);
    setTextUnderline(underline);
    setTextFontSize(fontSize);
    setTextFontFamily(fontFamily);
    if (!(start === end && typingStyleRef.current.color != null) && run.fillColor) {
      const hasColorOv = editStyleOverrides.some(
        ov => start >= ov.start && start < ov.end && ov.color,
      );
      if (!hasColorOv) {
        const [r, g, b] = run.fillColor;
        const hex = '#' + [r, g, b].map(c => Math.round(c * 255).toString(16).padStart(2, '0')).join('');
        setTextColor(hex);
      }
    }
  }, [renderResult, strokePaths, editStyleOverrides, textFontFamily, textColor, textBold, setTypingStyle]);

  const handleTextBold = useCallback((v: boolean | ((prev: boolean) => boolean)) => {
    setTextBold(prev => {
      const next = typeof v === 'function' ? v(prev) : v;
      queueOrApplyStyle({ bold: next });
      return next;
    });
  }, [queueOrApplyStyle]);
  const handleTextItalic = useCallback((v: boolean | ((prev: boolean) => boolean)) => {
    setTextItalic(prev => {
      const next = typeof v === 'function' ? v(prev) : v;
      queueOrApplyStyle({ italic: next });
      return next;
    });
  }, [queueOrApplyStyle]);
  const handleTextUnderline = useCallback((v: boolean | ((prev: boolean) => boolean)) => {
    setTextUnderline(prev => {
      const next = typeof v === 'function' ? v(prev) : v;
      queueOrApplyStyle({ underline: next });
      return next;
    });
  }, [queueOrApplyStyle]);
  const handleTextFontSize = useCallback((v: number | ((prev: number) => number)) => {
    if (blurTimeoutRef.current) {
      clearTimeout(blurTimeoutRef.current);
      blurTimeoutRef.current = null;
    }
    setTextFontSize(prev => {
      const next = typeof v === 'function' ? v(prev) : v;
      queueOrApplyStyle({ fontSize: next });
      return next;
    });
    // Keep the edit box focused after clicking a size preset in the sidebar
    requestAnimationFrame(() => {
      hiddenInputRef.current?.focus({ preventScroll: true });
    });
  }, [queueOrApplyStyle]);
  const handleTextFontFamily = useCallback((v: string) => {
    if (blurTimeoutRef.current) {
      clearTimeout(blurTimeoutRef.current);
      blurTimeoutRef.current = null;
    }
    setTextFontFamily(v);
    queueOrApplyStyle({ fontFamily: v });
    requestAnimationFrame(() => {
      hiddenInputRef.current?.focus({ preventScroll: true });
    });
  }, [queueOrApplyStyle]);
  const handleTextColor = useCallback((v: string) => {
    if (!/^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(v.trim())) return;
    setTextColor(v);
    if (activeFloatingTextId) {
      setFloatingTexts(prev => prev.map(p => p.id === activeFloatingTextId ? { ...p, color: v } : p));
    }
    queueOrApplyStyle({ color: v });
  }, [activeFloatingTextId, queueOrApplyStyle]);
  const handleTextAlign = useCallback((v: 'left' | 'center' | 'right') => {
    setTextAlign(v);
    queueOrApplyStyle({ align: v });
  }, [queueOrApplyStyle]);

  // Warn before leaving with unsaved edits
  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      if (!isDirtyRef.current && !editingLineRef.current && !floatingTextEditStartRef.current &&
          !isDrawing && currentDrawPath.current.length === 0 && !linkPopoverMode &&
          !hasPendingFormFieldDraft(selectedFormField, formFieldDraft) && !isSaving &&
          !securityBusyRef.current && !cryptoSignBusy && !searchBusy && !annotationCommitPendingRef.current &&
          documentOwnerRef.current.getPendingCount() === 0) return;
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [cryptoSignBusy, formFieldDraft, isDrawing, isSaving, linkPopoverMode, searchBusy, selectedFormField]);

  // Debounced IndexedDB session autosave (PDF bytes + overlay JSON)
  useEffect(() => {
    if (!isDirty || !doc || !engineRef.current || isLoading || isSaving || securityBusy || searchBusy || cryptoSignBusy) return;
    const engine = engineRef.current;
    const lease = documentOwnerRef.current.lease(doc);
    const generation = captureEditorSessionGeneration();
    const editRevision = editRevisionRef.current;
    let cancelled = false;
    const isCurrent = () => !cancelled && !securityBusyRef.current &&
      editRevisionRef.current === editRevision && lease.isCurrent();
    const timer = setTimeout(() => {
      void (async () => {
        try {
          await annotationCommitPendingRef.current;
          await documentOwnerRef.current.whenIdle();
          if (!isCurrent()) return;
          let bytes: Uint8Array;
          let signedSnapshot: string | undefined;
          try {
            bytes = await engine.saveDocument(doc, 'quick');
          } catch (error) {
            if (!(error instanceof Error) || error.name !== 'SignedDocumentEditError') throw error;
            // This snapshot is recovery data, never an exported signed PDF.
            signedSnapshot = await engine.createSignedRecoverySnapshot(doc);
            bytes = doc.rawBytes.slice();
          }
          if (!isCurrent()) return;
          const copy = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
          const overlays: EditorSessionOverlay = {
            drawnPathsJson: JSON.stringify(drawnPathsRef.current),
            floatingTextsJson: JSON.stringify(floatingTextsRef.current),
            floatingImagesJson: JSON.stringify(floatingImagesRef.current),
            signaturesJson: JSON.stringify(signaturesRef.current),
            currentPage,
            signedSnapshot,
            formDraft: formDraftControllerRef.current.get() ?? undefined,
          };
          const protectedDocument = engine.securityEngine.isEncrypted(doc) || !!doc.decryptedFromEncrypted;
          let protectedOverlays: EditorSessionRecord['protectedOverlays'];
          if (protectedDocument) {
            const password = recoveryPasswordRef.current;
            if (!password) throw new Error('Protected recovery requires a non-empty password. Earlier local recovery may be unprotected; download your changes before leaving.');
            const savedDocument = await engine.parsePDF(new Uint8Array(copy));
            if (!engine.securityEngine.isEncrypted(savedDocument)) throw new Error('Protected recovery could not be encrypted. Download your changes before leaving.');
            protectedOverlays = await encryptRecoveryOverlay(overlays, password, copy);
          }
          if (!isCurrent()) return;
          await saveEditorSession({
            bytes: copy,
            fileName,
            updatedAt: Date.now(),
            overlays: protectedDocument
              ? { drawnPathsJson: '[]', floatingTextsJson: '[]', floatingImagesJson: '[]', signaturesJson: '[]', currentPage: 0 }
              : overlays,
            protectedOverlays,
          }, isCurrent, generation);
        } catch (e) {
          if (!isCurrent()) return;
          console.warn('[Editor] Session autosave failed:', e);
          setError(`Session autosave failed: ${e instanceof Error ? e.message : String(e)}`);
        }
      })();
    }, 2500);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [isDirty, doc, fileName, currentPage, isLoading, isSaving, securityBusy, searchBusy, cryptoSignBusy, drawnPaths, floatingTexts, floatingImages, signatures, renderKey, formFieldDraft]);

  // Caret blinking
  const caretVisibleRef = useRef(true);
  const caretTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // ── Load engine and PDF ──
  useEffect(() => {
    let cancelled = false;

    async function finishLoad(
      parsed: PDFDocumentData,
      engine: NonNullable<typeof engineRef.current>,
      opts?: {
        pageIndex?: number;
        overlays?: {
          drawnPaths: DrawnPath[];
          floatingTexts: FloatingText[];
          floatingImages: FloatingImage[];
          signatures: VisualSignature[];
        };
        dirty?: boolean;
        originalUpload?: boolean;
        formDraft?: RecoveredFormDraft;
      },
    ) {
      const recoveredForm = opts?.formDraft
        ? resolveRecoveredFormDraft(opts.formDraft, parsed.pages, index => engine.detectFormFieldsOnPage(parsed, index))
        : null;
      const pageIndex = recoveredForm?.pageIndex ?? Math.max(0, Math.min(opts?.pageIndex ?? 0, parsed.pages.length - 1));
      const savedOverlays = opts?.overlays ?? {
        drawnPaths: [],
        floatingTexts: [],
        floatingImages: [],
        signatures: [],
      };
      const page = parsed.pages[pageIndex];
      const overlays = { ...savedOverlays, ...restoreOverlayPages(savedOverlays, parsed.pages.length === 1 ? page.ref.toKey() : null) };
      const initial = await normalizePageContent(parsed, page, engine);
      const initialBytes = initial.bytes;
      if (initial.warning) setError(initial.warning);
      const initialHistory = captureHistoryEntry(
        parsed,
        pageIndex,
        initialBytes,
        overlays,
        'initial',
      );
      if (cancelled) return;
      // Publish only after the recovered graph has initialized successfully.
      // Recovered sessions and decrypted documents are not pristine uploads.
      uploadBytesRef.current = opts?.originalUpload === true && !opts.dirty
        ? parsed.rawBytes : null;
      hasEditedRef.current = uploadBytesRef.current === null;
      sessionEditorRef.current = new SessionDocumentEditor();
      historyRef.current.seed(initialHistory);
      setDoc(parsed);
      setTotalPages(parsed.pages.length);
      changePage(pageIndex);
      if (recoveredForm && opts?.formDraft) {
        formDraftControllerRef.current.set(opts.formDraft);
        setFormFields(engine.detectFormFieldsOnPage(parsed, recoveredForm.pageIndex));
        setSelectedFormField(recoveredForm.field);
        setFormFieldDraft(opts.formDraft.value);
        setActiveTool('select');
      }
      setDrawnPaths(overlays.drawnPaths);
      drawnPathsRef.current = overlays.drawnPaths;
      setFloatingTexts(overlays.floatingTexts);
      floatingTextsRef.current = overlays.floatingTexts;
      setFloatingImages(overlays.floatingImages);
      floatingImagesRef.current = overlays.floatingImages;
      setSignatures(overlays.signatures);
      signaturesRef.current = overlays.signatures;
      syncTxState();
      setIsDirty(!!opts?.dirty);
      setNeedsPassword(false);
      setPasswordError(null);
      pendingEncryptedDocRef.current = null;
      pendingRecoveryRef.current = null;
      setIsLoading(false);
    }

    async function init() {
      try {
        const stored = await loadPdfFromStorage();
        if (!stored) { router.push('/'); return; }
        if (cancelled) return;

        const engine = await import('@/engine/browser-core');
        engineRef.current = engine;
        setEngineModule(engine);

        // Prefer dirty session recovery when available
        const session = await loadEditorSession();
        if (session && session.bytes?.byteLength) {
          pendingRecoveryRef.current = session;
          try {
            setFileName(session.fileName || stored.fileName);
            const parsed = await engine.parsePDF(new Uint8Array(session.bytes));
            if (cancelled) return;
            if (!engine.securityEngine.isEncrypted(parsed)) {
              if (session.protectedOverlays) throw new Error('Protected recovery is missing its encrypted PDF.');
              const original = await engine.parsePDF(new Uint8Array(stored.bytes));
              if (engine.securityEngine.isEncrypted(original)) {
                throw new Error('Unprotected recovery cannot be opened as a protected PDF.');
              }
              if (cancelled) return;
              const saved = parseRecoveryOverlay(session.overlays);
              const restored = saved.signedSnapshot
                ? await engine.restoreSignedRecoverySnapshot(parsed, saved.signedSnapshot)
                : parsed;
              if (cancelled) return;
              if (saved.currentPage >= restored.pages.length) throw new Error('Recovery page is out of range.');
              await finishLoad(restored, engine, {
                pageIndex: saved.currentPage,
                formDraft: saved.formDraft,
                overlays: {
                  drawnPaths: saved.drawnPaths as DrawnPath[],
                  floatingTexts: saved.floatingTexts as FloatingText[],
                  floatingImages: saved.floatingImages as FloatingImage[],
                  signatures: saved.signatures as VisualSignature[],
                },
                dirty: true,
              });
              return;
            }
            pendingEncryptedDocRef.current = parsed;
            // Protected overlays must be unlocked before decrypting the PDF;
            // a failed recovery password must leave both records intact.
            if (!session.protectedOverlays) {
              const saved = parseRecoveryOverlay(session.overlays);
              if (saved.signedSnapshot) throw new Error('Protected signed recovery is not encrypted.');
              if (saved.currentPage >= parsed.pages.length) throw new Error('Recovery page is out of range.');
              let opened: Awaited<ReturnType<typeof engine.securityEngine.open>> | null = null;
              try {
                opened = await engine.securityEngine.open(parsed, '');
              } catch {
                // Prompt for the password; preserve the recovered session.
              }
              if (opened) {
                if (cancelled) return;
                recoveryPasswordRef.current = '';
                await finishLoad(opened.doc, engine, {
                  pageIndex: saved.currentPage,
                  overlays: {
                    drawnPaths: saved.drawnPaths as DrawnPath[],
                    floatingTexts: saved.floatingTexts as FloatingText[],
                    floatingImages: saved.floatingImages as FloatingImage[],
                    signatures: saved.signatures as VisualSignature[],
                  },
                  dirty: true,
                });
                setError('This older recovery contains unprotected local data. Download your changes, then discard the local copy. Automatic protected recovery requires a non-empty password.');
                return;
              }
            }
            setNeedsPassword(true);
            setIsLoading(false);
            return;
          } catch (sessErr) {
            console.warn('[Editor] Session restore failed:', sessErr);
            setError('Recovery could not be opened. The saved recovery data has been preserved.');
            setIsLoading(false);
            return;
          }
        }

        setFileName(stored.fileName);
        const pdfBytes = new Uint8Array(stored.bytes);
        const parsed = await engine.parsePDF(pdfBytes);
        if (cancelled) return;

        if (engine.securityEngine.isEncrypted(parsed)) {
          // Try empty password first (common for owner-only protection)
          try {
            const opened = await engine.securityEngine.open(parsed, '');
            if (cancelled) return;
            recoveryPasswordRef.current = '';
            await finishLoad(opened.doc, engine);
            return;
          } catch {
            pendingEncryptedDocRef.current = parsed;
            setNeedsPassword(true);
            setIsLoading(false);
            return;
          }
        }

        await finishLoad(parsed, engine, { originalUpload: true });
      } catch (e) {
        if (cancelled) return;
        console.error('[Editor] Init failed:', e);
        setError(`Failed to parse PDF: ${e instanceof Error ? e.message : String(e)}`);
        setIsLoading(false);
      }
    }

    init();
    return () => { cancelled = true; };
  }, [router, setDoc, syncTxState]);

  const handlePasswordSubmit = useCallback(async (password: string) => {
    const engine = engineRef.current;
    const pending = pendingEncryptedDocRef.current;
    if (!engine || !pending) return;

    setIsVerifyingPassword(true);
    setPasswordError(null);
    const session = pendingRecoveryRef.current;
    try {
      const savedOverlays = session?.protectedOverlays
        ? await decryptRecoveryOverlay(session.protectedOverlays, password, session.bytes)
        : session?.overlays;
      const saved = savedOverlays ? parseRecoveryOverlay(savedOverlays) : null;
      if (saved?.signedSnapshot && !session?.protectedOverlays) {
        throw new Error('Protected signed recovery is not encrypted.');
      }
      const requestedPageIndex = saved?.currentPage ?? 0;
      const opened = await engine.securityEngine.open(pending, password);
      const restored = saved?.signedSnapshot
        ? await engine.restoreSignedRecoverySnapshot(opened.doc, saved.signedSnapshot)
        : opened.doc;
      if (requestedPageIndex >= restored.pages.length) throw new Error('Recovery page is out of range.');
      const recoveredForm = saved?.formDraft
        ? resolveRecoveredFormDraft(saved.formDraft, restored.pages, index => engine.detectFormFieldsOnPage(restored, index))
        : null;
      const pageIndex = recoveredForm?.pageIndex ?? requestedPageIndex;
      const savedPageOverlays = {
        drawnPaths: (saved?.drawnPaths ?? []) as DrawnPath[],
        floatingTexts: (saved?.floatingTexts ?? []) as FloatingText[],
        floatingImages: (saved?.floatingImages ?? []) as FloatingImage[],
        signatures: (saved?.signatures ?? []) as VisualSignature[],
      };
      const page = restored.pages[pageIndex];
      const overlays = { ...savedPageOverlays, ...restoreOverlayPages(savedPageOverlays, restored.pages.length === 1 ? page.ref.toKey() : null) };
      const initial = await normalizePageContent(restored, page, engine);
      const initialBytes = initial.bytes;
      if (initial.warning) setError(initial.warning);
      const initialHistory = captureHistoryEntry(
        restored,
        pageIndex,
        initialBytes,
        overlays,
        'initial',
      );
      recoveryPasswordRef.current = password;
      sessionEditorRef.current = new SessionDocumentEditor();
      historyRef.current.seed(initialHistory);
      setDoc(restored);
      setTotalPages(restored.pages.length);
      changePage(pageIndex);
      if (recoveredForm && saved?.formDraft) {
        formDraftControllerRef.current.set(saved.formDraft);
        setFormFields(engine.detectFormFieldsOnPage(restored, recoveredForm.pageIndex));
        setSelectedFormField(recoveredForm.field);
        setFormFieldDraft(saved.formDraft.value);
        setActiveTool('select');
      }
      setDrawnPaths(overlays.drawnPaths);
      setFloatingTexts(overlays.floatingTexts);
      setFloatingImages(overlays.floatingImages);
      setSignatures(overlays.signatures);
      syncTxState();
      setIsDirty(!!session);
      if (session && !session.protectedOverlays) {
        setError('This older recovery contains unprotected local data. Keep the editor open until protected recovery is saved, or download your changes and discard the local copy.');
      }
      setNeedsPassword(false);
      pendingEncryptedDocRef.current = null;
      pendingRecoveryRef.current = null;
    } catch (e) {
      setPasswordError(session?.protectedOverlays
        ? 'Could not unlock recovery. Use the same password used when it was saved; your recovery is preserved.'
        : e instanceof Error ? e.message : 'Incorrect password');
    } finally {
      setIsVerifyingPassword(false);
    }
  }, [setDoc, syncTxState]);

  // ── Generate thumbnails ──
  useEffect(() => {
    if (!doc || !engineRef.current) return;
    let cancelled = false;
    const generation = thumbnailCoordinator.current.beginFull();
    const pageKeys = doc.pages.map(page => page.ref.toKey());

    async function refreshThumbnails() {
      setIsGeneratingThumbnails(true);
      const engine = engineRef.current!;
      try {
        const thumbs = await generateThumbnails(doc!.pages.length, async i => {
          const res = await engine.renderPage(doc!, i, { scale: 0.15, renderText: true, renderPaths: true, renderImages: true, renderWidgets: true });
          return res.canvas.toDataURL('image/jpeg', 0.6);
        }, () => cancelled);
        if (thumbs && !cancelled && thumbnailCoordinator.current.finishFull(generation, doc!, pageKeys, thumbs, doc!.pages.map(page => page.ref.toKey()))) setThumbnails(thumbs);
      } catch (e) {
        console.error('[Editor] Thumbnail generation failed:', e);
      } finally {
        if (!cancelled) setIsGeneratingThumbnails(false);
      }
    }

    refreshThumbnails();
    return () => { cancelled = true; thumbnailCoordinator.current.invalidate(); };
  }, [doc, thumbnailKey]);

  // Reset page-local selection before rendering a different document or page.
  const [previousDocPage, setPreviousDocPage] = useState({ doc, currentPage });
  if (previousDocPage.doc !== doc || previousDocPage.currentPage !== currentPage) {
    setPreviousDocPage({ doc, currentPage });
    setEditingLineState(null);
    setSelectedLine(null);
    setEditText('');
    setSelectedDisplayItem(null);
    setDisplayItems([]);
  }
  useLayoutEffect(() => {
    editingLineRef.current = null;
    spatialIndexRef.current = null;
  }, [doc, currentPage]);

  // Adjust sidebar controls when the selected line or its font data changes.
  const [previousTextSelection, setPreviousTextSelection] = useState({ selectedLine, renderResult });
  if (previousTextSelection.selectedLine !== selectedLine || previousTextSelection.renderResult !== renderResult) {
    setPreviousTextSelection({ selectedLine, renderResult });
    if (selectedLine && selectedLine.runs.length > 0) {
      const run = selectedLine.runs[0];
      // Keep fractional size so overlay matches canvas (rounding caused a visible jump)
      setTextFontSize(visualFontSize(run));
      const fontData = renderResult?.fonts.get(run.fontName);
      setTextFontFamily(getDisplayFontFamily(run.fontName, fontData));
      const flags = resolveRunStyleFlags(run.fontName, fontData);
      setTextBold(flags.bold);
      setTextItalic(flags.italic);
      setTextUnderline(!!run.isUnderline);
      if (run.fillColor) {
        const [r, g, b] = run.fillColor;
        const hex = '#' + [r, g, b].map(c => Math.round(c * 255).toString(16).padStart(2, '0')).join('');
        setTextColor(hex);
      }
    }
  }

  // ── Render current page ──
  useEffect(() => {
    if (!doc || !engineRef.current) return;
    let cancelled = false;

    async function render() {
      setIsRendering(true);
      setPageRenderError(null);
      try {
        const engine = engineRef.current!;
        const editablePage = doc!.pages[currentPage];
        const normalized = await normalizePageContent(doc!, editablePage, engine);
        if (normalized.warning && !cancelled) setError(normalized.warning);
        const hidden = new Map(erasedAnnotationsRef.current);
        for (const ref of findVisualSignatureRefs(doc!, new Set(signaturesRef.current.map(sig => sig.id))).values()) {
          hidden.set(ref.toKey(), ref);
        }
        const renderDoc = previewMarkupRemoval(doc!, currentPage, hidden);
        const dpr = window.devicePixelRatio || 1;
        const result = await engine.renderPage(renderDoc, currentPage, { scale, devicePixelRatio: dpr });
        if (cancelled) return;
        setRenderResult(result);

        // Extract display items (images, significant paths) for bounding box overlays
        try {
          const pageData = doc!.pages[currentPage];
          const cBytes = engine.getPageContentBytes(pageData, doc!.objects);
          const interpreted = engine.interpretPage(cBytes, pageData, doc!.objects, new engine.OptionalContentVisibility(doc!.catalog, doc!.objects));
          const pageBounds = {
            x: pageData.mediaBox.x,
            y: pageData.mediaBox.y,
            width: pageData.mediaBox.width,
            height: pageData.mediaBox.height,
          };
          // Skip full-page background fills (0 0 612 792 re f) — they steal every click
          const visItems = interpreted.displayList.filter(
            (di: DisplayItem) => isSelectableDisplayItem(di, pageBounds),
          );
          // Keep thin strokes (form-label underlines) for edit-overlay decoration
          const thinStrokes = interpreted.displayList.filter((di: DisplayItem) => {
            if (di.type !== 'path') return false;
            const p = di as PathItem;
            if (p.paintType !== 'stroke' && p.paintType !== 'both') return false;
            // Horizontal underline: short height, meaningful width
            return (p.height || 0) <= 8 && (p.width || 0) >= 10;
          }) as PathItem[];
          if (!cancelled) {
            setDisplayItems(visItems as (ImageItem | PathItem)[]);
            // Share the canonical display item with the frame and Options.
            setSelectedDisplayItem(current => current?.type === 'image'
              ? findImagePlacement(visItems, current) ?? current : current);
          }
          if (!cancelled) setStrokePaths(thinStrokes);
          if (!cancelled) {
            try {
              const lines = result.documentFlow?.lines ?? result.textLines ?? [];
              const allPaths = interpreted.displayList.filter(
                (di: DisplayItem) => di.type === 'path',
              ) as PathItem[];
              const tables = engine.detectTablesOnPage(lines, [...thinStrokes, ...allPaths]);
              setDetectedTables(tables);
            } catch (tblErr) {
              console.warn('[Editor] Table detect failed:', tblErr);
              setDetectedTables([]);
            }
          }
          if (!cancelled && doc) {
            try {
              setPageLinks(engine.listPageLinks(doc!, currentPage));
            } catch {
              setPageLinks([]);
            }
          }
          if (!cancelled) {
            spatialIndexRef.current = buildDisplayListIndex(
              visItems as DisplayItem[],
              pageBounds,
            );
          }

          // Bloom ingest — skip re-ingest while mid-edit with dirty in-memory page
          if (!cancelled && !(editingBlockIdRef.current && bloomPageRef.current?.dirty)) {
            const flow = result.documentFlow ?? engine.buildDocumentFlow(interpreted.textRuns);
            const ingested = engine.ingestPage(interpreted.textRuns, {
              pageIndex: currentPage,
              width: pageData.mediaBox.width,
              height: pageData.mediaBox.height,
              flow,
              displayList: interpreted.displayList,
            });
            setBloomPageBoth(ingested);
          }
        } catch (dispErr) {
          console.warn('[Editor] Display items extraction failed:', dispErr);
          if (!cancelled) setDisplayItems([]);
          if (!cancelled) setStrokePaths([]);
          if (!cancelled) spatialIndexRef.current = null;
        }

        try {
          const fields = engine.detectFormFieldsOnPage(doc!, currentPage);
          if (!cancelled) {
            setFormFields(fields);
            if (selectedFormField) {
              const still = fields.find(f => f.ref.toKey() === selectedFormField.ref.toKey());
              setSelectedFormField(still ?? null);
            }
          }
        } catch {
          if (!cancelled) setFormFields([]);
        }

        try {
          const sigFields = detectSignatureFieldsOnPage(doc!, currentPage);
          if (!cancelled) {
            setPdfSignatureFields(sigFields);
            if (selectedPdfSigFieldId) {
              const still = sigFields.find((f) => f.id === selectedPdfSigFieldId);
              if (!still) setSelectedPdfSigFieldId(null);
            }
          }
        } catch {
          if (!cancelled) setPdfSignatureFields([]);
        }

        // Re-sync editing line only when not in overlay preview mode
        if (editingLineRef.current && !editAnchorLineRef.current) {
          const oldLine = editingLineRef.current;
          const newLine = result.textLines.find((l: TextLine) =>
            l.id === oldLine.id ||
            (Math.abs(l.baseline - oldLine.baseline) < 5 && Math.abs(l.x - oldLine.x) < 30)
          );
          if (newLine) {
            setEditingLine(newLine);
            setSelectedLine(newLine);
          } else {
            setEditingLine(null);
            setSelectedLine(null);
          }
        }

        // Mount canvas
        if (canvasContainerRef.current) {
          const wrapper = canvasContainerRef.current;
          // Remove old PDF canvas
          const oldCanvas = wrapper.querySelector('canvas.pdf-canvas');
          if (oldCanvas) oldCanvas.remove();

          result.canvas.className = 'pdf-canvas';
          result.canvas.style.display = 'block';
          result.canvas.style.position = 'relative';
          result.canvas.style.zIndex = '1';
          pdfCanvasRef.current = result.canvas;
          wrapper.prepend(result.canvas);

          // Size the overlay canvas to match
          const overlay = overlayRef.current;
          if (overlay) {
            const dpr = window.devicePixelRatio || 1;
            overlay.width = result.canvas.width;
            overlay.height = result.canvas.height;
            overlay.style.width = result.canvas.style.width;
            overlay.style.height = result.canvas.style.height;
          }
          setRenderedPage({ doc: doc!, page: currentPage, scale, dpr, revision: renderKey, retry: renderRetry });
        }
      } catch (e) {
        if (cancelled) return;
        console.error('[Editor] Render failed:', e);
        const message = `Render failed: ${e instanceof Error ? e.message : String(e)}`;
        setError(message);
        setPageRenderError(message);
        setRenderedPage(null);
        setRenderResult(null);
        setDisplayItems([]);
        setStrokePaths([]);
        setFormFields([]);
        setPdfSignatureFields([]);
        setDetectedTables([]);
        setPageLinks([]);
        spatialIndexRef.current = null;
        canvasContainerRef.current?.querySelectorAll('canvas.pdf-canvas').forEach(canvas => canvas.remove());
        pdfCanvasRef.current = null;
        if (overlayRef.current) {
          overlayRef.current.width = 0;
          overlayRef.current.height = 0;
        }
      }
      setIsRendering(false);
    }

    render();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc, currentPage, scale, renderKey, renderRetry]);

  // ── Draw overlay (caret, freehand paths) — NO boxes or highlights ──
  const drawOverlay = useCallback(() => {
    const overlay = overlayRef.current;
    if (!overlay || !renderResult) return;
    const ctx = overlay.getContext('2d');
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    ctx.clearRect(0, 0, overlay.width, overlay.height);

    const page = doc?.pages[currentPage];
    if (!page) return;
    const { mediaBox } = page;

    // ── Edit: white-out only the active line (HTML input shows typed text) ──
    // Match EditableLineBox placement: baseline-aligned. Keep descent small so
    // native path underlines under form labels stay visible on the canvas.
    if (editingLine && editAnchorLineRef.current) {
      const anchor = editAnchorLineRef.current;
      const bounds = getLineBounds(anchor);
      let maxFs = anchor.runs[0] ? visualFontSize(anchor.runs[0]) : anchor.fontSize;
      for (const run of anchor.runs) maxFs = Math.max(maxFs, visualFontSize(run));
      for (const ov of editStyleOverrides) {
        if (ov.fontSize != null) maxFs = Math.max(maxFs, ov.fontSize);
      }
      if (typingStyleRef.current.fontSize != null) {
        maxFs = Math.max(maxFs, typingStyleRef.current.fontSize);
      }
      if (editSel.end <= editSel.start && textFontSize > 0) {
        maxFs = Math.max(maxFs, textFontSize);
      }
      const fontSizeCss = maxFs * scale;
      const baseline = anchor.baseline;
      const ascent = fontSizeCss * 0.85;
      // Cover path-drawn underlines too — leaving them visible while the HTML
      // overlay clips CSS underlines made new glyphs look non-underlined.
      const hasUnderline = textUnderline || anchor.runs.some(r =>
        !!r.isUnderline || runHasPathUnderline(r, strokePaths),
      );
      const descent = fontSizeCss * (hasUnderline ? 0.45 : 0.25);

      ctx.save();
      ctx.scale(dpr, dpr);

      const leftPt = pdfToCanvas(
        bounds.x,
        baseline,
        scale, renderResult.pageHeight, mediaBox.x, mediaBox.y,
      );
      // Cover the active line plus same-baseline peers that the growing text
      // would collide with (split title|tags cells). Keep the char-width estimate
      // conservative — inflated factors painted huge white bands over the page.
      const growWPdf = Math.max(
        bounds.width,
        editText.length > 0 ? editText.length * maxFs * 0.55 : 0,
      );
      let coverWPdf = growWPdf;
      const peerLines = renderResult.textLines ?? [];
      for (let pi = 0; pi < peerLines.length; pi++) {
        const pl = peerLines[pi];
        if (pl.id === anchor.id) continue;
        if (Math.abs(pl.baseline - baseline) > Math.max(2, maxFs * 0.35)) continue;
        const peerRight = pl.x + pl.width;
        if (pl.x < bounds.x + growWPdf + maxFs && peerRight > bounds.x) {
          coverWPdf = Math.max(coverWPdf, peerRight - bounds.x);
        }
      }
      const growW = coverWPdf * scale;
      const rx = leftPt.cssX + editOffsetCss.x;
      const ry = leftPt.cssY - ascent + editOffsetCss.y;
      const rw = editManualSize.w ?? growW;
      const rh = editManualSize.h ?? (ascent + descent);

      ctx.fillStyle = '#ffffff';
      ctx.fillRect(rx - 1, ry - 1, rw + 2, rh + 2);

      // Path underlines only cover original glyph spans — extend a stroke under
      // underlined runs as the line grows so mid-line inserts stay underlined.
      if (hasUnderline) {
        let ulLeft = Infinity;
        let ulRight = -Infinity;
        for (const run of anchor.runs) {
          if (!(run.isUnderline || runHasPathUnderline(run, strokePaths))) continue;
          ulLeft = Math.min(ulLeft, run.x);
          ulRight = Math.max(ulRight, run.x + Math.max(run.width, maxFs * 0.5));
        }
        if (Number.isFinite(ulLeft) && ulRight > ulLeft) {
          const origLen = (initialRunTextRef.current || anchor.text || '').length;
          const grown = Math.max(0, (editText || '').length - origLen);
          const ulWPdf = (ulRight - ulLeft) + grown * maxFs * 0.55;
          const ulOrigin = pdfToCanvas(
            ulLeft,
            baseline,
            scale, renderResult.pageHeight, mediaBox.x, mediaBox.y,
          );
          const ulX = ulOrigin.cssX + editOffsetCss.x;
          const ulY = ulOrigin.cssY + editOffsetCss.y + fontSizeCss * 0.12;
          const canvasUlW = ulWPdf * scale;
          ctx.strokeStyle = textColor.startsWith('#') ? textColor : '#000000';
          ctx.lineWidth = Math.max(1, fontSizeCss * 0.06);
          ctx.beginPath();
          ctx.moveTo(ulX, ulY);
          ctx.lineTo(ulX + canvasUlW, ulY);
          ctx.stroke();
        }
      }

      ctx.restore();
    }

    // ── Display item bounding boxes — hide while typing so blue handles don't appear on words ──
    if ((activeTool === 'select' || activeTool === 'text') && displayItems.length > 0 && !editingLine) {
      ctx.save();
      ctx.scale(dpr, dpr);

      for (const item of displayItems) {
        const isImage = item.type === 'image';
        const isSelected = selectedDisplayItem === item;

        const topLeft = pdfToCanvas(
          item.x, item.y + item.height,
          scale, renderResult.pageHeight, mediaBox.x, mediaBox.y,
        );
        const bottomRight = pdfToCanvas(
          item.x + item.width, item.y,
          scale, renderResult.pageHeight, mediaBox.x, mediaBox.y,
        );

        const boxX = topLeft.cssX;
        const boxY = topLeft.cssY;
        const boxW = bottomRight.cssX - topLeft.cssX;
        const boxH = bottomRight.cssY - topLeft.cssY;

        if (boxW < 3 || boxH < 3) continue;

        if (isSelected) {
          ctx.strokeStyle = isImage ? '#3b82f6' : '#22c55e';
          ctx.lineWidth = 2;
          ctx.setLineDash([]);
          ctx.fillStyle = isImage ? 'rgba(59,130,246,0.06)' : 'rgba(34,197,94,0.06)';
          ctx.fillRect(boxX, boxY, boxW, boxH);
          ctx.strokeRect(boxX, boxY, boxW, boxH);

          const hs = 7;
          ctx.fillStyle = isImage ? '#3b82f6' : '#22c55e';
          const corners: [number, number][] = [
            [boxX, boxY], [boxX + boxW, boxY],
            [boxX, boxY + boxH], [boxX + boxW, boxY + boxH],
          ];
          for (const [cx, cy] of corners) {
            ctx.fillRect(cx - hs / 2, cy - hs / 2, hs, hs);
          }

          ctx.font = '600 11px Inter, system-ui, sans-serif';
          const label = isImage ? 'Image' : 'Drawing / Signature';
          const labelW = ctx.measureText(label).width;
          const badgePad = 6;
          const badgeH = 20;
          const badgeY2 = boxY - badgeH - 4;
          ctx.fillStyle = isImage ? '#3b82f6' : '#22c55e';
          ctx.beginPath();
          ctx.roundRect(boxX, badgeY2, labelW + badgePad * 2, badgeH, 4);
          ctx.fill();
          ctx.fillStyle = '#ffffff';
          ctx.fillText(label, boxX + badgePad, badgeY2 + 14);
        } else {
          ctx.strokeStyle = isImage ? 'rgba(59,130,246,0.4)' : 'rgba(34,197,94,0.3)';
          ctx.lineWidth = 1.5;
          ctx.setLineDash([5, 4]);
          ctx.strokeRect(boxX, boxY, boxW, boxH);
          ctx.setLineDash([]);
        }
      }

      ctx.restore();
    }

    // ── Table cell overlays (auto-detected grids) disabled for cleaner UI ──

    // ── AcroForm field overlays (Select + Text tools) ──
    if ((activeTool === 'select' || activeTool === 'text') && formFields.length > 0 && renderResult && !editingLine) {
      ctx.save();
      ctx.scale(dpr, dpr);
      for (const field of formFields) {
        const r = field.rect;
        if (!r) continue;
        const topLeft = pdfToCanvas(
          r.x, r.y + r.height,
          scale, renderResult.pageHeight, mediaBox.x, mediaBox.y,
        );
        const bottomRight = pdfToCanvas(
          r.x + r.width, r.y,
          scale, renderResult.pageHeight, mediaBox.x, mediaBox.y,
        );
        const boxX = topLeft.cssX;
        const boxY = topLeft.cssY;
        const boxW = bottomRight.cssX - topLeft.cssX;
        const boxH = bottomRight.cssY - topLeft.cssY;
        const selected = selectedFormField?.ref.toKey() === field.ref.toKey();
        ctx.strokeStyle = selected ? '#f59e0b' : 'rgba(245,158,11,0.45)';
        ctx.lineWidth = selected ? 2 : 1;
        ctx.setLineDash(selected ? [] : [4, 3]);
        ctx.fillStyle = selected ? 'rgba(245,158,11,0.12)' : 'rgba(245,158,11,0.04)';
        ctx.fillRect(boxX, boxY, boxW, boxH);
        ctx.strokeRect(boxX, boxY, boxW, boxH);
        ctx.setLineDash([]);
        if (selected || boxH > 14) {
          ctx.font = '600 10px Inter, system-ui, sans-serif';
          ctx.fillStyle = '#f59e0b';
          const label = field.fieldName || field.fieldType;
          ctx.fillText(label, boxX + 3, boxY + 11);
        }
      }
      ctx.restore();
    }

    // ── Link annotation overlays (only after "Scan for links") ──
    if (
      linksHighlighted
      && (activeTool === 'text' || activeTool === 'select' || activeTool === 'addtext')
      && pageLinks.length > 0
      && !editingLine
    ) {
      ctx.save();
      ctx.scale(dpr, dpr);
      for (const link of pageLinks) {
        const topLeft = pdfToCanvas(
          link.rect.x, link.rect.y + link.rect.height,
          scale, renderResult.pageHeight, mediaBox.x, mediaBox.y,
        );
        const bottomRight = pdfToCanvas(
          link.rect.x + link.rect.width, link.rect.y,
          scale, renderResult.pageHeight, mediaBox.x, mediaBox.y,
        );
        const bx = Math.min(topLeft.cssX, bottomRight.cssX);
        const by = Math.min(topLeft.cssY, bottomRight.cssY);
        const bw = Math.abs(bottomRight.cssX - topLeft.cssX);
        const bh = Math.abs(bottomRight.cssY - topLeft.cssY);
        const active = selectedLink?.ref.toKey() === link.ref.toKey();
        ctx.strokeStyle = active ? '#52525b' : 'rgba(37, 99, 235, 0.85)';
        ctx.lineWidth = active ? 2 : 1;
        ctx.setLineDash(active ? [] : [4, 3]);
        ctx.fillStyle = active ? 'rgba(63, 63, 70, 0.28)' : 'rgba(37, 99, 235, 0.06)';
        // Rounded highlight for the active/hovered link
        const r = Math.min(6, bw / 2, bh / 2);
        ctx.beginPath();
        ctx.moveTo(bx + r, by);
        ctx.arcTo(bx + bw, by, bx + bw, by + bh, r);
        ctx.arcTo(bx + bw, by + bh, bx, by + bh, r);
        ctx.arcTo(bx, by + bh, bx, by, r);
        ctx.arcTo(bx, by, bx + bw, by, r);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
        ctx.setLineDash([]);
      }
      ctx.restore();
    }

    // ── Drawing paths / shapes ──
    if (drawnPaths.length > 0) {
      ctx.save();
      ctx.scale(dpr, dpr);
      ctx.lineJoin = 'round';
      for (const path of drawnPaths) {
        if (path.pageKey !== page.ref.toKey()) continue;
        ctx.save();
        const pathScale = scale / (path.captureScale ?? scale);
        ctx.scale(pathScale, pathScale);
        const kind = path.kind ?? 'freehand';
        if (kind !== 'freehand' && path.start && path.end) {
          ctx.globalCompositeOperation = 'source-over';
          ctx.globalAlpha = 1;
          ctx.strokeStyle = path.color;
          ctx.lineWidth = path.size;
          ctx.lineCap = 'round';
          const { start, end } = path;
          if (kind === 'line' || kind === 'arrow') {
            ctx.beginPath();
            ctx.moveTo(start.x, start.y);
            ctx.lineTo(end.x, end.y);
            ctx.stroke();
            if (kind === 'arrow') {
              const angle = Math.atan2(end.y - start.y, end.x - start.x);
              const head = Math.max(path.size * 4, 10);
              ctx.beginPath();
              ctx.moveTo(end.x, end.y);
              ctx.lineTo(end.x - head * Math.cos(angle - 0.4), end.y - head * Math.sin(angle - 0.4));
              ctx.moveTo(end.x, end.y);
              ctx.lineTo(end.x - head * Math.cos(angle + 0.4), end.y - head * Math.sin(angle + 0.4));
              ctx.stroke();
            }
          } else if (kind === 'rectangle') {
            ctx.strokeRect(
              Math.min(start.x, end.x),
              Math.min(start.y, end.y),
              Math.abs(end.x - start.x),
              Math.abs(end.y - start.y),
            );
          } else if (kind === 'ellipse') {
            const cx = (start.x + end.x) / 2;
            const cy = (start.y + end.y) / 2;
            const rx = Math.abs(end.x - start.x) / 2;
            const ry = Math.abs(end.y - start.y) / 2;
            ctx.beginPath();
            ctx.ellipse(cx, cy, Math.max(rx, 0.5), Math.max(ry, 0.5), 0, 0, Math.PI * 2);
            ctx.stroke();
          }
          ctx.restore();
          continue;
        }

        if (path.points.length < 2) { ctx.restore(); continue; }

        ctx.beginPath();
        if (path.type === 'highlight') {
          ctx.globalCompositeOperation = 'multiply';
          ctx.globalAlpha = 0.35;
          ctx.lineCap = 'butt';
        } else {
          ctx.globalCompositeOperation = 'source-over';
          ctx.globalAlpha = 1.0;
          ctx.lineCap = 'round';
        }

        ctx.strokeStyle = path.color;
        ctx.lineWidth = path.size;

        ctx.moveTo(path.points[0].x, path.points[0].y);
        for (let i = 1; i < path.points.length; i++) {
          ctx.lineTo(path.points[i].x, path.points[i].y);
        }
        ctx.stroke();
        ctx.restore();
      }
      ctx.restore();
    }
  }, [editingLine, editText, caretPos, renderResult, doc, currentPage, scale, drawnPaths, activeTool, displayItems, selectedDisplayItem, formFields, selectedFormField, editOffsetCss, editManualSize, editStyleOverrides, editSel, textFontSize, textUnderline, textColor, strokePaths, pageLinks, selectedLink, linksHighlighted, detectedTables, activeTableId]);

  // Re-draw overlay whenever edit state changes
  useEffect(() => { drawOverlay(); }, [drawOverlay]);

  // ── Caret blink timer ──
  useEffect(() => {
    if (editingLine) {
      caretVisibleRef.current = true;
      caretTimerRef.current = setInterval(() => {
        caretVisibleRef.current = !caretVisibleRef.current;
        drawOverlay();
      }, 530);
      return () => {
        if (caretTimerRef.current) clearInterval(caretTimerRef.current);
      };
    } else {
      caretVisibleRef.current = false;
      if (caretTimerRef.current) clearInterval(caretTimerRef.current);
    }
  }, [editingLine, drawOverlay]);

  // ── Focus hidden input when entering edit mode (don't collapse selection on caret moves)
  useEffect(() => {
    if (editingLine && hiddenInputRef.current) {
      if (blurTimeoutRef.current) {
        clearTimeout(blurTimeoutRef.current);
        blurTimeoutRef.current = null;
      }
      hiddenInputRef.current.focus({ preventScroll: true });
      const pos = caretPos;
      const sel = editSelRef.current;
      if (sel.end > sel.start) {
        hiddenInputRef.current.setSelectionRange(sel.start, sel.end);
      } else {
        hiddenInputRef.current.setSelectionRange(pos, pos);
      }
    }
    // Only re-focus when the edit session starts, not on every caret tick
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editingLine]);

  // ── Begin an edit session with frozen line anchor + undo snapshot ──
  const beginEditSession = useCallback((line: TextLine, caretAt?: number) => {
    if (line.runs.some(run => run.actualText)) {
      setGlyphWarning('Exported shaped text cannot be edited in place; add a new text box instead.');
      return;
    }
    initialRunTextRef.current = line.text;
    setEditAnchorLine({
      ...line,
      runs: line.runs.map(r => ({
        ...r,
        glyphs: r.glyphs.map(g => ({ ...g, tRm: { ...g.tRm } })),
        sourceInstructionIndices: r.sourceInstructionIndices
          ? [...r.sourceInstructionIndices]
          : undefined,
      })),
      segments: line.segments.map(s => ({ ...s, run: s.run })),
    });
    editingBlockIdRef.current = line.id;
    pendingStylesRef.current = [];
    setTypingStyle({});
    setEditStyleOverrides([]);
    setEditOffsetCss({ x: 0, y: 0 });
    setEditManualSize({ w: null, h: null });
    setSelectedDisplayItem(null);
    setActiveTool('text');
    setSelectedLine(line);
    setEditingLine(line);
    // Highlight parent table when editing a cell
    {
      let tableId: string | null = null;
      for (const table of detectedTables) {
        if (table.cells.some(c => c.line.id === line.id || c.line.text === line.text && Math.abs(c.line.baseline - line.baseline) < 2)) {
          tableId = table.id;
          break;
        }
      }
      setActiveTableId(tableId);
    }
    setEditText(line.text);
    editTextRef.current = line.text;
    const caret = caretAt ?? line.text.length;
    setCaretPos(caret);
    editSelRef.current = { start: caret, end: caret };
    setEditSel({ start: caret, end: caret });

    // Sync sidebar + typing style from the character left of the caret
    {
      const seeded = resolveTypingStyleFromCaret(
        line,
        caret,
        renderResult?.fonts,
        strokePaths,
        [],
      );
      setTypingStyle(seeded);
      if (seeded.fontSize != null) setTextFontSize(seeded.fontSize);
      if (seeded.bold != null) setTextBold(seeded.bold);
      if (seeded.italic != null) setTextItalic(seeded.italic);
      if (seeded.underline != null) setTextUnderline(seeded.underline);
      if (seeded.color) setTextColor(seeded.color);
      const seg = segmentAtIndex(line, caret > 0 ? caret - 1 : 0) ?? line.segments[0];
      if (seg) {
        const fd = renderResult?.fonts.get(seg.run.fontName);
        setTextFontFamily(getDisplayFontFamily(seg.run.fontName, fd));
      }
    }

    if (doc && engineRef.current) {
      const page = doc.pages[currentPage];
      const contentBytes = engineRef.current.getPageContentBytes(page, doc.objects);
      undoSnapshotRef.current = {
        pageIndex: currentPage,
        contentBytes: new Uint8Array(contentBytes),
      };
    }
  }, [doc, currentPage, setEditingLine, setEditAnchorLine, setTypingStyle, renderResult, strokePaths, detectedTables]);

  const prepareExportText = useCallback(async (text: string, fontNames?: string[], targetDoc = doc, pageIndex = currentPage) => {
    const engine = engineRef.current;
    if (!targetDoc || !engine) return;
    const page = targetDoc.pages[pageIndex];
    const runs = (fontNames?.length ? fontNames.map(name => engine.loadFontForName(name, page, targetDoc.objects)) : [null])
      .map(fontData => ({ text, fontData }));
    // Coverage in another subset does not imply the contextual font has that CID.
    setLoadingFont(true);
    try { await engine.prepareTextForExport(targetDoc.objects, runs); }
    finally { setLoadingFont(false); }
  }, [doc, currentPage]);

  const prepareOverlayText = useCallback(async () => {
    if (!doc) return;
    const groups = pageOverlayGroups({
      drawnPaths: drawnPathsRef.current,
      floatingTexts: floatingTextsRef.current,
      floatingImages: floatingImagesRef.current,
    }, doc.pages.map(page => page.ref.toKey()));
    for (const [pageIndex, group] of groups) {
      await prepareExportText(group.floatingTexts.map(text => text.text).join('\n'), undefined, doc, pageIndex);
    }
  }, [doc, prepareExportText]);

  // ── Text edit submit — surgical in-place line edit (preserve positions) ──
  const handleEditSubmit = useCallback(async (closeEdit: boolean = true): Promise<boolean> => {
    if (!editingLine || !doc || !engineRef.current) return true;
    const lease = documentOwnerRef.current.lease(doc);
    if (blurTimeoutRef.current) {
      clearTimeout(blurTimeoutRef.current);
      blurTimeoutRef.current = null;
    }

    const textChanged = editText !== initialRunTextRef.current;
    const pdfDx = editOffsetCss.x / scale;
    const pdfDy = -editOffsetCss.y / scale; // CSS down is PDF down in screen, PDF y up
    const moved = Math.abs(pdfDx) > 0.5 || Math.abs(pdfDy) > 0.5;
    const pendingStyles = pendingStylesRef.current;
    const hasPendingStyles = pendingStyles.length > 0;

    if (!textChanged && !moved && !hasPendingStyles) {
      setEditAnchorLine(null);
      undoSnapshotRef.current = null;
      editingBlockIdRef.current = null;
      pendingStylesRef.current = [];
      setTypingStyle({});
      setEditStyleOverrides([]);
      setEditOffsetCss({ x: 0, y: 0 });
      setEditManualSize({ w: null, h: null });
      if (closeEdit) {
        setEditingLine(null);
        setSelectedLine(null);
      }
      return true;
    }

    try {
      setIsSaving(true);
      const engine = engineRef.current;
      await sessionEditorRef.current.edit(doc, 'text-edit', async doc => {
        const page = doc.pages[currentPage];
        const targetLine = editAnchorLineRef.current ?? editingLine;
        const snapshot = undoSnapshotRef.current;
        let bytes = snapshot?.pageIndex === currentPage
          ? new Uint8Array(snapshot.contentBytes)
          : engine.getPageContentBytes(page, doc.objects);
      
        const fontSizeOverrides = pendingStyles
          .filter(p => p.patch.fontSize != null && p.end > p.start)
          .map(p => ({
            start: p.start,
            end: p.end,
            fontSize: p.patch.fontSize as number,
          }));
      
        if (textChanged) {
          const commitText = editTextRef.current || editText;
          const caretAfter = editSelRef.current.end;
          await prepareExportText(commitText, targetLine.runs.map(run => run.fontName), doc);
          // Do NOT collapse multi-spaces on commit — live overlay gaps were real
          // inserts, and smashing them made spaces vanish on click-away.
          const editResult = engine.applyLineTextEdit(
            bytes,
            page,
            doc.objects,
            targetLine,
            commitText,
            renderResult?.documentFlow,
            {
              oldText: initialRunTextRef.current || targetLine.text,
              optionalContent: new engine.OptionalContentVisibility(doc.catalog, doc.objects),
              caretAfter,
              skipResidualCorrection: pendingStyles.some(p => p.patch.fontSize != null),
              fontSizeOverrides: fontSizeOverrides.length > 0 ? fontSizeOverrides : undefined,
            },
          );
      
          if (editResult.needsFontAugmentation) {
            try {
              const missing = String.fromCharCode(
                ...editResult.missingCharCodes.filter(c => c < 0x10000),
              );
              engine.augmentFontsForMissingGlyphs(doc, currentPage, missing);
            } catch (augErr) {
              console.warn('[Editor] Font augmentation failed:', augErr);
            }
          }
          bytes = editResult.newContentBytes;
        }
      
        if (moved) {
          const shifts = targetLine.runs.map(run => ({ run, dx: pdfDx, dy: pdfDy }));
          bytes = engine.applyRunPositionShifts(bytes, shifts);
          // underline strokes are separate paths — carry them with the text
          bytes = engine.moveUnderlinesWithRuns(bytes, targetLine.runs, pdfDx, pdfDy);
        }
      
        await engine.updatePageContent(page.contentRefs, bytes, doc.objects);
      
        if (hasPendingStyles) {
          const commitText = editTextRef.current || editText;
          // Merge adjacent identical patches so we don't split the same run repeatedly
          const raw = [...pendingStyles]
            .filter(p => p.end > p.start)
            .sort((a, b) => a.start - b.start || a.end - b.end);
          let queued: typeof raw = [];
          for (const item of raw) {
            const prev = queued[queued.length - 1];
            const samePatch = prev && JSON.stringify(prev.patch) === JSON.stringify(item.patch);
            if (samePatch && prev.end >= item.start) {
              prev.end = Math.max(prev.end, item.end);
            } else {
              queued.push({ ...item, patch: { ...item.patch } });
            }
          }
          // Bridge fontSize-only holes left by spaces (not committed as fontSize)
          queued = coalesceFontSizePatches(queued, commitText);
          queued = expandFontSizePatchesThroughSpaces(queued, commitText);
          // Re-interpret so selection ranges map onto the updated line text/runs
          let styleLine: TextLine = targetLine;
          const normalizeDashes = (t: string) => t.replace(/[\u2013\u2014\u2212]/g, '-');
          const commitNorm = normalizeDashes(commitText);
          const refreshStyleLine = () => {
            try {
              const freshBytes = engine.getPageContentBytes(page, doc.objects);
              const interpreted = engine.interpretPage(freshBytes, page, doc.objects, new engine.OptionalContentVisibility(doc.catalog, doc.objects));
              const flow = engine.buildDocumentFlow(interpreted.textRuns);
              styleLine =
                flow.lines.find((l: TextLine) => l.text === commitText) ??
                flow.lines.find((l: TextLine) => normalizeDashes(l.text) === commitNorm) ??
                findMatchingFlowLine(targetLine, flow.lines) ??
                styleLine;
            } catch (reErr) {
              console.warn('[Editor] Re-interpret for styles failed:', reErr);
            }
          };
          refreshStyleLine();
      
          // Path underlines don't move when text grows — expand insert-only
          // underline patches to the full destination run so the stroke covers
          // the whole title after commit.
          for (const item of queued) {
            if (item.patch.underline !== true) continue;
            const onlyUl = Object.keys(item.patch).every(
              k => k === 'underline' || (item.patch as Record<string, unknown>)[k] == null,
            );
            if (!onlyUl) continue;
            for (const seg of styleLine.segments) {
              if (item.end > seg.startIndex && item.start < seg.endIndex) {
                item.start = Math.min(item.start, seg.startIndex);
                item.end = Math.max(item.end, seg.endIndex);
              }
            }
          }
      
          // Batched fontSize trailing only (no post-style residual). Residual after
          // Tf splits re-chained widths and shoved trailers; batched growth tracks
          // selection enlarge only.
          // Skip when text-edit already reserved large-font width via fontSizeOverrides
          // — stacking both invents a river after the enlarged insert.
          if (textChanged && fontSizeOverrides.length === 0) {
            const fsRanges = queued
              .filter(q => q.patch.fontSize != null)
              .map(q => ({
                start: Math.max(0, Math.min(q.start, styleLine.text.length)),
                end: Math.max(0, Math.min(q.end, styleLine.text.length)),
                fontSize: q.patch.fontSize as number,
              }))
              .filter(r => r.end > r.start);
            if (fsRanges.length > 0) {
              const batched = engine.collectBatchedFontSizeTrailingShifts(styleLine, fsRanges);
              if (batched.shifts.length > 0) {
                let styleBytes = engine.getPageContentBytes(page, doc.objects);
                styleBytes = engine.applyRunPositionShifts(
                  styleBytes,
                  batched.shifts,
                  styleLine.runs,
                );
                await engine.updatePageContent(page.contentRefs, styleBytes, doc.objects);
              }
            }
          }
      
          for (let qi = 0; qi < queued.length; qi++) {
            const item = queued[qi];
            const style: Record<string, unknown> = {};
            if (item.patch.fontSize != null) style.fontSize = item.patch.fontSize;
            if (item.patch.fontFamily != null) style.fontFamily = item.patch.fontFamily;
            if (item.patch.color != null) style.color = hexToRGB(item.patch.color);
            if (item.patch.bold != null) style.bold = item.patch.bold;
            if (item.patch.italic != null) style.italic = item.patch.italic;
            if (item.patch.underline != null) style.underline = item.patch.underline;
            if (item.patch.align != null) style.align = item.patch.align;
            if (Object.keys(style).length === 0) continue;
            // Clamp to the committed line length
            const start = Math.max(0, Math.min(item.start, styleLine.text.length));
            const end = Math.max(start, Math.min(item.end, styleLine.text.length));
            if (end <= start) continue;
            await engine.applyStyleToSelectionOnPage(
              doc,
              currentPage,
              styleLine,
              start,
              end,
              style,
              textChanged ? { skipTrailingFontSizeShifts: true } : undefined,
            );
            // Splits invalidate sourceInstructionIndices — refresh before next patch
            if (qi < queued.length - 1) refreshStyleLine();
          }
        } else if (textChanged) {
          // No pending styles — pack measured gaps after the text rewrite only.
          // Skip when spaces were inserted: TJ space advances inflate measured
          // widths and residual packing then pulls trailers left, collapsing
          // live gaps and truncating the line.
          const commitText = editTextRef.current || editText;
          const oldTextForPack = initialRunTextRef.current || targetLine.text;
          const packDeltaSpaces =
            (commitText.match(/\s/g) || []).length - (oldTextForPack.match(/\s/g) || []).length;
          if (packDeltaSpaces <= 0) {
            try {
              const packBytes = engine.getPageContentBytes(page, doc.objects);
              const interpreted = engine.interpretPage(packBytes, page, doc.objects, new engine.OptionalContentVisibility(doc.catalog, doc.objects));
              const flow = engine.buildDocumentFlow(interpreted.textRuns);
              const normalizeDashes = (t: string) => t.replace(/[\u2013\u2014\u2212]/g, '-');
              const commitNorm = normalizeDashes(commitText);
              const packLine =
                flow.lines.find((l: TextLine) => l.text === commitText) ??
                flow.lines.find((l: TextLine) => normalizeDashes(l.text) === commitNorm) ??
                findMatchingFlowLine(targetLine, flow.lines) ??
                null;
              // A cell that grew into its column gutter is re-detected as one line together with
              // its right neighbour; packing that merged line would drag the neighbour next to it.
              // Only pack when the matched line is still just the edited text.
              const mergedWithNeighbour = packLine != null && packLine.text.length > commitText.length;
              if (packLine && !mergedWithNeighbour && packLine.segments.length > 1) {
                const packed = engine.correctLineResidualGaps(
                  packBytes, page, doc.objects, packLine,
                  { gapSourceLine: targetLine, optionalContent: new engine.OptionalContentVisibility(doc.catalog, doc.objects) },
                );
                if (packed.corrections.length > 0) {
                  await engine.updatePageContent(page.contentRefs, packed.bytes, doc.objects);
                }
              }
            } catch (packErr) {
              console.warn('[Editor] Post-text residual pack failed:', packErr);
            }
          }
        }
      }, { isCurrent: lease.isCurrent });
      if (!lease.isCurrent()) return false;
      pushEditorHistory('text-edit', undefined, undefined, false, sessionEditorRef.current);
      sessionEditorRef.current = new SessionDocumentEditor();
      setEditAnchorLine(null);
      undoSnapshotRef.current = null;
      editingBlockIdRef.current = null;
      pendingStylesRef.current = [];
      setTypingStyle({});
      setEditStyleOverrides([]);
      setEditOffsetCss({ x: 0, y: 0 });
      setEditManualSize({ w: null, h: null });
      setIsDirty(true);
      if (closeEdit) {
        setEditingLine(null);
        setSelectedLine(null);
      }
      setRenderKey(k => k + 1);
      setThumbnailKey(k => k + 1);
      setGlyphWarning(null);
      return true;
    } catch (e) {
      if (!lease.isCurrent()) return false;
      if (!showUnsupportedGlyphWarning(e)) {
        console.error('[Editor] Edit failed:', e);
        setError(`Edit failed: ${e instanceof Error ? e.message : String(e)}`);
      }
      return false;
    } finally {
      if (lease.isCurrent()) setIsSaving(false);
    }
  }, [editingLine, editText, editOffsetCss, scale, doc, currentPage, setEditingLine, setEditAnchorLine, setTypingStyle, renderResult, pushEditorHistory, showUnsupportedGlyphWarning, prepareExportText, setThumbnailKey]);

  // ── Edit cancel — discard overlay only; PDF untouched until commit ──
  const handleEditCancel = useCallback(async () => {
    if (blurTimeoutRef.current) {
      clearTimeout(blurTimeoutRef.current);
      blurTimeoutRef.current = null;
    }
    setEditAnchorLine(null);
    undoSnapshotRef.current = null;
    editingBlockIdRef.current = null;
    pendingStylesRef.current = [];
    setTypingStyle({});
    setEditStyleOverrides([]);
    setEditOffsetCss({ x: 0, y: 0 });
    setEditManualSize({ w: null, h: null });
    setEditingLine(null);
    setSelectedLine(null);
    setEditText('');
    setCaretPos(0);
  }, [setEditingLine, setEditAnchorLine, setTypingStyle]);

  // ── Undo ──
  const handleUndo = useCallback(async () => {
    if (!doc || !engineRef.current || historyBusyRef.current) return;
    if (!await commitFormFieldDraft() || historyBusyRef.current) return;
    historyBusyRef.current = true;
    try {
      await queueNativeEdit(doc, async isCurrent => {
        const engine = engineRef.current;
        if (!engine) throw new Error('The PDF engine is unavailable.');
        const previousEntry = historyRef.current.peek();
        const resize = previousEntry ? imageResizeHistoryRef.current.get(previousEntry) : undefined;
        const result = await historyRef.current.moveAtomic(doc, 'undo', {
          isCurrent,
          applyLegacy: (staged, entry) => restoreHistoryGraph(staged, entry, engine),
        });
        if (result && isCurrent()) await applyHistoryEntry(result.entry, true, {
          pageKey: doc.pages[currentPage]?.ref.toKey(),
          image: resize && resize.pageKey === doc.pages[currentPage]?.ref.toKey() &&
            sameImagePlacement(selectedDisplayItem, resize.after) ? resize.before : undefined,
          signatureId: previousEntry?.label === 'resize-signature' ? selectedSignatureId ?? undefined : undefined,
        });
      });
    } catch (e) {
      console.error('[Editor] Undo failed:', e);
      setError(`Undo failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      historyBusyRef.current = false;
      syncTxState();
    }
  }, [doc, currentPage, applyHistoryEntry, syncTxState, selectedDisplayItem, selectedSignatureId, queueNativeEdit, commitFormFieldDraft]);

  const handleRedo = useCallback(async () => {
    if (!doc || !engineRef.current || historyBusyRef.current) return;
    if (!await commitFormFieldDraft() || historyBusyRef.current) return;
    historyBusyRef.current = true;
    try {
      await queueNativeEdit(doc, async isCurrent => {
        const engine = engineRef.current;
        if (!engine) throw new Error('The PDF engine is unavailable.');
        const result = await historyRef.current.moveAtomic(doc, 'redo', {
          isCurrent,
          applyLegacy: (staged, entry) => restoreHistoryGraph(staged, entry, engine),
        });
        if (result && isCurrent()) {
          const resize = imageResizeHistoryRef.current.get(result.entry);
          await applyHistoryEntry(result.entry, true, {
            pageKey: doc.pages[currentPage]?.ref.toKey(),
            image: resize && resize.pageKey === doc.pages[currentPage]?.ref.toKey() &&
              sameImagePlacement(selectedDisplayItem, resize.before) ? resize.after : undefined,
            signatureId: result.entry.label === 'resize-signature' ? selectedSignatureId ?? undefined : undefined,
          });
        }
      });
    } catch (e) {
      console.error('[Editor] Redo failed:', e);
      setError(`Redo failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      historyBusyRef.current = false;
      syncTxState();
    }
  }, [doc, currentPage, applyHistoryEntry, syncTxState, selectedDisplayItem, selectedSignatureId, queueNativeEdit, commitFormFieldDraft]);

  /** Place active library signature into a PDF /FT Sig field (writes /AP). */
  const placeLibrarySignatureIntoField = useCallback(async (field: SignatureField) => {
    if (!doc) return;
    const lib = getSignatureLibrary();
    let entry = activeLibraryId ? lib.get(activeLibraryId) : null;
    if (!entry) {
      const list = lib.list();
      entry = list.find((e) => e.favorite) ?? list[0] ?? null;
    }
    if (!entry) {
      setSignatureCreateOpen(true);
      return;
    }
    try {
      // Also keep a visual overlay aligned to the field for immediate feedback
      const overlay = createVisualSignature({
        pageIndex: field.pageIndex,
        x: field.rect.x + field.rect.width / 2,
        y: field.rect.y + field.rect.height / 2,
        appearanceId: entry.id,
        appearanceImageDataUrl: entry.imageDataUrl,
        appearanceType:
          entry.source === 'draw' ? 'drawn' : entry.source === 'typed' ? 'typed' : 'uploaded',
        width: field.rect.width,
        height: field.rect.height,
      });
      await queueNativeEdit(doc, async isCurrent => {
        const withoutOverlapping = signaturesRef.current.filter(
          s => !(
            s.pageIndex === field.pageIndex &&
            Math.abs(s.x - overlay.x) < 2 &&
            Math.abs(s.y - overlay.y) < 2
          ),
        );
        const editor = new SessionDocumentEditor();
        await editor.edit(doc, 'place-in-field', async staged => {
          for (const previous of signaturesRef.current) {
            if (!withoutOverlapping.includes(previous)) removeVisualSignature(staged, previous.id);
          }
          await applySignatureFieldAppearanceAsync(staged, field.ref, {
            width: field.rect.width,
            height: field.rect.height,
            imageDataUrl: entry.imageDataUrl,
            typedName: entry.typedText || entry.name,
            date: new Date().toLocaleDateString(),
            backgroundColor: [1, 1, 1],
            borderWidth: 1,
            borderColor: [0.2, 0.25, 0.35],
          });
          const widget = staged.objects.get(field.ref.toKey());
          if (!(widget instanceof PDFDict)) throw new Error('Signature field is unavailable');
          widget.set('PaperloomSignatureId', new PDFString(overlay.id));
        }, { isCurrent });
        const next = [...withoutOverlapping, overlay];
        signaturesRef.current = next;
        setSignatures(next);
        pushEditorHistory('place-in-field', { signatures: next }, undefined, false, editor);
      });
      setPdfSignatureFields(detectSignatureFieldsOnPage(doc, currentPage));
      setSelectedPdfSigFieldId(field.id);
      setActiveLibraryId(entry.id);
      setIsDirty(true);
      setRenderKey((k) => k + 1);
      setThumbnailKey(k => k + 1);
    } catch (err) {
      console.error('[Editor] Place signature in field failed:', err);
      setError(`Place signature failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, [doc, activeLibraryId, currentPage, pushEditorHistory, queueNativeEdit, setThumbnailKey]);

  const refreshCertificateIdentities = useCallback(() => {
    const mgr = getCertificateManager();
    setCertificateIdentities(mgr.list());
    setSelectedCertificateId(mgr.getSelected()?.id ?? null);
  }, []);

  const handleCertificateImportChange = useCallback((list: ManagedIdentity[]) => {
    setCertificateIdentities(list);
    setSelectedCertificateId(getCertificateManager().getSelected()?.id ?? null);
  }, []);

  useEffect(() => {
    const t = window.setTimeout(refreshCertificateIdentities, 80);
    return () => window.clearTimeout(t);
  }, [refreshCertificateIdentities]);

  const handleSelectCertificate = useCallback((id: string | null) => {
    getCertificateManager().select(id);
    setSelectedCertificateId(id);
  }, []);

  const handleCryptographicSign = useCallback(async () => {
    if (!doc) {
      setError('No document loaded.');
      return;
    }
    const mgr = getCertificateManager();
    if (selectedCertificateId) mgr.select(selectedCertificateId);
    const keyMat = mgr.getSelectedKey();
    const identity = mgr.getSelected();
    if (!keyMat?.privateKey) {
      setCertificateImportOpen(true);
      setError('Import a certificate with a private key to digitally sign.');
      return;
    }
    if (cryptoSignBusyRef.current) return;
    const lease = documentOwnerRef.current.lease(doc);
    cryptoSignBusyRef.current = true;
    setCryptoSignBusy(true);
    setError(null);
    try {
      const leafDer = mgr.getSelectedLeafDer() ?? undefined;
      await queueNativeEdit(doc, async () => {
        const overlaysAreCommitted = () => {
          if (editingLineRef.current || floatingTextsRef.current.length || floatingImagesRef.current.length || drawnPathsRef.current.length) return false;
          const ids = new Set(signaturesRef.current.map(item => item.id));
          return findVisualSignatureRefs(doc, ids).size === ids.size;
        };
        if (!overlaysAreCommitted()) {
          throw new Error('Finish and download pending edits before signing. For an already signed document, undo those edits first.');
        }
        const placed = signaturesRef.current.find(item => item.pageIndex === currentPage) ?? signaturesRef.current[0];
        const signed = await signDocumentTransaction(doc, {
          pageIndex: currentPage,
          selectedFieldId: selectedPdfSigFieldId,
          point: { x: placed?.x ?? 100, y: placed?.y ?? 100 },
          privateKey: keyMat.privateKey,
          isCurrent: () => lease.isCurrent() && overlaysAreCommitted(),
          signOptions: {
            reason: 'Document approval',
            name: identity?.leaf?.subject.commonName ?? identity?.label ?? 'Signer',
            hashAlgorithm: 'sha256',
            contentsSize: 8192,
            certificateDer: leafDer,
            appearanceText: identity?.leaf?.subject.commonName ?? identity?.label ?? 'Signed',
            enableTimestamp,
          },
        });
        setPdfSignatureFields(detectSignatureFieldsOnPage(doc, currentPage));
        pushSignatureSnapshot(
          lockSignaturesAfterSigning(signaturesRef.current, signed.pageIndex),
          'digital-sign',
          signed.editor,
        );
        if (activeLibraryId) pushRecentSignatureId(activeLibraryId);
        refreshMultiSigPanel();
        setRenderKey(k => k + 1);
        setThumbnailKey(k => k + 1);
        const timestampWarning = timestampFallbackMessage(signed.result.timestampError);
        if (timestampWarning) setError(timestampWarning);
      });
    } catch (err) {
      console.error('[Editor] Cryptographic sign failed:', err);
      setError(`Digital sign failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      cryptoSignBusyRef.current = false;
      setCryptoSignBusy(false);
    }
  }, [doc, selectedPdfSigFieldId, selectedCertificateId, currentPage, enableTimestamp, pushSignatureSnapshot, activeLibraryId, queueNativeEdit, refreshMultiSigPanel, setThumbnailKey]);

  useEffect(() => {
    if (!originalIsCurrentRef.current) setValidationReport(null);
  }, [doc, isDirty, renderKey, thumbnailKey, drawnPaths, floatingTexts, floatingImages, signatures]);

  const handleValidateSignatures = useCallback(async () => {
    if (!doc) return;
    if (!originalIsCurrentRef.current) {
      setValidationReport(null);
      setError('Reopen the saved PDF before validating signatures; the current editor state may differ from the saved bytes.');
      return;
    }
    const lease = documentOwnerRef.current.lease(doc);
    setValidationBusy(true);
    try {
      const report = await validateDocumentSignatures(doc);
      if (originalIsCurrentRef.current && lease.isCurrent()) {
        setValidationReport(report);
      }
      refreshMultiSigPanel();
    } catch (err) {
      setError(`Validation failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setValidationBusy(false);
    }
  }, [doc, refreshMultiSigPanel]);

  const handleEnableLtv = useCallback(() => {
    if (!doc) return;
    try {
      enableLongTermValidation(doc);
      setIsDirty(true);
      refreshMultiSigPanel();
    } catch (err) {
      setError(`LTV failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, [doc, refreshMultiSigPanel]);

  // ── Document-wide search effect ──
  const searchCommitRef = useRef(commitFormFieldDraft);
  useLayoutEffect(() => { searchCommitRef.current = commitFormFieldDraft; }, [commitFormFieldDraft]);
  const searchIndexRef = useRef(new DocumentSearchIndex());
  useEffect(() => {
    let cancelled = false;
    // Let the input paint, and make a newer query cancel any running scan.
    const timer = window.setTimeout(() => {
      if (!doc || !engineRef.current || !findText.trim()) {
        if (!doc) searchIndexRef.current.clear();
        setSearchResults([]);
        updateActiveMatchIndex(0);
        lastSearchRef.current = { doc, query: '', caseSensitive };
        return;
      }
      const query = findText.trim();
      const engine = engineRef.current;
      const previousSearch = lastSearchRef.current;
      const newSearch = !previousSearch || previousSearch.doc !== doc ||
        previousSearch.query !== query || previousSearch.caseSensitive !== caseSensitive;
      const isLive = () => !cancelled && documentOwnerRef.current.lease(doc).isCurrent();
      const pageBeforeSearch = currentPageRef.current;
      setSearchResults([]);
      void searchLatestDocument(doc, query, caseSensitive, searchIndexRef.current, engine,
        () => `${editRevisionRef.current}:${renderKey}`, isLive, async () => {
          if (!newSearch) return true;
          return searchCommitRef.current();
        }, undefined, undefined, matches => {
          if (!isLive()) return;
          lastSearchRef.current = { doc, query, caseSensitive };
          setSearchResults(matches);
          if (matches.length > 0) {
            const prev = activeMatchIndexRef.current;
            const nextIdx = !newSearch && prev >= 0 && prev < matches.length ? prev : 0;
            updateActiveMatchIndex(nextIdx);
            if (newSearch && currentPageRef.current === pageBeforeSearch) changePage(matches[nextIdx].pageIndex);
          } else updateActiveMatchIndex(0);
        })
        .catch(error => {
          if (!isLive()) return;
          console.warn('[Search] Unable to inspect document:', error);
          lastSearchRef.current = null;
          setSearchResults([]);
          updateActiveMatchIndex(0);
          setError(error instanceof SearchPageError || error instanceof SearchChangedError
            ? error.message : 'Search could not safely inspect the document.');
        });
    }, 0);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [findText, caseSensitive, doc, renderKey, updateActiveMatchIndex]);

  const handleNextMatch = useCallback(async () => {
    if (searchResults.length === 0 || !await commitFormFieldDraft()) return;
    const nextIdx = (activeMatchIndex + 1) % searchResults.length;
    updateActiveMatchIndex(nextIdx);
    const targetPage = searchResults[nextIdx].pageIndex;
    if (targetPage !== currentPage) {
      changePage(targetPage);
    }
  }, [searchResults, activeMatchIndex, currentPage, updateActiveMatchIndex, commitFormFieldDraft]);

  const handlePrevMatch = useCallback(async () => {
    if (searchResults.length === 0 || !await commitFormFieldDraft()) return;
    const prevIdx = (activeMatchIndex - 1 + searchResults.length) % searchResults.length;
    updateActiveMatchIndex(prevIdx);
    const targetPage = searchResults[prevIdx].pageIndex;
    if (targetPage !== currentPage) {
      changePage(targetPage);
    }
  }, [searchResults, activeMatchIndex, currentPage, updateActiveMatchIndex, commitFormFieldDraft]);

  const handleReplaceCurrent = useCallback(async () => {
    if (!renderReadyRef.current) { setError('The current page is not available for editing.'); return; }
    if (!doc || !engineRef.current || searchBusyRef.current || searchResults.length === 0 || !findText.trim()) return;
    const currentMatch = searchResults[activeMatchIndex];
    if (!currentMatch) return;
    try { if (currentMatch.source !== 'cross-run') assertCurrentReplaceSupported(currentMatch); }
    catch (error) { setError(error instanceof Error ? error.message : String(error)); return; }
    const lastSearch = lastSearchRef.current;
    if (!lastSearch || lastSearch.doc !== doc || lastSearch.query !== findText.trim() || lastSearch.caseSensitive !== caseSensitive) {
      setError('Search results changed. Wait for the updated matches before replacing.');
      return;
    }

    searchBusyRef.current = true;
    setSearchBusy(true);
    try {
      const engine = engineRef.current;
      await queueNativeEdit(doc, async isCurrent => {
        const editor = new SessionDocumentEditor();
        let replacedCount = 0;
        await editor.edit(doc, 'replace-current', async staged => {
          const page = staged.pages[currentMatch.pageIndex];
          if (!page || page.ref.toKey() !== currentMatch.pageKey) throw new Error('The selected search match changed. Search again before replacing it.');
          if (currentMatch.source === 'cross-run') {
            replacedCount = await replaceSearchMatches(staged, findText.trim(), replaceText, caseSensitive, engine, currentMatch);
            return;
          }
          assertCurrentReplaceSupported(currentMatch);
          const bytes = engine.getPageContentBytes(page, staged.objects);
          const result = engine.findAndReplace(bytes, page, staged.objects, findText.trim(), replaceText, caseSensitive, {
            runIndex: currentMatch.runIndex, start: currentMatch.start, end: currentMatch.end, runText: currentMatch.runText,
          }, new engine.OptionalContentVisibility(staged.catalog, staged.objects));
          replacedCount = result.replacedCount;
          if (replacedCount) await engine.updatePageContent(page.contentRefs, result.newContentBytes, staged.objects);
        }, { isCurrent });
        if (replacedCount && isCurrent()) {
          pushEditorHistory('replace-current', undefined, currentMatch.pageIndex, false, editor);
          setRenderKey(k => k + 1);
          setThumbnailKey(k => k + 1);
        }
      });
    } catch (err) {
      console.error('[Search] Replace current error:', err);
      setError(`Replace failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      searchBusyRef.current = false;
      setSearchBusy(false);
    }
  }, [doc, searchResults, activeMatchIndex, findText, replaceText, caseSensitive, queueNativeEdit, pushEditorHistory, setThumbnailKey]);

  const handleReplaceAll = useCallback(async () => {
    if (!renderReadyRef.current) { setError('The current page is not available for editing.'); return; }
    if (!doc || !engineRef.current || searchBusyRef.current || !findText.trim()) return;
    searchBusyRef.current = true;
    setSearchBusy(true);
    try {
      const engine = engineRef.current;
      await queueNativeEdit(doc, async isCurrent => {
        const editor = new SessionDocumentEditor();
        let replacedCount = 0;
        await editor.edit(doc, 'replace-all', async staged => {
          replacedCount = await replaceSearchMatches(staged, findText.trim(), replaceText, caseSensitive, engine);
        }, { isCurrent });
        if (replacedCount && isCurrent()) {
          pushEditorHistory('replace-all', undefined, undefined, false, editor);
          setRenderKey(k => k + 1);
          setThumbnailKey(k => k + 1);
        }
      });
    } catch (err) {
      console.error('[Search] Replace all error:', err);
      setError(`Replace all failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      searchBusyRef.current = false;
      setSearchBusy(false);
    }
  }, [doc, findText, replaceText, caseSensitive, queueNativeEdit, pushEditorHistory, setThumbnailKey]);

  const ocrBusyRef = useRef(false);
  const handleRecognizeText = useCallback(async () => {
    if (!doc || !engineRef.current || !pdfCanvasRef.current || ocrBusyRef.current) return;
    if (!renderReadyRef.current) { setError('Wait for the current page to finish rendering.'); return; }
    const page = doc.pages[currentPage];
    if (!page) return;
    if (!supportsOcrPageGeometry(page)) {
      setError('OCR is not supported for rotated, cropped, or offset pages.');
      return;
    }
    const lease = documentOwnerRef.current.lease(doc);
    const engine = engineRef.current;
    const revision = editRevisionRef.current;
    ocrBusyRef.current = true;
    try {
      // The canvas and its geometry must be captured before any asynchronous work.
      const image = canvasToImageData(pdfCanvasRef.current);
      setIsSaving(true);
      setError(null);
      const result = await runOcrOperation({
        doc, pageKey: page.ref.toKey(), pageHeight: page.mediaBox.height,
        mediaBoxY: page.mediaBox.y, scale, dpr: renderedPage!.dpr, image,
        isCurrent: lease.isCurrent, revision, getRevision: () => editRevisionRef.current,
        createAdapter: async () => (await import('@/lib/ocr/adapter')).createDefaultOcrAdapter(),
        enqueue: apply => queueNativeEdit(doc, apply),
        insert: (staged, index, words) => engine.insertInvisibleTextLayer(staged, index, words),
        committed: (editor, index) => {
          pushEditorHistory('ocr', undefined, index, false, editor);
          setRenderKey(k => k + 1);
          setThumbnailKey(k => k + 1);
        },
      });
      if (lease.isCurrent() && result === 'empty') {
        setError('OCR found no text on this page. Try a clearer scan or higher zoom.');
      }
    } catch (e) {
      if (lease.isCurrent()) setError(`OCR failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      ocrBusyRef.current = false;
      setIsSaving(false);
    }
  }, [doc, currentPage, scale, renderedPage, queueNativeEdit, pushEditorHistory, setThumbnailKey]);

  const handleFlattenForms = useCallback(async () => {
    if (!doc || !engineRef.current || formFields.length === 0) return;
    if (!await commitFormFieldDraft()) return;
    try {
      setIsSaving(true);
      const engine = engineRef.current;
      await queueNativeEdit(doc, async isCurrent => {
        const editor = new SessionDocumentEditor();
        await editor.edit(doc, 'flatten-forms', async staged => {
          await engine.flattenFormFieldsOnPage(staged, currentPage, engine.detectFormFieldsOnPage(staged, currentPage));
        }, { isCurrent });
        pushEditorHistory('flatten-forms', undefined, undefined, false, editor);
      });
      setIsDirty(true);
      setThumbnailKey(k => k + 1);
      setFormFields([]);
      setSelectedFormField(null);
      setFormFieldDraft('');
      setRenderKey(k => k + 1);
    } catch (e) {
      console.error('[Editor] Flatten forms failed:', e);
      setError(`Flatten failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setIsSaving(false);
    }
  }, [doc, currentPage, formFields, pushEditorHistory, queueNativeEdit, commitFormFieldDraft, setThumbnailKey]);

  const handleDuplicateLineBelow = useCallback(async () => {
    const line = editAnchorLineRef.current ?? selectedLine ?? editingLine;
    if (!doc || !engineRef.current || !line) return;
    try {
      if (editingLine && !await handleEditSubmit(false)) return;
      setIsSaving(true);
      const engine = engineRef.current;
      const page = doc.pages[currentPage];
      const bytes = engine.getPageContentBytes(page, doc.objects);
      const next = engine.duplicateLineBelow(bytes, line);
      await engine.updatePageContent(page.contentRefs, next, doc.objects);
      pushEditorHistory('duplicate-line');
      setIsDirty(true);
      setRenderKey(k => k + 1);
    } catch (e) {
      console.error('[Editor] Duplicate line failed:', e);
      setError(`Duplicate line failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setIsSaving(false);
    }
  }, [doc, currentPage, selectedLine, editingLine, handleEditSubmit, pushEditorHistory]);

  // Resolve table cell for the current selection (for sidebar actions)
  const selectedTableCell = (() => {
    const line = selectedLine ?? editingLine;
    if (!line) return null;
    for (const table of detectedTables) {
      for (const cell of table.cells) {
        if (
          Math.abs(cell.line.baseline - line.baseline) < 3 &&
          Math.abs(cell.line.x - line.x) < 8
        ) {
          return { table, cell };
        }
      }
    }
    return null;
  })();

  const handleAddTableRow = useCallback(async () => {
    if (!doc || !engineRef.current || !selectedTableCell) return;
    try {
      if (editingLine && !await handleEditSubmit(false)) return;
      setIsSaving(true);
      const { table, cell } = selectedTableCell;
      const rowLines = engineRef.current.getTableRowLines(table, cell.row);
      const page = doc.pages[currentPage];
      const bytes = engineRef.current.getPageContentBytes(page, doc.objects);
      const next = engineRef.current.duplicateTableRowBelow(bytes, rowLines);
      await engineRef.current.updatePageContent(page.contentRefs, next, doc.objects);
      pushEditorHistory('table-add-row');
      setIsDirty(true);
      setRenderKey(k => k + 1);
    } catch (e) {
      console.error('[Editor] Add table row failed:', e);
      setError(`Add row failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setIsSaving(false);
    }
  }, [doc, currentPage, selectedTableCell, editingLine, handleEditSubmit, pushEditorHistory]);

  const handleAddTableColumn = useCallback(async () => {
    if (!doc || !engineRef.current || !selectedTableCell) return;
    try {
      if (editingLine && !await handleEditSubmit(false)) return;
      setIsSaving(true);
      const { table } = selectedTableCell;
      const rows: TextLine[][] = [];
      for (let r = 0; r < table.rows; r++) {
        rows.push(engineRef.current.getTableRowLines(table, r));
      }
      const page = doc.pages[currentPage];
      const bytes = engineRef.current.getPageContentBytes(page, doc.objects);
      const next = engineRef.current.insertTableColumnRight(bytes, rows);
      await engineRef.current.updatePageContent(page.contentRefs, next, doc.objects);
      pushEditorHistory('table-add-column');
      setIsDirty(true);
      setRenderKey(k => k + 1);
    } catch (e) {
      console.error('[Editor] Add table column failed:', e);
      setError(`Add column failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setIsSaving(false);
    }
  }, [doc, currentPage, selectedTableCell, editingLine, handleEditSubmit, pushEditorHistory]);

  // ── Global keyboard shortcuts for undo/redo (skip while editing text) ──
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (closeDialogOpen || closeOperationRef.current || downloadOperationRef.current) return;
      const target = e.target as HTMLElement | null;
      const inTextEdit =
        !!editingLineRef.current ||
        target?.tagName === 'TEXTAREA' ||
        target?.tagName === 'INPUT' ||
        target?.isContentEditable;
      if (inTextEdit) return; // native undo for typing; document undo when not editing
      if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) {
        e.preventDefault();
        void handleUndo();
      } else if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || (e.key === 'z' && e.shiftKey))) {
        e.preventDefault();
        void handleRedo();
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [handleUndo, handleRedo, closeDialogOpen]);

  const resolveLinkDisplay = useCallback((link: import('@/engine/browser-core').PageLinkInfo) => {
    const lines = renderResult?.textLines ?? [];
    if (!lines.length) return { text: '', line: null as TextLine | null, start: 0, end: 0 };
    const cx = link.rect.x + link.rect.width / 2;
    const cy = link.rect.y + link.rect.height / 2;
    const line = hitTestTextLine(cx, cy, lines) || findNearestTextLine(cx, cy, lines, 24);
    if (!line) return { text: '', line: null, start: 0, end: 0 };
    const start = caretIndexFromLineX(link.rect.x, line);
    const end = Math.max(start, caretIndexFromLineX(link.rect.x + link.rect.width, line));
    return { text: line.text.slice(start, end), line, start, end };
  }, [renderResult]);

  // Both tapping and dragging use the same native signature transaction.
  const placeLibrarySignatureAt = useCallback(async (signatureId: string, pdfX: number, pdfY: number) => {
    if (!doc?.pages[currentPage]) return;
    const entry = getSignatureLibrary().get(signatureId);
    if (!entry) return;
    const scaleFit = Math.min(1, DEFAULT_SIGNATURE_SIZE.width / Math.max(entry.width, 1));
    const sig = createVisualSignature({
      pageIndex: currentPage,
      x: pdfX,
      y: pdfY,
      appearanceId: entry.id,
      appearanceImageDataUrl: entry.imageDataUrl,
      appearanceType: entry.source === 'draw' ? 'drawn' : entry.source === 'typed' ? 'typed' : 'uploaded',
      width: Math.max(40, entry.width * scaleFit),
      height: Math.max(24, entry.height * scaleFit),
    });
    if (!await commitSignatureChange(current => [...current, sig], 'add-signature')) return;
    setSelectedSignatureId(sig.id);
    setSelectedPdfSigFieldId(null);
    setActiveLibraryId(entry.id);
    pushRecentSignatureId(entry.id);
  }, [doc, currentPage, commitSignatureChange]);

  // ── Canvas click handler — caret-based, no boxes ──
  const handleCanvasClick = useCallback(async (e: React.MouseEvent) => {
    if (!renderResult || !doc) return;
    const wrapper = canvasContainerRef.current;
    if (!wrapper) return;
    const rect = wrapper.getBoundingClientRect();
    const cssX = e.clientX - rect.left;
    const cssY = e.clientY - rect.top;
    const page = doc.pages[currentPage];
    const { mediaBox } = page;
    const { pdfX, pdfY } = canvasToPdf(
      cssX, cssY, scale,
      renderResult.pageWidth, renderResult.pageHeight,
      mediaBox.x, mediaBox.y, page.rotate, page.cropBox.x, page.cropBox.y,
    );

    if (activeTool === 'text' || activeTool === 'select') {
      if (blurTimeoutRef.current) {
        clearTimeout(blurTimeoutRef.current);
        blurTimeoutRef.current = null;
      }

      // Signature hit-test (above page contents)
      {
        const sigHit = hitTestSignature(signaturesRef.current, currentPage, pdfX, pdfY);
        if (sigHit) {
          if (editingLine && !await handleEditSubmit(false)) return;
          setSelectedSignatureId(sigHit.id);
          setSelectedDisplayItem(null);
          setSelectedLine(null);
          setActiveTool('sign');
          return;
        }
      }

      // Click a form field box → select it for editing
      if (formFields.length > 0 && engineRef.current) {
        const formHit = engineRef.current.hitTestFormField(formFields, pdfX, pdfY);
        if (formHit) {
          if (editingLine && !await handleEditSubmit(false)) return;
          await handleFormFieldSelect(formHit);
          return;
        }
      }

      // Ctrl/Cmd+click opens an existing link (Acrobat-like)
      if ((e.ctrlKey || e.metaKey) && engineRef.current) {
        const linkHit = engineRef.current.hitTestPageLink(doc, currentPage, pdfX, pdfY);
        if (linkHit?.url) {
          if (openDocumentLink(linkHit.url) === 'blocked') setError('This document link cannot be opened safely.');
          return;
        }
      }

      // Click a highlighted link → open hover/edit popover on the PDF
      if (linksHighlighted && engineRef.current) {
        const linkHit = engineRef.current.hitTestPageLink(doc, currentPage, pdfX, pdfY);
        if (linkHit) {
          if (editingLine && !await handleEditSubmit(false)) return;
          setSelectedLine(null);
          setSelectedDisplayItem(null);
          setLinkCreatePending(false);
          setSelectedLink(linkHit);
          setLinkDraftUrl(linkHit.url || '');
          setLinkDisplayDraft(resolveLinkDisplay(linkHit).text);
          setLinkPopoverMode('hover');
          return;
        }
        // Click outside any link while a popover is open → dismiss it
        if (linkPopoverMode) {
          setLinkPopoverMode(null);
          setSelectedLink(null);
          setLinkDraftUrl('');
          setLinkDisplayDraft('');
        }
      }

      // Prefer real flow lines (sourceInstructionIndices) — never edit synthetic Bloom lines
      const startEditOnLine = (line: TextLine, newCaret: number) => {
        const flowLine = findMatchingFlowLine(line, renderResult.textLines) ?? line;
        const caret = Math.min(newCaret, flowLine.text.length);
        if (editingLine?.id === flowLine.id) {
          setCaretPos(caret);
          editSelRef.current = { start: caret, end: caret };
          setEditSel({ start: caret, end: caret });
          caretVisibleRef.current = true;
          setTimeout(() => {
            if (hiddenInputRef.current) {
              hiddenInputRef.current.focus({ preventScroll: true });
              hiddenInputRef.current.setSelectionRange(caret, caret);
            }
          }, 0);
          return;
        }
        const startNew = () => {
          beginEditSession(flowLine, caret);
          setTimeout(() => {
            if (hiddenInputRef.current) {
              hiddenInputRef.current.focus({ preventScroll: true });
              hiddenInputRef.current.setSelectionRange(caret, caret);
            }
          }, 0);
        };
        if (editingLine) {
          void handleEditSubmit(false).then(committed => { if (committed) startNew(); });
        } else {
          startNew();
        }
      };

      const hit = hitTestTextLine(pdfX, pdfY, renderResult.textLines);
      if (hit) {
        startEditOnLine(hit, caretIndexFromLineX(pdfX, hit));
        return;
      }

      const nearHit = findNearestTextLine(pdfX, pdfY, renderResult.textLines, 12);
      if (nearHit) {
        startEditOnLine(nearHit, caretIndexFromLineX(pdfX, nearHit));
        return;
      }

      {
        const spatialHit = spatialIndexRef.current
          ? hitTestDisplayList(spatialIndexRef.current, pdfX, pdfY)
          : null;
        const itemHit = spatialHit && (spatialHit.data.type === 'image' || spatialHit.data.type === 'path')
          ? spatialHit.data as ImageItem | PathItem
          : null;
        if (itemHit) {
          if (editingLine && !await handleEditSubmit()) return;
          setSelectedDisplayItem(itemHit);
          setSelectedLine(null);
          setEditingLine(null);
          setActiveTool('select');
          return;
        }
        setSelectedDisplayItem(null);
        if (editingLine) {
          if (!await handleEditSubmit()) return;
        } else {
          setEditingLine(null);
          setSelectedLine(null);
        }
        setActiveFloatingTextId(null);
        setActiveFloatingImageId(null);
        setSelectedSignatureId(null);
      }
    } else if (activeTool === 'addtext') {
      if (blurTimeoutRef.current) {
        clearTimeout(blurTimeoutRef.current);
        blurTimeoutRef.current = null;
      }

      if (!doc || !renderResult) return;
      const page = doc.pages[currentPage];

      const newBox: FloatingText = {
        id: Math.random().toString(36).substr(2, 9),
        pageKey: page.ref.toKey(),
        pdfX,
        pdfY,
        text: 'New Text',
        fontSize: textFontSize,
        fontFamily: textFontFamily,
        color: textColor,
        bold: textBold,
        italic: textItalic,
        underline: textUnderline,
        opacity: textOpacity / 100,
      };

      const nextTexts = [...floatingTextsRef.current, newBox];
      pendingFloatingTextSelectionRef.current = newBox.id;
      setFloatingTexts(nextTexts);
      floatingTextsRef.current = nextTexts;
      pushEditorHistory('add-text-box', { floatingTexts: nextTexts });
      setActiveFloatingTextId(newBox.id);
      setActiveTool('text');

    } else if (activeTool === 'highlight') {
      // Freehand drag already created a stroke — don't also add a full-line PDF bar
      if (skipNextHighlightClickRef.current) {
        skipNextHighlightClickRef.current = false;
        return;
      }
      const hit = hitTestTextLine(pdfX, pdfY, renderResult.textLines);
      if (hit && hit.runs[0] && engineRef.current && doc) {
        const lease = documentOwnerRef.current.lease(doc);
        setSelectedLine(hit);
        try {
          const engine = engineRef.current;
          await sessionEditorRef.current.edit(doc, 'highlight', async staged => {
            engine.addHighlightFromLineSelection(
              staged,
              currentPage,
              hit,
              0,
              hit.text.length,
              hexToRGB(highlightColor),
              'Highlight',
            );
          }, { isCurrent: lease.isCurrent });
          if (!lease.isCurrent()) return;
          pushEditorHistory('highlight', undefined, undefined, false, sessionEditorRef.current);
          sessionEditorRef.current = new SessionDocumentEditor();
          setIsDirty(true);
          setRenderKey(k => k + 1);
          setThumbnailKey(k => k + 1);
        } catch (err) {
          console.warn('[Editor] Highlight annotation failed:', err);
        }
      }
    } else if (activeTool === 'sign') {
      // Click existing PDF signature field → place library signature into /AP
      const pdfSigHit = hitTestSignatureField(pdfSignatureFields, pdfX, pdfY);
      if (pdfSigHit) {
        setSelectedPdfSigFieldId(pdfSigHit.id);
        setSelectedSignatureId(null);
        setSelectedDisplayItem(null);
        void placeLibrarySignatureIntoField(pdfSigHit);
        return;
      }

      // Select existing visual overlay signature
      const hit = hitTestSignature(signaturesRef.current, currentPage, pdfX, pdfY);
      if (hit) {
        setSelectedSignatureId(hit.id);
        setSelectedDisplayItem(null);
        setSelectedPdfSigFieldId(null);
        return;
      }

      // Fields and existing signatures take priority over placing a new one.
      setSelectedSignatureId(null);
      setSelectedPdfSigFieldId(null);
      if (activeLibraryId) await placeLibrarySignatureAt(activeLibraryId, pdfX, pdfY);
    }
  }, [renderResult, doc, currentPage, scale, activeTool, editingLine, handleEditSubmit, beginEditSession, displayItems, textFontSize, textColor, textFontFamily, highlightColor, formFields, handleFormFieldSelect, linksHighlighted, linkPopoverMode, resolveLinkDisplay, pdfSignatureFields, placeLibrarySignatureIntoField, activeLibraryId, placeLibrarySignatureAt, pushEditorHistory, setThumbnailKey]);

  // Double-click in select mode → enter text edit
  const handleCanvasDoubleClick = useCallback((e: React.MouseEvent) => {
    if (activeTool !== 'select' && activeTool !== 'text') return;
    if (!renderResult || !doc) return;
    const wrapper = canvasContainerRef.current;
    if (!wrapper) return;
    const rect = wrapper.getBoundingClientRect();
    const cssX = e.clientX - rect.left;
    const cssY = e.clientY - rect.top;
    const page = doc.pages[currentPage];
    const { mediaBox } = page;
    const { pdfX, pdfY } = canvasToPdf(
      cssX, cssY, scale,
      renderResult.pageWidth, renderResult.pageHeight,
      mediaBox.x, mediaBox.y, page.rotate, page.cropBox.x, page.cropBox.y,
    );
    const hit =
      hitTestTextLine(pdfX, pdfY, renderResult.textLines) ??
      findNearestTextLine(pdfX, pdfY, renderResult.textLines, 16);
    if (hit) {
      if (blurTimeoutRef.current) {
        clearTimeout(blurTimeoutRef.current);
        blurTimeoutRef.current = null;
      }
      const flowLine = findMatchingFlowLine(hit, renderResult.textLines) ?? hit;
      const newCaret = caretIndexFromLineX(pdfX, flowLine);
      if (editingLine && editingLine.id !== flowLine.id) {
        void handleEditSubmit(false).then(committed => {
          if (committed) beginEditSession(flowLine, newCaret);
        });
        return;
      }
      beginEditSession(flowLine, newCaret);
      setTimeout(() => {
        if (hiddenInputRef.current) {
          hiddenInputRef.current.focus({ preventScroll: true });
          hiddenInputRef.current.setSelectionRange(newCaret, newCaret);
        }
      }, 0);
    }
  }, [renderResult, doc, currentPage, scale, activeTool, editingLine, handleEditSubmit, beginEditSession]);

  const handleSignatureDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault();
    const signatureId =
      e.dataTransfer.getData('application/x-signature-id') ||
      e.dataTransfer.getData('text/plain');
    if (!signatureId || !doc || !renderResult) return;

    const canvasContainer = canvasContainerRef.current;
    if (!canvasContainer) return;
    const rect = canvasContainer.getBoundingClientRect();
    const cssX = e.clientX - rect.left;
    const cssY = e.clientY - rect.top;

    const page = doc.pages[currentPage];
    if (!page) return;
    const { mediaBox } = page;
    const { pdfX, pdfY } = canvasToPdf(
      cssX, cssY, scale,
      renderResult.pageWidth, renderResult.pageHeight,
      mediaBox.x, mediaBox.y, page.rotate, page.cropBox.x, page.cropBox.y,
    );

    await placeLibrarySignatureAt(signatureId, pdfX, pdfY);
  }, [doc, renderResult, currentPage, scale, placeLibrarySignatureAt]);

  const applyEraser = useCallback((x: number, y: number, opts?: { deferAnnotRender?: boolean }) => {
    const eraserRadius = eraserSize / 2;

    // 1) Erase ephemeral overlay strokes / shapes
    setDrawnPaths(prev => {
      const newPaths: DrawnPath[] = [];
      let modified = false;
      for (const path of prev) {
        if (path.pageKey !== doc?.pages[currentPage]?.ref.toKey()) {
          newPaths.push(path);
          continue;
        }
        const ratio = (path.captureScale ?? scale) / scale;
        const pathX = x * ratio;
        const pathY = y * ratio;
        const pathRadius = eraserRadius * ratio;
        const kind = path.kind ?? 'freehand';
        if (kind !== 'freehand' && path.start && path.end) {
          // Hit-test shapes by proximity to geometry
          let hit = false;
          if (kind === 'line' || kind === 'arrow') {
            const { start, end } = path;
            const dx = end.x - start.x;
            const dy = end.y - start.y;
            const len2 = dx * dx + dy * dy;
            let t = len2 < 1e-8 ? 0 : ((pathX - start.x) * dx + (pathY - start.y) * dy) / len2;
            t = Math.max(0, Math.min(1, t));
            const dist = Math.hypot(pathX - (start.x + t * dx), pathY - (start.y + t * dy));
            hit = dist <= pathRadius;
          } else {
            const minX = Math.min(path.start.x, path.end.x) - pathRadius;
            const maxX = Math.max(path.start.x, path.end.x) + pathRadius;
            const minY = Math.min(path.start.y, path.end.y) - pathRadius;
            const maxY = Math.max(path.start.y, path.end.y) + pathRadius;
            hit = pathX >= minX && pathX <= maxX && pathY >= minY && pathY <= maxY;
          }
          if (hit) {
            modified = true;
            eraseChangedRef.current = true;
          } else {
            newPaths.push(path);
          }
          continue;
        }

        let currentSubPath: { x: number, y: number }[] = [];
        for (const p of path.points) {
          const dx = p.x - pathX;
          const dy = p.y - pathY;
          if (Math.sqrt(dx * dx + dy * dy) > pathRadius) {
            currentSubPath.push(p);
          } else {
            if (currentSubPath.length > 0) {
              newPaths.push({ ...path, id: Math.random().toString(36).substr(2, 9), points: currentSubPath });
              currentSubPath = [];
              modified = true;
              eraseChangedRef.current = true;
            }
          }
        }
        if (currentSubPath.length > 0) {
          if (currentSubPath.length === path.points.length) {
            newPaths.push(path);
          } else {
            newPaths.push({ ...path, id: Math.random().toString(36).substr(2, 9), points: currentSubPath });
            modified = true;
            eraseChangedRef.current = true;
          }
        }
      }
      if (modified) drawnPathsRef.current = newPaths;
      return modified ? newPaths : prev;
    });

    // 2) Erase committed PDF Highlight / Ink annotations under the cursor
    if (doc && engineRef.current && renderResult) {
      const page = doc.pages[currentPage];
      const { mediaBox } = page;
      const { pdfX, pdfY } = canvasToPdf(
        x, y, scale,
        renderResult.pageWidth, renderResult.pageHeight,
        mediaBox.x, mediaBox.y, page.rotate, page.cropBox.x, page.cropBox.y,
      );
      const pdfRadius = eraserRadius / scale;
      const { transactional, legacy } = collectDrawingRemovals(doc, currentPage, (dict, objects) =>
        engineRef.current!.eraseAnnotationsAtPoint(dict, objects, pdfX, pdfY, Math.max(pdfRadius, 4)));
      const previousHits = erasedAnnotationsRef.current.size;
      for (const ref of transactional) erasedAnnotationsRef.current.set(ref.toKey(), ref);
      removeMarkupReferences(doc, currentPage, legacy);
      const removed = legacy.length;
      if (removed > 0) {
        eraseChangedRef.current = true;
        if (!opts?.deferAnnotRender) {
          setIsDirty(true);
          setRenderKey(k => k + 1);
        }
      }
      return removed + erasedAnnotationsRef.current.size - previousHits;
    }
    return 0;
  }, [eraserSize, doc, currentPage, scale, renderResult]);

  /** Sample eraser along a segment so fast strokes don't skip marks. */
  const applyEraserStroke = useCallback((from: { x: number; y: number } | null, to: { x: number; y: number }) => {
    const eraserRadius = eraserSize / 2;
    const step = Math.max(2, eraserRadius * 0.35);
    let removed = 0;
    if (!from) {
      removed += applyEraser(to.x, to.y, { deferAnnotRender: true }) || 0;
      return removed;
    }
    const dist = Math.hypot(to.x - from.x, to.y - from.y);
    const steps = Math.max(1, Math.ceil(dist / step));
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const x = from.x + (to.x - from.x) * t;
      const y = from.y + (to.y - from.y) * t;
      removed += applyEraser(x, y, { deferAnnotRender: true }) || 0;
    }
    return removed;
  }, [applyEraser, eraserSize]);

  const buildDrawingAnnotations = useCallback((paths: DrawnPath[], pageIndex = currentPage): Annotation[] => {
    if (!doc) return [];
    const page = doc.pages[pageIndex];
    const annotations: Annotation[] = [];
    const rotated = ((page.rotate % 180) + 180) % 180 !== 0;
    const pageWidth = rotated ? page.cropBox.height : page.cropBox.width;
    const pageHeight = rotated ? page.cropBox.width : page.cropBox.height;

    for (const p of paths) {
      const pathScale = p.captureScale ?? scale;
      const toPdf = (cx: number, cy: number) => canvasToPdf(
        cx, cy, pathScale, pageWidth, pageHeight,
        page.mediaBox.x, page.mediaBox.y, page.rotate, page.cropBox.x, page.cropBox.y,
      );
      const kind = p.kind ?? 'freehand';
      const lw = p.size / pathScale;
      const rgb = hexToRGB(p.color);

      let annotation: Annotation | null = null;

      if (kind !== 'freehand' && p.start && p.end) {
        const a = toPdf(p.start.x, p.start.y);
        const b = toPdf(p.end.x, p.end.y);
        if (kind === 'line' || kind === 'arrow') {
          const minX = Math.min(a.pdfX, b.pdfX);
          const minY = Math.min(a.pdfY, b.pdfY);
          const maxX = Math.max(a.pdfX, b.pdfX);
          const maxY = Math.max(a.pdfY, b.pdfY);
          const pad = Math.max(lw * 4, 8);
          annotation = {
            type: 'Line',
            rect: { x: minX - pad, y: minY - pad, width: (maxX - minX) + pad * 2, height: (maxY - minY) + pad * 2 },
            color: rgb,
            opacity: 1,
            x1: a.pdfX,
            y1: a.pdfY,
            x2: b.pdfX,
            y2: b.pdfY,
            lineWidth: lw,
            startStyle: 'None',
            endStyle: kind === 'arrow' ? 'OpenArrow' : 'None',
          };
        } else if (kind === 'rectangle') {
          const minX = Math.min(a.pdfX, b.pdfX);
          const minY = Math.min(a.pdfY, b.pdfY);
          const maxX = Math.max(a.pdfX, b.pdfX);
          const maxY = Math.max(a.pdfY, b.pdfY);
          annotation = {
            type: 'Square',
            rect: { x: minX, y: minY, width: Math.max(maxX - minX, lw), height: Math.max(maxY - minY, lw) },
            color: rgb,
            opacity: 1,
            lineWidth: lw,
            fillColor: null,
          };
        } else if (kind === 'ellipse') {
          const minX = Math.min(a.pdfX, b.pdfX);
          const minY = Math.min(a.pdfY, b.pdfY);
          const maxX = Math.max(a.pdfX, b.pdfX);
          const maxY = Math.max(a.pdfY, b.pdfY);
          annotation = {
            type: 'Circle',
            rect: { x: minX, y: minY, width: Math.max(maxX - minX, lw), height: Math.max(maxY - minY, lw) },
            color: rgb,
            opacity: 1,
            lineWidth: lw,
            fillColor: null,
          };
        }
      } else {
        if (p.points.length < 2) continue;
        const inkPathsPdf: number[][] = [[]];
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const pt of p.points) {
          const { pdfX, pdfY } = toPdf(pt.x, pt.y);
          inkPathsPdf[0].push(pdfX, pdfY);
          minX = Math.min(minX, pdfX);
          minY = Math.min(minY, pdfY);
          maxX = Math.max(maxX, pdfX);
          maxY = Math.max(maxY, pdfY);
        }
        annotation = {
          type: 'Ink',
          rect: { x: minX - lw, y: minY - lw, width: (maxX - minX) + lw * 2, height: (maxY - minY) + lw * 2 },
          color: rgb,
          opacity: p.type === 'highlight' ? 0.4 : 1.0,
          inkPaths: inkPathsPdf,
          lineWidth: lw,
        };
      }

      if (annotation) annotations.push(annotation);
    }
    return annotations;
  }, [doc, currentPage, scale]);

  const commitDrawPath = useCallback(async (path: DrawnPath, label: string) => {
    if (!doc || !engineRef.current) return;
    const lease = documentOwnerRef.current.lease(doc);
    const preview = [...drawnPathsRef.current, path];
    drawnPathsRef.current = preview;
    setDrawnPaths(preview);
    const editor = new SessionDocumentEditor();
    const commit = Promise.resolve().then(async () => {
      try {
        const annotations = buildDrawingAnnotations([path]);
        await editor.edit(doc, label, async staged => { addDrawingAnnotations(staged, currentPage, annotations); }, { isCurrent: lease.isCurrent });
        if (!lease.isCurrent()) return;
        const remaining = drawnPathsRef.current.filter(item => item.id !== path.id);
        drawnPathsRef.current = remaining;
        setDrawnPaths(remaining);
        pushEditorHistory(label, { drawnPaths: remaining }, undefined, false, editor);
        setIsDirty(true);
        setThumbnailKey(k => k + 1);
      } catch (error) {
        if (!lease.isCurrent()) return;
        // Keep the uncommitted overlay for retry at the existing bake boundary.
        console.warn('[Editor] Drawing annotation failed:', error);
        setError(error instanceof Error ? error.message : 'Drawing annotation failed');
      } finally {
        if (annotationCommitPendingRef.current === commit) annotationCommitPendingRef.current = null;
        if (lease.isCurrent()) setRenderKey(k => k + 1);
      }
    });
    annotationCommitPendingRef.current = commit;
    await commit;
  }, [doc, currentPage, buildDrawingAnnotations, pushEditorHistory, setThumbnailKey]);

  // ── Commit drawings, texts, and images to their owning PDF pages ──
  const commitDrawingsToPdf = useCallback(async (pathsToCommit?: DrawnPath[], textsToCommit?: FloatingText[], imagesToCommit?: FloatingImage[]) => {
    if (!doc || !engineRef.current) return;
    const lease = documentOwnerRef.current.lease(doc);
    const requireCurrent = () => {
      if (!lease.isCurrent()) throw new Error('The document was replaced before committing overlays.');
    };
    await annotationCommitPendingRef.current;
    await documentOwnerRef.current.whenIdle();
    requireCurrent();
    const paths = pathsToCommit ?? drawnPathsRef.current;
    const texts = textsToCommit ?? floatingTextsRef.current;
    const images = imagesToCommit ?? floatingImagesRef.current;
    const pageKeys = doc.pages.map(page => page.ref.toKey());
    const groups = pageOverlayGroups({ drawnPaths: paths, floatingTexts: texts, floatingImages: images }, pageKeys);
    const signatures = signaturesRef.current;
    const pathsUnchanged = snapshotOverlayItems(paths);
    const textsUnchanged = snapshotOverlayItems(texts);
    const imagesUnchanged = snapshotOverlayItems(images);
    const signaturesUnchanged = snapshotOverlayItems(signatures);
    const isCommitCurrent = () => lease.isCurrent() &&
      pathsUnchanged(drawnPathsRef.current) && textsUnchanged(floatingTextsRef.current) &&
      imagesUnchanged(floatingImagesRef.current) && signaturesUnchanged(signaturesRef.current);
    const nativeSignatures = findVisualSignatureRefs(doc, new Set(signatures.map(signature => signature.id)));
    const uncommittedSignatures = signatures.filter(signature => !nativeSignatures.has(signature.id));
    for (const signature of signatures) {
      if (!doc.pages[signature.pageIndex]) throw new Error('A recovered signature has no valid page. Its local recovery is preserved; restore an intact backup before saving.');
    }
    for (const signature of uncommittedSignatures) {
      if (!groups.has(signature.pageIndex)) groups.set(signature.pageIndex, { drawnPaths: [], floatingTexts: [], floatingImages: [] });
    }
    if (groups.size === 0) return;
    const engine = engineRef.current;
    for (const [pageIndex, group] of groups) {
      await prepareExportText(group.floatingTexts.map(text => text.text).join('\n'), undefined, doc, pageIndex);
      if (!isCommitCurrent()) throw new Error('Overlays changed during save. Your latest edits remain available; try again.');
    }

    // All pages are staged together: a failure cannot leave a partially baked overlay.
    const editor = new SessionDocumentEditor();
    await queueNativeEdit(doc, async isCurrent => editor.edit(doc, 'commit-overlays', async staged => {
      for (const [pageIndex, group] of groups) {
        const page = staged.pages[pageIndex];
        const annotations = buildDrawingAnnotations(group.drawnPaths, pageIndex);
        if (annotations.length) addDrawingAnnotations(staged, pageIndex, annotations);
        if (group.floatingTexts.length || group.floatingImages.length) {
          let bytes = engine.getPageContentBytes(page, staged.objects);
          await prepareExportText(group.floatingTexts.map(text => text.text).join('\n'), undefined, staged, pageIndex);
          for (const text of group.floatingTexts) {
            if (!text.text.trim()) continue;
            bytes = engine.insertTextRun(bytes, page, staged.objects,
              text.text, text.pdfX, text.pdfY, text.fontSize, hexToRGB(text.color),
              { fontFamily: text.fontFamily, bold: text.bold, italic: text.italic,
                underline: text.underline, opacity: text.opacity, width: text.pdfWidth });
          }
          for (const image of group.floatingImages) {
            let nextObjectNumber = engine.getNextObjNum(staged);
            const result = await engine.insertImageRun(bytes, page, staged.objects,
              image.dataUrl, image.pdfX, image.pdfY, image.pdfWidth, image.pdfHeight,
              () => nextObjectNumber++);
            bytes = result.newContentBytes;
          }
          await engine.updatePageContent(page.contentRefs, bytes, staged.objects);
        }
        for (const signature of uncommittedSignatures) {
          if (signature.pageIndex !== pageIndex) continue;
          const image = signature.appearanceImageDataUrl ?? getSignatureLibrary().get(signature.appearanceId)?.imageDataUrl;
          if (!image) throw new Error('Signature appearance is unavailable');
          await placeVisualSignature(staged, signature, image);
        }
      }
    }, { isCurrent: () => isCurrent() && isCommitCurrent() }));
    if (!isCommitCurrent()) throw new Error('Overlays changed during save. Your latest edits remain available; try again.');

    const pathIds = new Set(paths.map(path => path.id));
    const textIds = new Set(texts.map(text => text.id));
    const imageIds = new Set(images.map(image => image.id));
    const remaining = {
      drawnPaths: drawnPathsRef.current.filter(path => !pathIds.has(path.id)),
      floatingTexts: floatingTextsRef.current.filter(text => !textIds.has(text.id)),
      floatingImages: floatingImagesRef.current.filter(image => !imageIds.has(image.id)),
      signatures: signaturesRef.current,
    };
    drawnPathsRef.current = remaining.drawnPaths;
    floatingTextsRef.current = remaining.floatingTexts;
    floatingImagesRef.current = remaining.floatingImages;
    signaturesRef.current = remaining.signatures;
    setDrawnPaths(remaining.drawnPaths);
    setFloatingTexts(remaining.floatingTexts);
    setFloatingImages(remaining.floatingImages);
    setSignatures(remaining.signatures);
    setActiveFloatingTextId(null);
    setActiveFloatingImageId(null);
    pushEditorHistory('commit-drawings', remaining, undefined, true, editor);
    setIsDirty(true);
    setRenderKey(k => k + 1);
    setThumbnailKey(k => k + 1);
  }, [doc, pushEditorHistory, prepareExportText, buildDrawingAnnotations, queueNativeEdit, setThumbnailKey]);

  const strokeShapePreview = useCallback((
    ctx: CanvasRenderingContext2D,
    kind: DrawMode,
    start: { x: number; y: number },
    end: { x: number; y: number },
    color: string,
    size: number,
  ) => {
    ctx.strokeStyle = color;
    ctx.lineWidth = size;
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    if (kind === 'line' || kind === 'arrow') {
      ctx.beginPath();
      ctx.moveTo(start.x, start.y);
      ctx.lineTo(end.x, end.y);
      ctx.stroke();
      if (kind === 'arrow') {
        const angle = Math.atan2(end.y - start.y, end.x - start.x);
        const head = Math.max(size * 4, 10);
        ctx.beginPath();
        ctx.moveTo(end.x, end.y);
        ctx.lineTo(end.x - head * Math.cos(angle - 0.4), end.y - head * Math.sin(angle - 0.4));
        ctx.moveTo(end.x, end.y);
        ctx.lineTo(end.x - head * Math.cos(angle + 0.4), end.y - head * Math.sin(angle + 0.4));
        ctx.stroke();
      }
    } else if (kind === 'rectangle') {
      const x = Math.min(start.x, end.x);
      const y = Math.min(start.y, end.y);
      const w = Math.abs(end.x - start.x);
      const h = Math.abs(end.y - start.y);
      ctx.strokeRect(x, y, w, h);
    } else if (kind === 'ellipse') {
      const cx = (start.x + end.x) / 2;
      const cy = (start.y + end.y) / 2;
      const rx = Math.abs(end.x - start.x) / 2;
      const ry = Math.abs(end.y - start.y) / 2;
      ctx.beginPath();
      ctx.ellipse(cx, cy, Math.max(rx, 0.5), Math.max(ry, 0.5), 0, 0, Math.PI * 2);
      ctx.stroke();
    }
  }, []);

  const handleDrawStart = useCallback((e: React.PointerEvent) => {
    if (activeTool !== 'draw' && activeTool !== 'highlight' && activeTool !== 'erase') return false;
    if (annotationCommitPendingRef.current || historyBusyRef.current) return false;
    const overlay = overlayRef.current;
    if (!overlay) return false;

    const rect = overlay.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    isDrawingRef.current = true;
    setIsDrawing(true);
    drawDraggedRef.current = false;
    eraseChangedRef.current = false;

    if (activeTool === 'erase') {
      lastErasePosRef.current = { x, y };
      const removed = applyEraserStroke(null, { x, y });
      if (removed > 0) {
        if (eraseChangedRef.current) setIsDirty(true);
        setRenderKey(k => k + 1);
      }
    } else if (activeTool === 'draw' && drawMode !== 'freehand') {
      lastErasePosRef.current = null;
      shapeStartRef.current = { x, y };
      shapeEndRef.current = { x, y };
      currentDrawPath.current = [];
    } else {
      lastErasePosRef.current = null;
      shapeStartRef.current = null;
      shapeEndRef.current = null;
      currentDrawPath.current = [{ x, y }];
    }
    return true;
  }, [activeTool, applyEraserStroke, drawMode]);

  const handleDrawMove = useCallback((e: React.PointerEvent) => {
    if (!isDrawingRef.current) return;
    const overlay = overlayRef.current;
    if (!overlay) return;

    const rect = overlay.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    if (activeTool === 'erase') {
      const removed = applyEraserStroke(lastErasePosRef.current, { x, y });
      lastErasePosRef.current = { x, y };
      if (removed > 0) {
        if (eraseChangedRef.current) setIsDirty(true);
        setRenderKey(k => k + 1);
      }
      return;
    }

    // Shape drag preview
    if (activeTool === 'draw' && drawMode !== 'freehand' && shapeStartRef.current) {
      if (Math.hypot(x - shapeStartRef.current.x, y - shapeStartRef.current.y) > 5) {
        drawDraggedRef.current = true;
      }
      shapeEndRef.current = { x, y };
      drawOverlay();
      const ctx = overlay.getContext('2d');
      if (ctx && drawDraggedRef.current) {
        const dpr = window.devicePixelRatio || 1;
        ctx.save();
        ctx.scale(dpr, dpr);
        strokeShapePreview(ctx, drawMode, shapeStartRef.current, { x, y }, drawColor, drawSize);
        ctx.restore();
      }
      return;
    }

    const path = currentDrawPath.current;
    if (path.length > 0) {
      const dx = x - path[0].x;
      const dy = y - path[0].y;
      if (Math.hypot(dx, dy) > 5) drawDraggedRef.current = true;
    }
    // Ignore tiny jitter so a click doesn't become a freehand highlight stroke
    if (!drawDraggedRef.current) return;

    currentDrawPath.current.push({ x, y });

    // Live draw on overlay
    const ctx = overlay.getContext('2d');
    if (ctx) {
      const dpr = window.devicePixelRatio || 1;
      const pts = currentDrawPath.current;
      if (pts.length >= 2) {
        ctx.save();
        ctx.scale(dpr, dpr);
        if (activeTool === 'highlight') {
          ctx.strokeStyle = highlightColor;
          ctx.lineWidth = highlightSize;
          ctx.globalCompositeOperation = 'multiply';
          ctx.globalAlpha = 0.35;
          ctx.lineCap = 'butt';
          ctx.lineJoin = 'round';
        } else {
          ctx.strokeStyle = drawColor;
          ctx.lineWidth = drawSize;
          ctx.globalCompositeOperation = 'source-over';
          ctx.globalAlpha = 1.0;
          ctx.lineCap = 'round';
          ctx.lineJoin = 'round';
        }
        ctx.beginPath();
        const prev = pts[pts.length - 2];
        ctx.moveTo(prev.x, prev.y);
        ctx.lineTo(x, y);
        ctx.stroke();
        ctx.restore();
      }
    }
  }, [activeTool, drawMode, drawColor, drawSize, highlightColor, highlightSize, applyEraserStroke, strokeShapePreview, drawOverlay]);

  const handleDrawEnd = useCallback(async (willClick: boolean) => {
    if (!isDrawingRef.current) return;
    isDrawingRef.current = false;
    setIsDrawing(false);
    lastErasePosRef.current = null;

    if (activeTool === 'erase') {
      if (annotationCommitPendingRef.current) return;
      const legacyChanged = eraseChangedRef.current;
      const pending = erasedAnnotationsRef.current;
      const refs = [...pending.values()];
      eraseChangedRef.current = false;
      if (legacyChanged) pushEditorHistory('erase');
      if (doc && refs.length > 0) {
        const lease = documentOwnerRef.current.lease(doc);
        const editor = new SessionDocumentEditor();
        const commit = Promise.resolve().then(async () => {
          try {
            await editor.edit(doc, 'erase', async staged => { removeMarkupReferences(staged, currentPage, refs); }, { isCurrent: lease.isCurrent });
            if (!lease.isCurrent()) return;
            // Append to the legacy gesture rather than introducing a second undo step.
            pushEditorHistory('erase', undefined, undefined, legacyChanged, editor);
            setIsDirty(true);
            setThumbnailKey(k => k + 1);
          } catch (error) {
            console.warn('[Editor] Annotation erase failed:', error);
          } finally {
            if (lease.isCurrent() && erasedAnnotationsRef.current === pending) pending.clear();
            if (annotationCommitPendingRef.current === commit) annotationCommitPendingRef.current = null;
            if (lease.isCurrent()) setRenderKey(k => k + 1);
          }
        });
        annotationCommitPendingRef.current = commit;
        await commit;
      }
      return;
    }

    // Shape placement
    if (activeTool === 'draw' && drawMode !== 'freehand' && shapeStartRef.current && shapeEndRef.current) {
      if (drawDraggedRef.current) {
        const start = shapeStartRef.current;
        const end = shapeEndRef.current;
        const newPath: DrawnPath = {
          id: Math.random().toString(36).substr(2, 9),
          pageKey: doc!.pages[currentPage].ref.toKey(),
          captureScale: scale,
          type: 'draw',
          kind: drawMode,
          color: drawColor,
          size: drawSize,
          points: [start, end],
          start,
          end,
        };
        await commitDrawPath(newPath, 'draw-shape');
      }
      shapeStartRef.current = null;
      shapeEndRef.current = null;
      drawDraggedRef.current = false;
      return;
    }

    if (drawDraggedRef.current && currentDrawPath.current.length > 1) {
      // Drag produced a freehand stroke — suppress the trailing click annotation
      if (activeTool === 'highlight' && willClick) {
        skipNextHighlightClickRef.current = true;
      }
      const newPath: DrawnPath = {
        id: Math.random().toString(36).substr(2, 9),
        pageKey: doc!.pages[currentPage].ref.toKey(),
        captureScale: scale,
        type: activeTool as PathType,
        kind: 'freehand',
        color: activeTool === 'draw' ? drawColor : highlightColor,
        size: activeTool === 'draw' ? drawSize : highlightSize,
        points: [...currentDrawPath.current],
      };

      await commitDrawPath(newPath, activeTool === 'highlight' ? 'highlight-stroke' : 'draw-stroke');
    }
    currentDrawPath.current = [];
    drawDraggedRef.current = false;
  }, [activeTool, drawMode, drawColor, drawSize, highlightColor, highlightSize, pushEditorHistory, doc, currentPage, scale, commitDrawPath, setThumbnailKey]);

  const drawingPointer = useDrawingPointer({
    enabled: !spacePanHeld && ['draw', 'highlight', 'erase'].includes(activeTool),
    start: handleDrawStart,
    move: handleDrawMove,
    end: handleDrawEnd,
  });

  const openLinkHover = useCallback((link: import('@/engine/browser-core').PageLinkInfo) => {
    if (linkHoverTimerRef.current) {
      clearTimeout(linkHoverTimerRef.current);
      linkHoverTimerRef.current = null;
    }
    // Already showing this link — don't reset state (avoids flicker / remount)
    if (
      selectedLink?.ref.toKey() === link.ref.toKey()
      && (linkPopoverMode === 'hover' || linkPopoverMode === 'edit')
    ) {
      return;
    }
    if (linkPopoverMode === 'edit') return;
    setSelectedLink(link);
    setLinkDraftUrl(link.url || '');
    setLinkDisplayDraft(resolveLinkDisplay(link).text);
    setLinkPopoverMode('hover');
  }, [linkPopoverMode, selectedLink, resolveLinkDisplay]);

  const scheduleLinkHoverClose = useCallback(() => {
    if (linkPopoverMode === 'edit') return;
    if (linkPopoverHoverRef.current) return;
    if (linkHoverTimerRef.current) clearTimeout(linkHoverTimerRef.current);
    linkHoverTimerRef.current = setTimeout(() => {
      linkHoverTimerRef.current = null;
      if (linkPopoverHoverRef.current) return;
      setLinkPopoverMode((mode) => {
        if (mode === 'hover') {
          setSelectedLink(null);
          return null;
        }
        return mode;
      });
    }, 700);
  }, [linkPopoverMode]);

  const handleCanvasMouseMove = useCallback((e: React.MouseEvent) => {
    if (!linksHighlighted || !doc || !engineRef.current || !renderResult || editingLine) return;
    if (linkPopoverMode === 'edit') return;
    if (['draw', 'highlight', 'erase'].includes(activeTool)) return;
    // Pointer is over the popover — keep it open
    if (linkPopoverHoverRef.current) return;

    const rect = canvasContainerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const cssX = e.clientX - rect.left;
    const cssY = e.clientY - rect.top;
    const page = doc.pages[currentPage];
    const { pdfX, pdfY } = canvasToPdf(
      cssX, cssY, scale,
      renderResult.pageWidth, renderResult.pageHeight,
      page.mediaBox.x, page.mediaBox.y,
    );
    const hit = engineRef.current.hitTestPageLink(doc, currentPage, pdfX, pdfY);
    if (hit) {
      openLinkHover(hit);
    } else if (linkPopoverMode === 'hover') {
      scheduleLinkHoverClose();
    }
  }, [
    linksHighlighted, doc, renderResult, editingLine,
    linkPopoverMode, activeTool, currentPage, scale, openLinkHover, scheduleLinkHoverClose,
  ]);

  const handleCanvasMouseLeave = useCallback((e: React.MouseEvent) => {
    const next = e.relatedTarget as HTMLElement | null;
    if (next?.closest?.('[data-link-popover]')) return;
    if (linkPopoverMode === 'hover' && !linkPopoverHoverRef.current) {
      scheduleLinkHoverClose();
    }
  }, [linkPopoverMode, scheduleLinkHoverClose]);

  const closeLinkPopover = useCallback(() => {
    if (linkHoverTimerRef.current) {
      clearTimeout(linkHoverTimerRef.current);
      linkHoverTimerRef.current = null;
    }
    setLinkPopoverMode(null);
    setSelectedLink(null);
    setLinkDraftUrl('');
    setLinkDisplayDraft('');
  }, []);

  const saveLinkFromPopover = useCallback(async (andClose = true) => {
    if (!doc || !engineRef.current || !selectedLink) {
      if (andClose) closeLinkPopover();
      return;
    }
    const url = linkDraftUrl.trim();
    if (!url || url === 'https://') {
      if (andClose) closeLinkPopover();
      return;
    }
    const lease = documentOwnerRef.current.lease(doc);

    try {
      const display = resolveLinkDisplay(selectedLink);
      const textChanged = !!display.line && linkDisplayDraft !== display.text && display.end > display.start;
      if (!textChanged && url === selectedLink.url) {
        if (andClose) closeLinkPopover();
        return;
      }
      const engine = engineRef.current;
      await queueNativeEdit(doc, async isCurrent => {
        const editor = new SessionDocumentEditor();
        await editor.edit(doc, 'edit-link', async staged => {
          const link = engine.listPageLinks(staged, currentPage).find(item => item.ref.toKey() === selectedLink.ref.toKey());
          if (!link) throw new Error('Link is unavailable');
          if (textChanged && display.line) {
            const line = display.line;
            const nextText = line.text.slice(0, display.start) + linkDisplayDraft + line.text.slice(display.end);
            const page = staged.pages[currentPage];
            const bytes = engine.getPageContentBytes(page, staged.objects);
            const result = engine.applyLineTextEdit(bytes, page, staged.objects, line, nextText, renderResult?.documentFlow,
              { optionalContent: new engine.OptionalContentVisibility(staged.catalog, staged.objects) });
            await engine.updatePageContent(page.contentRefs, result.newContentBytes, staged.objects);
          }
          if (url !== link.url) engine.updatePageLinkUrl(staged, currentPage, link, url);
        }, { isCurrent });
        if (!isCurrent()) throw new Error('The document was replaced before the link edit completed.');
        pushEditorHistory('edit-link', undefined, undefined, false, editor);
      });
      if (!lease.isCurrent()) return;
      setIsDirty(true);
      setRenderKey(k => k + 1);
      setThumbnailKey(k => k + 1);
      if (andClose) closeLinkPopover();
    } catch (err) {
      console.warn('[Editor] Save link failed:', err);
      setError(`Save link failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, [
    doc, selectedLink, linkDraftUrl, linkDisplayDraft, resolveLinkDisplay,
    currentPage, renderResult, closeLinkPopover, queueNativeEdit, pushEditorHistory,
    setThumbnailKey,
  ]);

  const removeLinkFromPopover = useCallback(async () => {
    if (!doc || !engineRef.current || !selectedLink) {
      closeLinkPopover();
      return;
    }
    const lease = documentOwnerRef.current.lease(doc);
    try {
      const engine = engineRef.current;
      await queueNativeEdit(doc, async isCurrent => {
        const editor = new SessionDocumentEditor();
        await editor.edit(doc, 'remove-link', async staged => {
          const link = engine.listPageLinks(staged, currentPage).find(item => item.ref.toKey() === selectedLink.ref.toKey());
          if (!link) throw new Error('Link is unavailable');
          engine.removePageLink(staged, currentPage, link.ref);
        }, { isCurrent });
        if (!isCurrent()) throw new Error('The document was replaced before link removal completed.');
        pushEditorHistory('remove-link', undefined, undefined, false, editor);
      });
      if (!lease.isCurrent()) return;
      setIsDirty(true);
      setRenderKey(k => k + 1);
      setThumbnailKey(k => k + 1);
      closeLinkPopover();
    } catch (err) {
      console.warn('[Editor] Remove link failed:', err);
      setError(`Remove link failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, [doc, selectedLink, currentPage, closeLinkPopover, queueNativeEdit, pushEditorHistory, setThumbnailKey]);

  const handleFloatingTextPointerDown = useCallback((e: React.PointerEvent, id: string) => {
    e.stopPropagation();
    const target = e.target as Element;
    const targetIsTextArea = target.closest('textarea') != null;
    const targetIsDragHandle = target.closest('[data-floating-text-drag-handle]') != null;
    const targetIsInteractiveControl = target.closest('button, a, input, select, option, [role="button"], [contenteditable="true"]') != null;
    const wrapper = e.currentTarget as HTMLElement;
    const wrapperRect = wrapper.getBoundingClientRect();
    if (!shouldStartFloatingTextDrag(
      e.pointerType,
      targetIsTextArea,
      targetIsDragHandle,
      targetIsInteractiveControl,
      { x: e.clientX, y: e.clientY },
      wrapperRect,
    )) return;
    setActiveFloatingTextId(id);
    setActiveFloatingImageId(null);
    const box = floatingTexts.find(b => b.id === id);
    if (!box) return;
    let didMove = false;
    let hasPointerCapture = false;
    const startX = e.clientX;
    const startY = e.clientY;
    dragInfo.current = {
      id,
      type: 'text',
      startX,
      startY,
      startPdfX: box.pdfX,
      startPdfY: box.pdfY
    };

    const handleMove = (me: PointerEvent) => {
      if (!dragInfo.current) return;
      const screenDx = me.clientX - startX;
      const screenDy = me.clientY - startY;
      if (!hasPointerCapture && Math.hypot(screenDx, screenDy) >= 4) {
        try {
          wrapper.setPointerCapture(e.pointerId);
          hasPointerCapture = true;
        } catch {
          // Pointer capture is unavailable in a few test DOM implementations.
        }
      }
      if (!doc || !renderResult) return;
      const { x: pdfDx, y: pdfDy } = floatingTextPdfDelta(
        { x: startX, y: startY },
        { x: me.clientX, y: me.clientY },
        scale,
      );

      const { startPdfX, startPdfY } = dragInfo.current;

      didMove = Math.abs(pdfDx) > 0.25 || Math.abs(pdfDy) > 0.25;
      setFloatingTexts(prev => prev.map(p => p.id === id ? {
        ...p,
        pdfX: startPdfX + pdfDx,
        pdfY: startPdfY + pdfDy,
      } : p));
    };

    const handleUp = () => {
      if (didMove) pushEditorHistory('move-text-box', { floatingTexts: floatingTextsRef.current });
      dragInfo.current = null;
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', handleUp);
      window.removeEventListener('pointercancel', handleUp);
      if (hasPointerCapture) {
        try {
          wrapper.releasePointerCapture(e.pointerId);
        } catch {
          // ignore
        }
      }
    };

    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', handleUp);
    window.addEventListener('pointercancel', handleUp);
  }, [floatingTexts, scale, doc, renderResult, pushEditorHistory]);

  const handleFloatingImagePointerDown = useCallback((e: React.PointerEvent, id: string) => {
    e.stopPropagation();
    setActiveFloatingImageId(id);
    setActiveFloatingTextId(null);
    const box = floatingImages.find(b => b.id === id);
    if (!box) return;
    let didMove = false;
    dragInfo.current = {
      id,
      type: 'image',
      startX: e.clientX,
      startY: e.clientY,
      startPdfX: box.pdfX,
      startPdfY: box.pdfY
    };

    const handleMove = (me: PointerEvent) => {
      if (!dragInfo.current || !doc || !renderResult) return;
      const dx = me.clientX - dragInfo.current.startX;
      const dy = me.clientY - dragInfo.current.startY;
      const pdfDx = dx / scale;
      const pdfDy = -dy / scale;

      const { startPdfX, startPdfY } = dragInfo.current;

      didMove = Math.abs(pdfDx) > 0.25 || Math.abs(pdfDy) > 0.25;
      setFloatingImages(prev => prev.map(p => p.id === id ? {
        ...p,
        pdfX: startPdfX + pdfDx,
        pdfY: startPdfY + pdfDy,
      } : p));
    };

    const handleUp = () => {
      if (didMove) pushEditorHistory('move-floating-image', { floatingImages: floatingImagesRef.current });
      dragInfo.current = null;
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', handleUp);
    };

    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', handleUp);
  }, [floatingImages, scale, doc, renderResult, pushEditorHistory]);

  const handleImageUpload = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !doc) return;
    const lease = documentOwnerRef.current.lease(doc);
    const reader = new FileReader();
    reader.onload = (event) => {
      const dataUrl = event.target?.result as string;
      const img = new window.Image();
      img.onload = async () => {
        if (!lease.isCurrent()) return;
        // Preserve transparency for PNG and rasterize SVG with its alpha channel.
        const canvas = document.createElement('canvas');
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        const isSvg = file.type.toLowerCase() === 'image/svg+xml';
        if (!isSvg) {
          ctx.fillStyle = '#ffffff';
          ctx.fillRect(0, 0, canvas.width, canvas.height);
        }
        ctx.drawImage(img, 0, 0);
        const imageDataUrlForPdf = file.type === 'image/png'
          ? dataUrl
          : isSvg ? canvas.toDataURL('image/png') : canvas.toDataURL('image/jpeg', 0.92);

        // Replace embedded PDF image in-place (same cm / bbox)
        if (replacingEmbeddedImageRef.current && doc && engineRef.current) {
          const target = replacingEmbeddedImageRef.current;
          replacingEmbeddedImageRef.current = null;
          try {
            const engine = engineRef.current;
            await sessionEditorRef.current.edit(doc, 'replace-image', async staged => {
              await engine.replaceImageXObject(staged, currentPage, target, imageDataUrlForPdf, () => engine.getNextObjNum(staged));
            }, { isCurrent: lease.isCurrent });
            if (!lease.isCurrent()) return;
            pushEditorHistory('replace-image', undefined, undefined, false, sessionEditorRef.current);
            sessionEditorRef.current = new SessionDocumentEditor();
            setIsDirty(true);
            setSelectedDisplayItem(null);
            setRenderKey(k => k + 1);
            setThumbnailKey(k => k + 1);
          } catch (err) {
            console.error('[Editor] Replace embedded image failed:', err);
            setError(`Replace failed: ${err instanceof Error ? err.message : String(err)}`);
          }
          return;
        }

        if (replacingImageIdRef.current) {
          setFloatingImages(prev => prev.map(p => p.id === replacingImageIdRef.current ? { ...p, dataUrl: imageDataUrlForPdf } : p));
          replacingImageIdRef.current = null;
          return;
        }

        // Add new floating image
        if (!doc || !renderResult) return;
        const page = doc.pages[currentPage];

        let pdfWidth = img.width;
        let pdfHeight = img.height;
        const maxDim = 200;
        if (pdfWidth > maxDim || pdfHeight > maxDim) {
          const ratio = Math.min(maxDim / pdfWidth, maxDim / pdfHeight);
          pdfWidth *= ratio;
          pdfHeight *= ratio;
        }

        const pdfX = page.mediaBox.width / 2 - pdfWidth / 2;
        const pdfY = page.mediaBox.height / 2 + pdfHeight / 2;

        const newImg: FloatingImage = {
          id: Math.random().toString(36).substr(2, 9),
          pageKey: page.ref.toKey(),
          pdfX,
          pdfY,
          pdfWidth,
          pdfHeight,
          dataUrl: imageDataUrlForPdf,
        };
        const nextImages = [...floatingImagesRef.current, newImg];
        setFloatingImages(nextImages);
        floatingImagesRef.current = nextImages;
        pushEditorHistory('add-image', { floatingImages: nextImages });
        setActiveFloatingImageId(newImg.id);
      };
      img.src = dataUrl;
    };
    reader.readAsDataURL(file);
    if (fileInputRef.current) fileInputRef.current.value = '';
  }, [doc, currentPage, renderResult, pushEditorHistory, setThumbnailKey]);

  const toEditableImage = useCallback((item: ImageItem): EditableObject => ({
    id: `sel-image-${item.name}`,
    kind: 'image',
    bbox: { x: item.x, y: item.y, width: item.width, height: item.height },
    ctm: item.ctm
      ? [item.ctm.a, item.ctm.b, item.ctm.c, item.ctm.d, item.ctm.e, item.ctm.f]
      : [item.width, 0, 0, item.height, item.x, item.y],
    source: item,
  }), []);

  const handleEmbeddedImageMove = useCallback(async (pdfDx: number, pdfDy: number, keepSelection = false) => {
    if (!doc || !engineRef.current || selectedDisplayItem?.type !== 'image') return;
    const item = selectedDisplayItem as ImageItem;
    const engine = engineRef.current;
    const pageKey = doc.pages[currentPage].ref.toKey();
    const lease = documentOwnerRef.current.lease(doc);
    const latest = (source: ImageItem): ImageItem => {
      let current = source;
      let successor = movedImageSuccessorsRef.current.get(current);
      while (successor) {
        current = successor;
        successor = movedImageSuccessorsRef.current.get(current);
      }
      return current;
    };
    try {
      await queueNativeEdit(doc, async isCurrent => {
        const before = latest(item);
        let moved: ImageItem | null = null;
        const editor = new SessionDocumentEditor();
        await editor.edit(doc, 'move-image', async staged => {
          const page = staged.pages[currentPage];
          if (!page || page.ref.toKey() !== pageKey) throw new Error('The selected page changed before the image could be moved.');
          const bytes = engine.getPageContentBytes(page, staged.objects);
          const display = engine.interpretPage(bytes, page, staged.objects, new engine.OptionalContentVisibility(staged.catalog, staged.objects)).displayList;
          const resolved = resolveSelectedObject(display, before);
          if (!resolved || resolved.type !== 'image') throw new Error('The selected image changed. Select it again.');
          const editable = toEditableImage(resolved);
          const transformed = transformObject(editable, { dx: pdfDx, dy: pdfDy });
          await applyObjectTransform(staged, currentPage, editable, transformed.ctm);
          const movedBox = { x: resolved.x + pdfDx, y: resolved.y + pdfDy, width: resolved.width, height: resolved.height };
          const updated = engine.getPageContentBytes(page, staged.objects);
          const after = engine.interpretPage(updated, page, staged.objects, new engine.OptionalContentVisibility(staged.catalog, staged.objects)).displayList;
          moved = findImagePlacement(after, { name: resolved.name, ...movedBox });
          if (!moved) {
            throw new Error('The image could not be safely moved.');
          }
        }, { isCurrent });
        if (!isCurrent() || !moved) throw new Error('The document was replaced before the edit completed.');
        pushEditorHistory('move-image', undefined, currentPage, false, editor);
        movedImageSuccessorsRef.current.set(before, moved);
        if (selectionPageRef.current?.ref.toKey() === pageKey) {
          setSelectedDisplayItem(current => current?.type === 'image' && latest(current) === moved
            ? (keepSelection ? moved : null) : current);
        }
      });
      if (!lease.isCurrent()) return;
      setIsDirty(true);
      setRenderKey(k => k + 1);
      setThumbnailKey(k => k + 1);
    } catch (error) {
      if (lease.isCurrent()) setError(`Move image failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }, [doc, currentPage, selectedDisplayItem, toEditableImage, pushEditorHistory, queueNativeEdit, setThumbnailKey]);

  const handleEmbeddedImageResize = useCallback(async (box: { x: number; y: number; width: number; height: number }) => {
    const engine = engineRef.current;
    if (!doc || !engine || selectedDisplayItem?.type !== 'image') return;
    const item = selectedDisplayItem as ImageItem;
    const page = doc.pages[currentPage];
    const pageKey = page.ref.toKey();
    const lease = documentOwnerRef.current.lease(doc);
    try {
      await queueNativeEdit(doc, async isCurrent => {
        const editor = new SessionDocumentEditor();
        let resizedImage: ImageItem | null = null;
        let updatedItems: (ImageItem | PathItem)[] = [];
        await editor.edit(doc, 'resize-image', async staged => {
          const stagedPage = staged.pages[currentPage];
          if (!stagedPage || stagedPage.ref.toKey() !== pageKey) throw new Error('The selected page changed before the image could be resized.');
          const bytes = engine.getPageContentBytes(stagedPage, staged.objects);
          const display = engine.interpretPage(bytes, stagedPage, staged.objects, new engine.OptionalContentVisibility(staged.catalog, staged.objects)).displayList;
          const target = resolveSelectedObject(display, item);
          if (!target || target.type !== 'image') throw new Error('The selected image changed. Select it again.');
          await applyObjectTransform(staged, currentPage, toEditableImage(target), [box.width, 0, 0, box.height, box.x, box.y]);
          const content = engine.getPageContentBytes(stagedPage, staged.objects);
          const updated = engine.interpretPage(content, stagedPage, staged.objects, new engine.OptionalContentVisibility(staged.catalog, staged.objects)).displayList;
          resizedImage = findImagePlacement(updated, { name: target.name, ...box });
          if (!resizedImage) throw new Error('The image could not be safely resized.');
          updatedItems = updated.filter(candidate => isSelectableDisplayItem(candidate, stagedPage.mediaBox)) as (ImageItem | PathItem)[];
        }, { isCurrent });
        if (!isCurrent() || !resizedImage) throw new Error('The document was replaced before the edit completed.');
        pushEditorHistory('resize-image', undefined, currentPage, false, editor);
        const entry = historyRef.current.peek();
        if (entry) imageResizeHistoryRef.current.set(entry, { pageKey, before: item, after: resizedImage });
        movedImageSuccessorsRef.current.set(item, resizedImage);
        if (selectionPageRef.current === page) {
          setDisplayItems(updatedItems);
          spatialIndexRef.current = buildDisplayListIndex(updatedItems, page.mediaBox);
          setSelectedDisplayItem(current => sameImagePlacement(current, item) ? resizedImage : current);
        }
      });
      if (!lease.isCurrent()) return;
      setIsDirty(true);
      setRenderKey(k => k + 1);
      setThumbnailKey(k => k + 1);
    } catch (error) {
      if (lease.isCurrent()) setError(`Resize image failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }, [doc, currentPage, selectedDisplayItem, toEditableImage, pushEditorHistory, queueNativeEdit, setThumbnailKey]);

  const handleReplaceEmbeddedImage = useCallback(() => {
    if (selectedDisplayItem?.type !== 'image') return;
    replacingEmbeddedImageRef.current = selectedDisplayItem as ImageItem;
    replacingImageIdRef.current = null;
    fileInputRef.current?.click();
  }, [selectedDisplayItem]);

  const handleFloatingImageNudge = useCallback((dx: number, dy: number) => {
    const id = activeFloatingImageId;
    if (!id) return;
    const next = floatingImagesRef.current.map(image => image.id === id
      ? { ...image, pdfX: image.pdfX + dx, pdfY: image.pdfY + dy }
      : image);
    setFloatingImages(next);
    floatingImagesRef.current = next;
    pushEditorHistory('move-floating-image', { floatingImages: next });
    setIsDirty(true);
  }, [activeFloatingImageId, pushEditorHistory]);

  const handleFloatingTextNudge = useCallback((dx: number, dy: number) => {
    const id = activeFloatingTextId;
    if (!id) return;
    const next = floatingTextsRef.current.map(text => text.id === id
      ? { ...text, pdfX: text.pdfX + dx, pdfY: text.pdfY + dy }
      : text);
    setFloatingTexts(next);
    floatingTextsRef.current = next;
    pushEditorHistory('move-text-box', { floatingTexts: next });
    setIsDirty(true);
  }, [activeFloatingTextId, pushEditorHistory]);

  // ── Hidden / line input — preview only; PDF commits on submit ──
  const handleHiddenInput = useCallback((e: React.FormEvent<HTMLTextAreaElement | HTMLInputElement>) => {
    if (!editingLine) return;
    const el = e.target as HTMLTextAreaElement | HTMLInputElement;
    const newVal = el.value;
    const oldVal = editTextRef.current;
    const sel = el.selectionStart ?? newVal.length;
    const delta = newVal.length - oldVal.length;
    const editAt = Math.min(sel - Math.max(0, delta), oldVal.length);


    if (delta !== 0 || newVal !== oldVal) {
      setEditStyleOverrides(prev => prev.flatMap(ov => {
        const next = remapStyleRange(ov.start, ov.end, editAt, delta);
        return next ? [{ ...ov, ...next }] : [];
      }).filter(ov => ov.end > ov.start));
      pendingStylesRef.current = pendingStylesRef.current.flatMap(p => {
        const next = remapStyleRange(p.start, p.end, editAt, delta);
        return next ? [{ ...p, ...next }] : [];
      }).filter(p => p.end > p.start);
    }

    // Inherit caret-local style, then let explicit typingStyle (sidebar) win.
    // Never inherit fontFamily — seeded display names strip Bold and would
    // force synthetic weight over the PDF face in the overlay.
    const anchor = editAnchorLineRef.current;
    const inherited = anchor
      ? resolveTypingStyleFromCaret(
          anchor,
          editAt,
          renderResult?.fonts,
          strokePaths,
          pendingStylesRef.current.map(p => ({
            start: p.start,
            end: p.end,
            bold: p.patch.bold,
            italic: p.patch.italic,
            underline: p.patch.underline,
            color: p.patch.color,
            fontSize: p.patch.fontSize,
          })),
          oldVal,
          initialRunTextRef.current || anchor.text,
        )
      : {};
    const explicit = typingStyleRef.current;
    const ts: TypingStyle = {
      ...inherited,
      ...explicit,
      // Only apply a font family the user picked in the sidebar
      ...(explicit.fontFamily != null ? { fontFamily: explicit.fontFamily } : { fontFamily: undefined }),
    };
    if (explicit.fontFamily == null) delete ts.fontFamily;

    // After deleting out of a sized override, drop sticky fontSize so neighbors
    // and further typing return to the surrounding size.
    if (delta < 0 && explicit.fontSize != null) {
      const stillInSized = pendingStylesRef.current.some(
        p => sel >= p.start && sel < p.end && p.patch.fontSize != null,
      );
      if (!stillInSized && inherited.fontSize != null && explicit.fontSize !== inherited.fontSize) {
        setTypingStyle({ ...explicit, fontSize: inherited.fontSize });
        ts.fontSize = inherited.fontSize;
        setTextFontSize(inherited.fontSize);
      }
    }

    // Only paint live overrides when style differs from the caret run.
    // Matching inserts stay in the run's span (no 1-glyph splits that break
    // bold face / underline continuity). Path underlines still need a
    // commit-only pending patch so the PDF underline extends.
    if (delta > 0) {
      const styleIdx = editAt > 0 ? editAt - 1 : 0;
      // Redistribute current text onto frozen runs — do NOT use raw anchor
      // indices (they walk into later segments as the caret advances).
      const destRun = anchor
        ? runAtDistributedEditIndex(
            anchor,
            initialRunTextRef.current || anchor.text,
            oldVal,
            styleIdx,
          )
        : null;
      const destFd = destRun && renderResult ? renderResult.fonts.get(destRun.fontName) : undefined;
      const destFlags = destRun
        ? resolveRunStyleFlags(destRun.fontName, destFd)
        : { bold: false, italic: false };
      const destUl = destRun
        ? !!(destRun.isUnderline || runHasPathUnderline(destRun, strokePaths))
        : false;
      const destFs = destRun ? visualFontSize(destRun) : 0;
      const colorDiffers = (() => {
        if (ts.color == null || !destRun?.fillColor) return ts.color != null && !destRun?.fillColor;
        const [r, g, b] = destRun.fillColor;
        const runHex = '#' + [r, g, b].map(c => Math.round(c * 255).toString(16).padStart(2, '0')).join('');
        return ts.color.toLowerCase() !== runHex.toLowerCase();
      })();
      // Compare against the destination run — inherited color/size that already
      // match must NOT force live overrides (that split every glyph into its
      // own span and breaks bold/underline continuity).
      const differs =
        (ts.bold != null && ts.bold !== destFlags.bold)
        || (ts.italic != null && ts.italic !== destFlags.italic)
        || (ts.underline != null && ts.underline !== destUl)
        || (ts.fontSize != null && Math.abs(ts.fontSize - destFs) > 0.5)
        || (explicit.fontFamily != null)
        || colorDiffers;

      const insertStart = sel - delta;
      const insertEnd = sel;
      const insertedText = newVal.slice(insertStart, insertEnd);
      const onlyWhitespace = /^\s+$/.test(insertedText);

      if (differs) {
        // Only queue properties that actually differ from the destination run.
        // Seeded typingStyle always carries bold/italic/color — piggybacking those
        // onto a fontSize-only insert created per-glyph bold overrides and, for
        // spaces, bold-only commit patches that flipped neighboring unbold runs.
        const patch: Partial<TextStyleUI> = {};
        if (ts.bold != null && ts.bold !== destFlags.bold) patch.bold = ts.bold;
        if (ts.italic != null && ts.italic !== destFlags.italic) patch.italic = ts.italic;
        if (ts.underline != null && ts.underline !== destUl) patch.underline = ts.underline;
        if (ts.color != null && colorDiffers) patch.color = ts.color;
        // Spaces: never commit a larger fontSize (that invents rivers via trailing
        // shifts). Still paint typing-size spaces in the live overlay so the
        // caret doesn't look like it's arrow-skipping through the next word.
        if (ts.fontSize != null && !onlyWhitespace && Math.abs(ts.fontSize - destFs) > 0.5) {
          patch.fontSize = ts.fontSize;
        }
        if (explicit.fontFamily != null) patch.fontFamily = ts.fontFamily;
        const hasPatch = Object.keys(patch).length > 0;
        if (hasPatch) {
          pendingStylesRef.current = [...pendingStylesRef.current, { patch, start: insertStart, end: insertEnd }];
          setEditStyleOverrides(prev => [
            ...prev,
            {
              start: insertStart,
              end: insertEnd,
              bold: patch.bold,
              italic: patch.italic,
              underline: patch.underline,
              color: patch.color,
              fontSize: patch.fontSize,
              fontFamily: patch.fontFamily,
            },
          ]);
        }
        if (
          onlyWhitespace
          && ts.fontSize != null
          && Math.abs(ts.fontSize - destFs) > 0.5
        ) {
          setEditStyleOverrides(prev => [
            ...prev,
            { start: insertStart, end: insertEnd, fontSize: ts.fontSize },
          ]);
        }
      } else if (ts.underline && destRun && !destRun.isUnderline && runHasPathUnderline(destRun, strokePaths)) {
        // Path-drawn underline won't grow with new glyphs on commit
        pendingStylesRef.current = [
          ...pendingStylesRef.current,
          { patch: { underline: true }, start: insertStart, end: insertEnd },
        ];
      }
    }

    // Do NOT live-collapse spaces while typing — rewriting the textarea mid-
    // keystroke made Space feel broken (2nd+ press) and jumped the caret.
    // Rivers are still collapsed on commit (see handleEditSubmit).
    editTextRef.current = newVal;
    setEditText(newVal);
    setCaretPos(sel);
    const selEnd = el.selectionEnd ?? sel;
    editSelRef.current = { start: sel, end: selEnd };
    setEditSel({ start: sel, end: selEnd });
    caretVisibleRef.current = true;
  }, [editingLine, renderResult, strokePaths, setTypingStyle]);

  const handleHiddenKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Let the browser handle Ctrl+Z / Ctrl+Y for in-progress typing (native textarea undo).
    if ((e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'y')) {
      e.stopPropagation();
      return;
    }
    if (!editingLine) return;
    if (e.altKey && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) {
      // Alt+Arrow nudges the whole text box (1pt, +Shift = 10pt); plain arrows move the caret.
      e.preventDefault();
      const step = (e.shiftKey ? 10 : 1) * scale;
      const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
      const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
      setEditOffsetCss(o => ({ x: o.x + dx, y: o.y + dy }));
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleEditSubmit();
    } else if (e.key === 'Enter' && e.shiftKey) {
      e.preventDefault();
      void handleDuplicateLineBelow();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      handleEditCancel();
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'Home' || e.key === 'End') {
      setTimeout(() => {
        const el = hiddenInputRef.current;
        if (!el) return;
        const start = el.selectionStart ?? caretPos;
        const end = el.selectionEnd ?? start;
        setCaretPos(start);
        editSelRef.current = { start, end };
        setEditSel({ start, end });
        caretVisibleRef.current = true;
      }, 0);
    }
  }, [editingLine, caretPos, handleEditSubmit, handleEditCancel, handleDuplicateLineBelow]);

  const handleHiddenBlur = useCallback(() => {
    if (!editingLine || !renderReadyRef.current) return;
    if (blurTimeoutRef.current) {
      clearTimeout(blurTimeoutRef.current);
    }
    blurTimeoutRef.current = setTimeout(() => {
      blurTimeoutRef.current = null;
      // Sidebar / font <select> uses data-keep-text-edit — keep edit open.
      // Do NOT refocus the textarea here or the native dropdown closes instantly.
      const active = document.activeElement as HTMLElement | null;
      if (active?.closest?.('[data-keep-text-edit]')) {
        return;
      }
      if (editingLineRef.current && renderReadyRef.current) {
        handleEditSubmit();
      }
    }, 150);
  }, [editingLine, handleEditSubmit]);

  // ── Navigation handlers ──
  const goToPrev = useCallback(async () => {
    if (!await commitFormFieldDraft()) return;
    try {
      await prepareOverlayText();
      if (editingLineRef.current && !await handleEditSubmit()) return;
      await commitDrawingsToPdf();
    } catch (e) {
      if (!showUnsupportedGlyphWarning(e)) {
        setError(`Failed to commit page overlays: ${e instanceof Error ? e.message : String(e)}`);
      }
      return;
    }
    closeLinkPopover();
    setLinkCreatePending(false);
    changePage(p => Math.max(0, p - 1));
  }, [commitDrawingsToPdf, closeLinkPopover, handleEditSubmit, showUnsupportedGlyphWarning, prepareOverlayText, commitFormFieldDraft]);

  const goToNext = useCallback(async () => {
    if (!await commitFormFieldDraft()) return;
    try {
      await prepareOverlayText();
      if (editingLineRef.current && !await handleEditSubmit()) return;
      await commitDrawingsToPdf();
    } catch (e) {
      if (!showUnsupportedGlyphWarning(e)) {
        setError(`Failed to commit page overlays: ${e instanceof Error ? e.message : String(e)}`);
      }
      return;
    }
    closeLinkPopover();
    setLinkCreatePending(false);
    changePage(p => Math.min(totalPages - 1, p + 1));
  }, [totalPages, commitDrawingsToPdf, closeLinkPopover, handleEditSubmit, showUnsupportedGlyphWarning, prepareOverlayText, commitFormFieldDraft]);

  const zoomIn = useCallback(() => {
    setScale(s => Math.min(4, Math.round((s + 0.25) * 100) / 100));
  }, []);

  const zoomOut = useCallback(() => {
    setScale(s => Math.max(0.5, Math.round((s - 0.25) * 100) / 100));
  }, []);

  // Trackpad pinch / Ctrl+wheel zoom (browsers fire wheel+ctrlKey for pinch)
  useEffect(() => {
    if (isLoading || !doc) return;
    const viewport = scrollViewportRef.current;
    if (!viewport) return;

    const onWheel = (e: WheelEvent) => {
      // Pinch-to-zoom on macOS/Chrome sets ctrlKey; also support Ctrl/Cmd+wheel
      if (!(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      e.stopPropagation();

      const intensity = Math.max(0.05, Math.min(0.25, Math.abs(e.deltaY) * 0.012));
      const direction = e.deltaY < 0 ? 1 : -1;
      setScale(s => {
        const next = s + direction * intensity;
        const clamped = Math.min(4, Math.max(0.5, next));
        return Math.round(clamped * 100) / 100;
      });
    };

    viewport.addEventListener('wheel', onWheel, { passive: false });
    return () => viewport.removeEventListener('wheel', onWheel);
  }, [doc, isLoading, currentPage]);
  // ── Watermark Handlers ──
  const handleWatermarkImageUpload = useCallback((file: File) => {
    setWatermarkImageFile(file);

    const reader = new FileReader();
    reader.onload = async (ev) => {
      const dataUrl = ev.target?.result as string;
      const img = new window.Image();
      img.onload = async () => {
        if (file.type === 'image/png') {
          setWatermarkImageBytes(new Uint8Array(await file.arrayBuffer()));
          setWatermarkImageDims({ width: img.naturalWidth, height: img.naturalHeight });
          return;
        }

        // Convert other formats to JPEG for DCTDecode.
        const canvas = document.createElement('canvas');
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        const ctx = canvas.getContext('2d');
        if (ctx) {
          // JPEG has no alpha channel.
          ctx.fillStyle = '#ffffff';
          ctx.fillRect(0, 0, canvas.width, canvas.height);
          ctx.drawImage(img, 0, 0);

          canvas.toBlob(blob => {
            if (blob) {
              blob.arrayBuffer().then(buf => {
                setWatermarkImageBytes(new Uint8Array(buf));
                setWatermarkImageDims({ width: img.naturalWidth, height: img.naturalHeight });

                // Override the file to be considered JPEG
                const jpegFile = new File([blob], file.name.replace(/\.[^.]+$/, '.jpg'), { type: 'image/jpeg' });
                setWatermarkImageFile(jpegFile);
              });
            }
          }, 'image/jpeg', 0.9);
        }
      };
      img.src = dataUrl;
    };
    reader.readAsDataURL(file);
  }, []);

  const handleWatermarkImageClear = useCallback(() => {
    setWatermarkImageFile(null);
    setWatermarkImageBytes(null);
    setWatermarkImageDims(null);
  }, []);

  const handleApplyWatermark = useCallback(async () => {
    if (!doc || !engineRef.current) return;
    const lease = documentOwnerRef.current.lease(doc);
    try {
      let wm: Watermark;

      const pageIndices: number[] = [];
      const totalPages = doc.pages.length;
      const fromIdx = Math.max(0, watermarkPageFrom - 1);
      const toIdx = Math.min(totalPages - 1, watermarkPageTo - 1);
      for (let i = fromIdx; i <= toIdx; i++) {
        pageIndices.push(i);
      }

      if (watermarkType === 'text') {
        const r = parseInt(watermarkColor.slice(1, 3), 16) / 255;
        const g = parseInt(watermarkColor.slice(3, 5), 16) / 255;
        const b = parseInt(watermarkColor.slice(5, 7), 16) / 255;

        wm = {
          id: `wm-${Date.now()}`,
          type: 'text',
          text: watermarkText,
          opacity: watermarkOpacity / 100,
          blendMode: watermarkBlendMode,
          color: [r, g, b],
          rotation: watermarkRotation,
          tile: watermarkMosaic,
          layer: watermarkLayer,
          fontName: watermarkFontName,
          fontSize: Math.round(72 * (watermarkSize / 100)),
          position: watermarkPosition,
          pageIndices
        };
      } else if (watermarkType === 'shape') {
        const r = parseInt(watermarkColor.slice(1, 3), 16) / 255;
        const g = parseInt(watermarkColor.slice(3, 5), 16) / 255;
        const b = parseInt(watermarkColor.slice(5, 7), 16) / 255;

        const sr = parseInt(watermarkShapeColor.slice(1, 3), 16) / 255;
        const sg = parseInt(watermarkShapeColor.slice(3, 5), 16) / 255;
        const sb = parseInt(watermarkShapeColor.slice(5, 7), 16) / 255;

        const fontSizePt = Math.round(72 * (watermarkSize / 100));
        const textWidth = watermarkText.length * fontSizePt * 0.5;

        let finalWidth = textWidth + 40;
        let finalHeight = fontSizePt + 40;
        if (watermarkShapeType === 'circle') {
          const maxDim = Math.max(finalWidth, finalHeight);
          finalWidth = maxDim;
          finalHeight = maxDim;
        }

        wm = {
          id: `wm-${Date.now()}`,
          type: 'shape',
          shape: watermarkShapeType,
          text: watermarkText,
          fontName: watermarkFontName,
          fontSize: fontSizePt,
          textColor: [r, g, b],
          shapeColor: [sr, sg, sb],
          width: finalWidth,
          height: finalHeight,
          opacity: watermarkOpacity / 100,
          blendMode: watermarkBlendMode,
          rotation: watermarkRotation,
          tile: watermarkMosaic,
          layer: watermarkLayer,
          position: watermarkPosition,
          pageIndices
        };
      } else {
        if (!watermarkImageBytes || !watermarkImageDims || !watermarkImageFile) {
          setError('Please upload an image first');
          return;
        }

        const mimeType = watermarkImageFile.type === 'image/png' ? 'image/png' : 'image/jpeg';

        wm = {
          id: `wm-${Date.now()}`,
          type: 'image',
          imageBytes: watermarkImageBytes,
          mimeType,
          width: watermarkImageDims.width * (watermarkSize / 100),
          height: watermarkImageDims.height * (watermarkSize / 100),
          opacity: watermarkOpacity / 100,
          blendMode: watermarkBlendMode,
          rotation: watermarkRotation,
          tile: watermarkMosaic,
          layer: watermarkLayer,
          position: watermarkPosition,
          pageIndices
        };
      }

      const engine = engineRef.current;
      await sessionEditorRef.current.edit(doc, 'watermark', async staged => {
        const results = await engine.applyWatermarks(staged, [wm], () => engine.getNextObjNum(staged));
        const updatePromises: Promise<void>[] = [];
        results.forEach((newBytes, pageIdx) => {
          const page = staged.pages[pageIdx];
          updatePromises.push(engine.updatePageContent(page.contentRefs, newBytes, staged.objects));
        });
        await Promise.all(updatePromises);
      }, { isCurrent: lease.isCurrent });
      if (!lease.isCurrent()) return;
      pushEditorHistory('watermark', undefined, undefined, false, sessionEditorRef.current);
      sessionEditorRef.current = new SessionDocumentEditor();
      setIsDirty(true);
      setThumbnailKey(k => k + 1);
      setDoc({ ...doc });
      setRenderKey(k => k + 1);
      setWatermarkLivePreview(false);
      setShowApplySuccessModal(true);
    } catch (e) {
      console.error('[Editor] Apply watermark failed:', e);
      setError(`Failed to apply watermark: ${e instanceof Error ? e.message : String(e)}`);
    }
  }, [doc, setDoc, pushEditorHistory, watermarkType, watermarkText, watermarkFontName, watermarkOpacity, watermarkRotation, watermarkSize, watermarkPosition, watermarkMosaic, watermarkPageFrom, watermarkPageTo, watermarkLayer, watermarkColor, watermarkShapeColor, watermarkShapeType, watermarkImageBytes, watermarkImageDims, watermarkImageFile, watermarkBlendMode, setThumbnailKey]);

  // ── Signature handlers ──
  const resolveSignatureImage = useCallback((sig: VisualSignature): string | null => {
    const entry = getSignatureLibrary().get(sig.appearanceId);
    return sig.appearanceImageDataUrl ?? entry?.imageDataUrl ?? null;
  }, []);

  const handleSignatureSelect = useCallback((id: string) => {
    setSelectedSignatureId(id);
    setSelectedDisplayItem(null);
  }, []);

  const handleSignatureMove = useCallback((id: string, dx: number, dy: number) => {
    void commitSignatureChange(current => updateSignature(current, id, s => moveSignature(s, dx, dy)), 'move-signature');
  }, [commitSignatureChange]);

  const handleSignatureResize = useCallback((id: string, box: { x: number; y: number; width: number; height: number }) => {
    // The overlay clamps size and fixes the opposite edge; commit all bounds together.
    void commitSignatureChange(current => updateSignature(current, id, s => s.locked ? s : { ...s, ...box }), 'resize-signature');
  }, [commitSignatureChange]);

  const handleSignatureRotate = useCallback((id: string, degrees: number) => {
    void commitSignatureChange(current => updateSignature(current, id, s => rotateSignature(s, degrees)), 'rotate-signature');
  }, [commitSignatureChange]);

  const handleSignatureDelete = useCallback((id: string) => {
    void commitSignatureChange(current => deleteSignature(current, id), 'delete-signature');
    if (selectedSignatureId === id) setSelectedSignatureId(null);
  }, [commitSignatureChange, selectedSignatureId]);

  const handleSignatureOpacity = useCallback((id: string, opacity: number) => {
    void commitSignatureChange(current => updateSignature(current, id, s => setSignatureOpacity(s, opacity)), 'opacity-signature');
  }, [commitSignatureChange]);

  const handleSignatureLockToggle = useCallback((id: string) => {
    const next = updateSignature(signaturesRef.current, id, s => setSignatureLocked(s, !s.locked));
    pushSignatureSnapshot(next, 'lock-signature');
  }, [pushSignatureSnapshot]);

  const reportSignatureStorageWarning = useCallback(() => {
    const warning = getSignatureLibrary().consumeStorageWarning();
    if (warning) setError(warning);
  }, []);

  const handleSignatureCreateSave = useCallback((result: SignatureCreateResult) => {
    const entry = getSignatureLibrary().add({
      ...result.entry,
      favorite: false,
      sessionOnly: result.storage === 'session',
    });
    refreshSignatureLibrary();
    setActiveLibraryId(entry.id);
    reportSignatureStorageWarning();
  }, [refreshSignatureLibrary, reportSignatureStorageWarning]);

  const handleLibraryRename = useCallback((id: string, name: string) => {
    getSignatureLibrary().rename(id, name);
    refreshSignatureLibrary();
    reportSignatureStorageWarning();
  }, [refreshSignatureLibrary, reportSignatureStorageWarning]);

  const handleLibraryDelete = useCallback((id: string) => {
    const deleted = getSignatureLibrary().delete(id);
    if (deleted && activeLibraryId === id) setActiveLibraryId(null);
    refreshSignatureLibrary();
    reportSignatureStorageWarning();
  }, [activeLibraryId, refreshSignatureLibrary, reportSignatureStorageWarning]);

  const handleLibraryDuplicate = useCallback((id: string) => {
    const dup = getSignatureLibrary().duplicate(id);
    if (dup) {
      setActiveLibraryId(dup.id);
      refreshSignatureLibrary();
    }
    reportSignatureStorageWarning();
  }, [refreshSignatureLibrary, reportSignatureStorageWarning]);

  const handleLibraryFavorite = useCallback((id: string) => {
    getSignatureLibrary().toggleFavorite(id);
    refreshSignatureLibrary();
    reportSignatureStorageWarning();
  }, [refreshSignatureLibrary, reportSignatureStorageWarning]);

  const handleScanWatermarks = useCallback(() => {
    if (!doc || !engineRef.current) return;
    try {
      const detections = engineRef.current.detectWatermarks(doc);
      setDetectedWatermarks(detections);
    } catch (e) {
      console.error('[Editor] Scan watermarks failed:', e);
      setError(`Failed to scan watermarks: ${e instanceof Error ? e.message : String(e)}`);
    }
  }, [doc]);

  const handleConfirmRemoveWatermarks = useCallback(() => {
    setIsConfirmingRemoval(true);
  }, []);

  const executeRemoveWatermarks = useCallback(() => {
    if (!doc || !engineRef.current || !detectedWatermarks) return;
    try {
      const removal = engineRef.current.removeWatermarks(doc, detectedWatermarks);
      console.log('[Editor] Removed watermarks:', removal);
      if (removal.removed > 0) setIsDirty(true);
      setDoc({ ...doc });
      setRenderKey(k => k + 1);
      setDetectedWatermarks(null);
      setIsConfirmingRemoval(false);
    } catch (e) {
      console.error('[Editor] Remove watermarks failed:', e);
      setError(`Failed to remove watermarks: ${e instanceof Error ? e.message : String(e)}`);
    }
  }, [doc, detectedWatermarks, setDoc]);

  const handleCancelScan = useCallback(() => {
    setDetectedWatermarks(null);
  }, []);

  // ── Download / Save ──
  const handleDownload = useCallback(async (): Promise<boolean> => {
    if (!doc || !engineRef.current || downloadOperationRef.current) return false;
    if (securityBusyRef.current || searchBusy || cryptoSignBusy) {
      setError('Wait for the current operation to finish before downloading.');
      return false;
    }
    downloadOperationRef.current = true;
    const lease = documentOwnerRef.current.lease(doc);
    try {
      if (!await commitFormFieldDraft()) return false;
      setIsSaving(true);
      setIsDownloading(true);
      setGlyphWarning(null);
      await annotationCommitPendingRef.current;
      await documentOwnerRef.current.whenIdle();
      if (formDraftControllerRef.current.get() || linkPopoverMode ||
          floatingTextEditStartRef.current || isDrawing || currentDrawPath.current.length > 0) {
        throw new Error('Finish or cancel the current edit before downloading.');
      }
      const result = await engineRef.current.exportDocument(doc, {
        mode: saveMode,
        prepare: () => prepareOverlayText(),
        commitPendingEdit: () => editingLineRef.current ? handleEditSubmit() : undefined,
        flatten: commitDrawingsToPdf,
      });
      if (result.status === 'cancelled') return false;
      if (result.status === 'error') throw result.error;
      const bytes = result.bytes;
      if (engineRef.current.securityEngine.isEncrypted(doc) || doc.decryptedFromEncrypted) {
        const exported = await engineRef.current.parsePDF(new Uint8Array(bytes));
        if (!engineRef.current.securityEngine.isEncrypted(exported)) {
          throw new Error('The protected PDF could not be saved with its encryption.');
        }
      }
      const stored = await commitDownloadedPdf(new Uint8Array(bytes).buffer, fileName || 'edited.pdf', lease.isCurrent);
      if (!stored || !lease.isCurrent()) throw new Error('The document changed before the download could be saved.');
      const blob = new Blob([bytes as unknown as BlobPart], { type: 'application/pdf' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = fileName || 'edited.pdf';
      a.click();
      URL.revokeObjectURL(url);
      setIsDirty(false);
      return true;
    } catch (e) {
      if (closeOperationRef.current) {
        setCloseError(e instanceof Error ? e.message : 'Download failed. Your document remains open.');
      }
      if (!showUnsupportedGlyphWarning(e)) {
        console.error('[Editor] Download failed:', e);
        setError(`Download failed: ${e instanceof Error ? e.message : String(e)}`);
      }
      return false;
    } finally {
      downloadOperationRef.current = false;
      setIsDownloading(false);
      setIsSaving(false);
    }
  }, [doc, fileName, saveMode, commitDrawingsToPdf, handleEditSubmit, showUnsupportedGlyphWarning, prepareOverlayText, selectedFormField, formFieldDraft, linkPopoverMode, isDrawing, searchBusy, cryptoSignBusy, commitFormFieldDraft]);

  // ── Compressed Download ──
  const handleCompressedDownload = useCallback(async (opts: CompressedDownloadOptions) => {
    // Resizing also requires re-encoding; Original compression always preserves image bytes.
    if (opts.quality === null) return handleDownload();
    if (!doc || !engineRef.current || downloadOperationRef.current) return;
    if (securityBusyRef.current || searchBusy || cryptoSignBusy) {
      setError('Wait for the current operation to finish before downloading.');
      return;
    }
    downloadOperationRef.current = true;
    const lease = documentOwnerRef.current.lease(doc);
    try {
      if (!await commitFormFieldDraft()) return;
      setIsSaving(true);
      setIsDownloading(true);
      setError(null);
      setGlyphWarning(null);
      await annotationCommitPendingRef.current;
      await documentOwnerRef.current.whenIdle();
      await prepareOverlayText();
      if (editingLineRef.current && !await handleEditSubmit()) return;
      // Capture pending overlays before committing them; compare exportable
      // objects too, since not every mutation enters history or marks dirty.
      const pristineBeforeCommit = originalIsCurrentRef.current;
      await commitDrawingsToPdf();
      const engine = engineRef.current;
      const originalLen = doc.rawBytes?.length ?? 0;
      let originalIsCurrent = false;
      if (pristineBeforeCommit && !hasEditedRef.current &&
          doc.rawBytes === uploadBytesRef.current) {
        try {
          originalIsCurrent = !(await engine.hasDocumentEdits(doc)) &&
            originalIsCurrentRef.current && !hasEditedRef.current &&
            !historyRef.current.canUndo() && !historyRef.current.canRedo() &&
            drawnPathsRef.current.length === 0 &&
            floatingTextsRef.current.length === 0 &&
            floatingImagesRef.current.length === 0 &&
            signaturesRef.current.length === 0 &&
            !editingLineRef.current && doc.rawBytes === uploadBytesRef.current;
        } catch {
          // An unprovable comparison must never permit stale upload bytes.
        }
      }

      const result = await engine.compressDocumentImages(doc, {
        quality: opts.quality,
        dpi: opts.dpi,
        targetBytes: opts.targetBytes,
        originalIsCurrent,
      });

      // Upload fallback is allowed only by the engine's explicit pristine-state option.
      const outBytes = result.bytes;
      const outLen = result.compressedBytes;
      const note = result.message;

      if (engine.securityEngine.isEncrypted(doc) || doc.decryptedFromEncrypted) {
        const exported = await engine.parsePDF(new Uint8Array(outBytes));
        if (!engine.securityEngine.isEncrypted(exported)) {
          throw new Error('The protected PDF could not be saved with its encryption.');
        }
      }

      const stored = await commitDownloadedPdf(new Uint8Array(outBytes).buffer, fileName || 'edited.pdf', lease.isCurrent);
      if (!stored || !lease.isCurrent()) throw new Error('The document changed before the download could be saved.');

      console.log('[Compress]', note, {
        method: result.method,
        originalBytes: originalLen,
        compressedBytes: outLen,
      });

      const blob = new Blob([outBytes as BlobPart], { type: 'application/pdf' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      const base = (fileName || 'document.pdf').replace(/\.pdf$/i, '');
      a.download =
        outLen < originalLen * 0.98 ? `${base}_compressed.pdf` : `${base}.pdf`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      if (result.targetMissed || result.method === 'unchanged' || outLen >= originalLen) {
        setError(note);
      } else {
        setError(null);
      }
      setIsDirty(false);
    } catch (e) {
      if (!showUnsupportedGlyphWarning(e)) {
        console.error('[Editor] Compressed download failed:', e);
        setError(`Compression failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    } finally {
      downloadOperationRef.current = false;
      setIsDownloading(false);
      setIsSaving(false);
    }
  }, [doc, fileName, handleDownload, commitDrawingsToPdf, handleEditSubmit, showUnsupportedGlyphWarning, prepareOverlayText, searchBusy, cryptoSignBusy, commitFormFieldDraft]);

  const closeDocument = useCallback(async (preserveSavedCopy = false) => {
    if (!preserveSavedCopy) await clearPdfFromStorage();
    formDraftControllerRef.current.clear();
    documentOwnerRef.current.replace(null);
    recoveryPasswordRef.current = null;
    router.push('/');
  }, [router]);

  const handleClose = useCallback(() => {
    if (closeOperationRef.current || downloadOperationRef.current) return;
    if (isSaving || securityBusyRef.current || cryptoSignBusy || searchBusy) {
      setError('Wait for the current operation to finish before closing.');
      return;
    }
    if (pendingRecoveryRef.current && !doc) {
      // Cancelling the password prompt must preserve the recovery record.
      router.push('/');
      return;
    }
    closeOperationRef.current = true;
    setCloseBusy(true);
    setIsCheckingClose(true);
    void (async () => {
      await annotationCommitPendingRef.current;
      await documentOwnerRef.current.whenIdle();
      if (isDirtyRef.current || editingLineRef.current || isDrawing || currentDrawPath.current.length > 0 ||
          floatingTextEditStartRef.current || hasPendingFormFieldDraft(selectedFormField, formFieldDraft) || linkPopoverMode) {
        setCloseError(null);
        setCloseDialogOpen(true);
        return;
      }
      // A browser download can be cancelled after it starts; retain the last
      // saved local PDF unless the user explicitly discards their changes.
      await closeDocument(true);
    })().catch((error: unknown) => {
      setError(`Could not close the document: ${error instanceof Error ? error.message : String(error)}`);
    }).finally(() => { closeOperationRef.current = false; setCloseBusy(false); setIsCheckingClose(false); });
  }, [closeDocument, cryptoSignBusy, doc, formFieldDraft, isDrawing, isSaving, linkPopoverMode, router, searchBusy, selectedFormField]);

  const handleCloseChoice = useCallback(async (save: boolean) => {
    if (closeOperationRef.current) return;
    closeOperationRef.current = true;
    setCloseBusy(true);
    setCloseError(null);
    try {
      if (save && !await handleDownload()) {
        setCloseError(previous => previous ?? 'Download was cancelled or failed. Your document remains open.');
        return;
      }
      await closeDocument(save);
      setCloseDialogOpen(false);
    } catch (error) {
      setCloseError(error instanceof Error ? error.message : 'Could not close the document.');
      setError(`Could not close the document: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      closeOperationRef.current = false;
      setCloseBusy(false);
    }
  }, [closeDocument, handleDownload]);

  // ── Page Operations ──
  const pageSelectionRef = useRef(currentPage);
  useLayoutEffect(() => { pageSelectionRef.current = currentPage; }, [currentPage]);
  const refreshAfterPageOp = useCallback((nextDoc: PDFDocumentData, nextCurrentPage: number) => {
    setDoc({ ...nextDoc });
    setTotalPages(nextDoc.pages.length);
    const selected = Math.max(0, Math.min(nextCurrentPage, nextDoc.pages.length - 1));
    pageSelectionRef.current = selected;
    changePage(selected);
    setIsDirty(true);
    setRenderKey((k) => k + 1);
    setThumbnailKey((k) => k + 1);
  }, [setDoc, setThumbnailKey]);

  const commitPageOperation = useCallback(async (
    label: string,
    apply: (staged: PDFDocumentData, selectedPage: number) => Promise<number>,
  ) => {
    if (!doc) return;
    if (!await commitFormFieldDraft()) throw new Error('Finish the form field edit before changing pages.');
    // Page deletion and rotation must not detach or reinterpret pending overlays.
    await commitDrawingsToPdf();
    await queueNativeEdit(doc, async isCurrent => {
      const editor = new SessionDocumentEditor();
      const previousPages = doc.pages.map(page => page.ref.toKey());
      let nextPage = pageSelectionRef.current;
      await editor.edit(doc, label, async staged => {
        nextPage = await apply(staged, pageSelectionRef.current);
      }, { isCurrent });
      const signatures = signaturesRef.current.flatMap(signature => {
        const key = previousPages[signature.pageIndex];
        const pageIndex = doc.pages.findIndex(page => page.ref.toKey() === key);
        return pageIndex < 0 ? [] : [{ ...signature, pageIndex }];
      });
      signaturesRef.current = signatures;
      setSignatures(signatures);
      refreshAfterPageOp(doc, nextPage);
      pushEditorHistory(label, { signatures }, nextPage, false, editor);
    });
  }, [doc, queueNativeEdit, refreshAfterPageOp, pushEditorHistory, commitDrawingsToPdf, commitFormFieldDraft]);

  const downloadPdfBytes = useCallback((bytes: Uint8Array, name: string) => {
    const blob = new Blob([bytes as unknown as BlobPart], { type: 'application/pdf' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.click();
    URL.revokeObjectURL(url);
  }, []);

  const handleDeletePage = useCallback(async (index: number) => {
    if (!doc || !engineRef.current) return;
    try {
      const engine = engineRef.current;
      await commitPageOperation('delete-page', async (staged, selected) => {
        engine.deletePage(staged, index);
        return selected === index ? Math.min(index, staged.pages.length - 1)
          : selected > index ? selected - 1 : selected;
      });
    } catch (e) {
      setError(`Failed to delete page: ${e instanceof Error ? e.message : String(e)}`);
    }
  }, [doc, commitPageOperation]);

  const handleRotatePage = useCallback(async (index: number) => {
    if (!doc || !engineRef.current) return;
    try {
      const engine = engineRef.current;
      await commitPageOperation('rotate-page', async (staged, selected) => {
        engine.rotatePageBy(staged, index, 90);
        return selected;
      });
    } catch (e) {
      setError(`Failed to rotate page: ${e instanceof Error ? e.message : String(e)}`);
    }
  }, [doc, commitPageOperation]);

  const handleReorderPages = useCallback(async (fromIndex: number, toIndex: number) => {
    if (!doc || !engineRef.current || fromIndex === toIndex) return;
    try {
      const engine = engineRef.current;
      await commitPageOperation('reorder-pages', async (staged, selected) => {
        const selectedRef = staged.pages[selected].ref;
        engine.movePage(staged, fromIndex, toIndex);
        return staged.pages.findIndex(page => page.ref.equals(selectedRef));
      });
    } catch (e) {
      setError(`Failed to reorder pages: ${e instanceof Error ? e.message : String(e)}`);
    }
  }, [doc, commitPageOperation]);

  const handleMergePdf = useCallback(async (file: File) => {
    if (!doc || !engineRef.current) return;
    try {
      const engine = engineRef.current;
      let changes: Array<{ from: string; to: string }> = [];
      await commitPageOperation('insert-pages', async (staged, selected) => {
        const sourceDoc = await engine.parsePDF(new Uint8Array(await file.arrayBuffer()));
        if (engine.securityEngine.isEncrypted(sourceDoc)) throw new Error('The source PDF is password protected. Unlock and save a copy before merging.');
        changes = engine.insertPagesFromDocument(staged, sourceDoc, staged.pages.length);
        return selected;
      });
      setRenamedFields(changes);
    } catch (e) {
      setError(`Failed to merge PDF: ${e instanceof Error ? e.message : String(e)}`);
    }
  }, [doc, commitPageOperation]);

  const preparePageDownloads = useCallback(async (pageKeys: string[]): Promise<Uint8Array[] | null> => {
    if (!doc || !engineRef.current || downloadOperationRef.current) return null;
    if (securityBusyRef.current || searchBusy || cryptoSignBusy) {
      throw new Error('Wait for the current operation to finish before downloading.');
    }
    downloadOperationRef.current = true;
    try {
      if (!await commitFormFieldDraft()) return null;
      await annotationCommitPendingRef.current;
      await documentOwnerRef.current.whenIdle();
      if (formDraftControllerRef.current.get() || linkPopoverMode ||
          floatingTextEditStartRef.current || isDrawing || currentDrawPath.current.length > 0) {
        throw new Error('Finish or cancel the current edit before downloading.');
      }
      await prepareOverlayText();
      if (editingLineRef.current && !await handleEditSubmit()) return null;
      await commitDrawingsToPdf();
      const revision = editRevisionRef.current;
      const results: Uint8Array[] = [];
      await queueNativeEdit(doc, async isCurrent => {
        const editor = new SessionDocumentEditor();
        for (const key of pageKeys) {
          const index = doc.pages.findIndex(page => page.ref.toKey() === key);
          if (index < 0) throw new Error('A selected page changed before it could be downloaded.');
          results.push(await editor.extractPages(doc, [index]));
          if (!isCurrent() || editRevisionRef.current !== revision) {
            throw new Error('The document changed while preparing the page downloads. Try again.');
          }
        }
      });
      return results;
    } finally {
      downloadOperationRef.current = false;
    }
  }, [doc, selectedFormField, formFieldDraft, linkPopoverMode, isDrawing, searchBusy, cryptoSignBusy,
    prepareOverlayText, handleEditSubmit, commitDrawingsToPdf, queueNativeEdit, commitFormFieldDraft]);

  const handleSplitCurrentPage = useCallback(async () => {
    if (!doc || !engineRef.current || !doc.pages[currentPage]) return;
    const key = doc.pages[currentPage].ref.toKey();
    try {
      const results = await preparePageDownloads([key]);
      if (!results) return;
      const base = (fileName || 'document').replace(/\.pdf$/i, '');
      downloadPdfBytes(results[0], `${base}-page-${currentPage + 1}.pdf`);
    } catch (e) {
      if (!showUnsupportedGlyphWarning(e)) setError(`Failed to split page: ${e instanceof Error ? e.message : String(e)}`);
    }
  }, [doc, currentPage, fileName, downloadPdfBytes, preparePageDownloads, showUnsupportedGlyphWarning]);

  const handleSplitAllPages = useCallback(async () => {
    if (!doc || !engineRef.current || doc.pages.length < 2) return;
    const keys = doc.pages.map(page => page.ref.toKey());
    if (!window.confirm(`Download ${keys.length} separate PDF files (one per page)? Your browser may ask for permission.`)) return;
    try {
      const results = await preparePageDownloads(keys);
      if (!results) return;
      const base = (fileName || 'document').replace(/\.pdf$/i, '');
      for (let i = 0; i < results.length; i++) {
        downloadPdfBytes(results[i], `${base}-page-${i + 1}.pdf`);
        await new Promise((resolve) => setTimeout(resolve, 120));
      }
    } catch (e) {
      if (!showUnsupportedGlyphWarning(e)) setError(`Failed to split pages: ${e instanceof Error ? e.message : String(e)}`);
    }
  }, [doc, fileName, downloadPdfBytes, preparePageDownloads, showUnsupportedGlyphWarning]);

  const handleRemoveCurrentPage = useCallback(() => {
    if (!doc || doc.pages.length <= 1) return;
    if (!window.confirm(`Remove page ${currentPage + 1}?`)) return;
    handleDeletePage(currentPage);
  }, [doc, currentPage, handleDeletePage]);

  const handleDeleteSelectedDisplayItem = useCallback(async () => {
    if (!doc || !engineRef.current || !selectedDisplayItem) return;
    try {
      const engine = engineRef.current;
      const page = doc.pages[currentPage];
      const item = selectedDisplayItem;
      const pageKey = page.ref.toKey();
      const lease = documentOwnerRef.current.lease(doc);

      // Warn when removing a near-full-page image (common for scanned certificates)
      if (item.type === 'image') {
        const pageArea = Math.max(1, page.mediaBox.width * page.mediaBox.height);
        const imgArea = Math.max(0, item.width) * Math.max(0, item.height);
        if (imgArea / pageArea >= 0.5) {
          const ok = window.confirm(
            'This image covers most of the page. Deleting it will remove most of what you see. Continue?',
          );
          if (!ok) return;
        }
      }

      await queueNativeEdit(doc, async isCurrent => {
        const editor = new SessionDocumentEditor();
        await editor.edit(doc, `delete-${item.type}`, async staged => {
          const stagedPage = staged.pages[currentPage];
          if (!stagedPage || stagedPage.ref.toKey() !== pageKey) {
            throw new Error('The selected page changed before the object could be deleted.');
          }
          const content = engine.getPageContentBytes(stagedPage, staged.objects);
          const display = engine.interpretPage(content, stagedPage, staged.objects, new engine.OptionalContentVisibility(staged.catalog, staged.objects)).displayList;
          const target = resolveSelectedObject(display, item);
          if (!target) throw new Error('The selected object changed or is ambiguous. Select it again.');
          const editable: EditableObject = {
            id: `sel-${target.type}`,
            kind: target.type,
            bbox: { x: target.x, y: target.y, width: target.width, height: target.height },
            ctm: target.type === 'image'
              ? [target.ctm.a, target.ctm.b, target.ctm.c, target.ctm.d, target.ctm.e, target.ctm.f]
              : [1, 0, 0, 1, 0, 0],
            source: target,
          };
          await deleteObject(staged, currentPage, editable);
          if (target.type === 'path') {
            const updated = engine.getPageContentBytes(stagedPage, staged.objects);
            const remaining = engine.interpretPage(updated, stagedPage, staged.objects, new engine.OptionalContentVisibility(staged.catalog, staged.objects)).displayList;
            if (resolveSelectedObject(remaining, target)) {
              throw new Error('The selected drawing could not be safely removed.');
            }
          }
        }, { isCurrent });
        if (!isCurrent()) throw new Error('The document was replaced before the edit completed.');
        pushEditorHistory(`delete-${item.type}`, undefined, currentPage, false, editor);
      });
      if (!lease.isCurrent()) return;
      setSelectedDisplayItem(current =>
        current && selectionPageRef.current?.ref.toKey() === pageKey && resolveSelectedObject([current], item)
          ? null : current,
      );
      setIsDirty(true);
      setRenderKey(k => k + 1);
      setThumbnailKey(k => k + 1);
    } catch (e) {
      console.error('[Editor] Delete object failed:', e);
      setError(`Delete failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }, [doc, currentPage, selectedDisplayItem, pushEditorHistory, queueNativeEdit, setThumbnailKey]);

  const handleInsertBlankPage = useCallback(async (index: number) => {
    if (!doc || !engineRef.current) return;
    try {
      const engine = engineRef.current;
      await commitPageOperation('insert-blank-page', async (staged, selected) => {
        engine.insertBlankPage(staged, index);
        return selected >= index ? selected + 1 : selected;
      });
    } catch (e) {
      setError(`Failed to insert blank page: ${e instanceof Error ? e.message : String(e)}`);
    }
  }, [doc, commitPageOperation]);

  const handleInsertPdf = useCallback(async (index: number, file: File) => {
    if (!doc || !engineRef.current) return;
    try {
      const engine = engineRef.current;
      let changes: Array<{ from: string; to: string }> = [];
      await commitPageOperation('insert-pages', async (staged, selected) => {
        const sourceDoc = await engine.parsePDF(new Uint8Array(await file.arrayBuffer()));
        if (engine.securityEngine.isEncrypted(sourceDoc)) throw new Error('The source PDF is password protected. Unlock and save a copy before inserting.');
        changes = engine.insertPagesFromDocument(staged, sourceDoc, index);
        return selected >= index ? selected + sourceDoc.pages.length : selected;
      });
      setRenamedFields(changes);
    } catch (e) {
      setError(`Failed to insert PDF: ${e instanceof Error ? e.message : String(e)}`);
    }
  }, [doc, commitPageOperation]);

  const redactionTransientRef = useRef({ linkPopoverMode, linkCreatePending, signatureCreateOpen, editStyleOverrides });
  useLayoutEffect(() => { redactionTransientRef.current = { linkPopoverMode, linkCreatePending, signatureCreateOpen, editStyleOverrides }; },
    [linkPopoverMode, linkCreatePending, signatureCreateOpen, editStyleOverrides]);
  const applyRedaction = useCallback(async (mode: 'marks' | 'region' | 'page'): Promise<{ message: string; revision: number; editRevision: number; pageKey: string }> => {
    if (!doc || !engineRef.current || !renderReadyRef.current) throw new Error('Wait for the current page to finish rendering.');
    if (isSaving || cryptoSignBusy || searchBusy || historyBusyRef.current || closeOperationRef.current || downloadOperationRef.current) {
      throw new Error('Wait for the current operation to finish before redacting.');
    }
    const engine = engineRef.current;
    const pageKey = doc.pages[currentPage]?.ref.toKey();
    if (!pageKey) throw new Error('The current page is unavailable.');
    const selected = redactionRegion;
    if (mode === 'region' && (!selected || selected.pageKey !== pageKey || selected.scale !== scale || selected.revision !== renderKey)) {
      throw new Error('Select the region again on the current page.');
    }
    const viewCurrent = () => {
      const view = redactionViewRef.current;
      return view.doc === doc && view.page === currentPage && currentPageRef.current === currentPage && view.scale === scale && view.revision === renderKey &&
        view.tool === 'security' && renderReadyRef.current && doc.pages[currentPage]?.ref.toKey() === pageKey;
    };
    const inputsClear = () => !editingLineRef.current && !editingBlockIdRef.current && !editAnchorLineRef.current &&
      !undoSnapshotRef.current && pendingStylesRef.current.length === 0 && redactionTransientRef.current.editStyleOverrides.length === 0 && !isDrawingRef.current &&
      currentDrawPath.current.length === 0 && !shapeStartRef.current && !shapeEndRef.current && !eraseChangedRef.current &&
      erasedAnnotationsRef.current.size === 0 && !formComposingRef.current && !redactionDragRef.current &&
      !formDraftControllerRef.current.get() && !floatingTextEditStartRef.current && !dragInfo.current &&
      !replacingImageIdRef.current && !replacingEmbeddedImageRef.current && !historyBusyRef.current &&
      !redactionTransientRef.current.linkPopoverMode && !redactionTransientRef.current.linkCreatePending && !redactionTransientRef.current.signatureCreateOpen &&
      drawnPathsRef.current.length === 0 && floatingTextsRef.current.length === 0 &&
      floatingImagesRef.current.length === 0 && signaturesRef.current.length === 0;
    if (!inputsClear()) throw new Error('Finish or save pending text, form, drawing, image and signature overlays before redacting. Your work is preserved.');
    let pages = 0;
    await queueNativeEdit(doc, async isCurrent => {
      if (!isCurrent() || !inputsClear() || !viewCurrent()) throw new Error('The document, page view or pending work changed. Try redaction again.');
      if (doc.decryptedFromEncrypted || doc.xref.trailerDict.has('Encrypt') || hasDocumentSignature(doc)) {
        throw new Error('Redaction is unavailable for signed or protected PDFs. The document was not changed.');
      }
      const editor = new SessionDocumentEditor();
      await editor.edit(doc, 'secure-redaction', async staged => {
        if (mode !== 'marks') {
          const inspection = await engine.securityEngine.inspector.inspectFull(staged);
          if (!inspection.redactionMarksComplete || inspection.redactionMarks > 0) {
            throw new Error('Existing redaction marks must be applied or removed before selecting another region.');
          }
          const pageIndex = staged.pages.findIndex(page => page.ref.toKey() === pageKey);
          if (pageIndex < 0) throw new Error('The selected page is unavailable.');
          const region = mode === 'page' ? staged.pages[pageIndex].mediaBox : selected!.pdf;
          engine.securityEngine.redaction.markRegion(staged, pageIndex, region);
        }
        const result = await engine.securityEngine.redaction.applySecureRedactions(staged);
        if (!result.pagesProcessed) throw new Error('No redaction marks were found. The document was not changed.');
        pages = result.pagesProcessed;
      }, { isCurrent: () => isCurrent() && inputsClear() && viewCurrent() });
      if (!isCurrent()) throw new Error('The document changed during redaction.');
      pushEditorHistory('secure-redaction', undefined, currentPage, false, editor);
      setRedactionRegion(null);
      setRedactionSelecting(false);
      setRedactionPreview(null);
      setRenderKey(value => value + 1);
      setThumbnailKey(value => value + 1);
      setIsDirty(true);
    });
    return { revision: renderKey + 1, editRevision: editRevisionRef.current, pageKey, message: `Redacted ${pages} page(s). ${isMobile ? 'Close this panel, then download' : 'Download'} a new copy to apply changes; the original file is unchanged. Undo restores the previous content. Independent copies elsewhere may remain.` };
  }, [doc, currentPage, scale, renderKey, redactionRegion, isSaving, cryptoSignBusy, searchBusy, queueNativeEdit, pushEditorHistory, setThumbnailKey, setIsDirty, isMobile]);


  // ── Keyboard shortcuts (global — NOT during editing) ──
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (closeDialogOpen || closeOperationRef.current || downloadOperationRef.current) return;
      // Don't intercept when the hidden input has focus (editing)
      if (editingLine) return;

      // Don't intercept when the user is typing in any text box or input
      if (document.activeElement?.tagName === 'INPUT' || document.activeElement?.tagName === 'TEXTAREA') return;

      const action = editorKeyboardAction(e, {
        selectedDisplayItem: selectedDisplayItem?.type === 'image' ? 'image' : selectedDisplayItem ? 'path' : null,
        activeFloatingImage: !!activeFloatingImageId,
        activeFloatingText: !!activeFloatingTextId,
        selectedSignature: !!selectedSignatureId,
        activeTool,
      });
      if (!action) return;
      // Keep navigation and search usable, but do not act on selections from
      // a page whose latest render failed or is still pending.
      if (!renderReadyRef.current && (action.type === 'nudge' || action.type === 'delete')) return;
      if (action.type === 'search') { e.preventDefault(); setIsSearchOpen(v => !v);
      } else if (action.type === 'navigate-prev') { e.preventDefault(); goToPrev();
      } else if (action.type === 'navigate-next') { e.preventDefault(); goToNext();
      } else if (action.type === 'zoom-in') { e.preventDefault(); zoomIn();
      } else if (action.type === 'zoom-out') { e.preventDefault(); zoomOut();
      } else if (action.type === 'tool') { setActiveTool(action.tool);
      } else if (action.type === 'validate-signatures') { e.preventDefault(); void handleValidateSignatures();
      } else if (action.type === 'nudge') {
        e.preventDefault();
        if (action.target === 'embedded-image') void handleEmbeddedImageMove(action.dx, action.dy, true);
        else if (action.target === 'floating-image') handleFloatingImageNudge(action.dx, action.dy);
        else handleFloatingTextNudge(action.dx, action.dy);
      } else if (action.type === 'delete' && action.target === 'signature') {
        e.preventDefault(); handleSignatureDelete(selectedSignatureId!);
      } else if (action.type === 'delete' && action.target === 'floating-text') {
        e.preventDefault();
        const nextTexts = floatingTextsRef.current.filter(p => p.id !== activeFloatingTextId);
        setFloatingTexts(nextTexts); floatingTextsRef.current = nextTexts;
        pushEditorHistory('delete-text-box', { floatingTexts: nextTexts }); setActiveFloatingTextId(null);
      } else if (action.type === 'delete' && action.target === 'floating-image') {
        e.preventDefault();
        const nextImages = floatingImagesRef.current.filter(p => p.id !== activeFloatingImageId);
        setFloatingImages(nextImages); floatingImagesRef.current = nextImages;
        pushEditorHistory('delete-image', { floatingImages: nextImages }); setActiveFloatingImageId(null);
      } else if (action.type === 'delete' && action.target === 'embedded-image') {
        e.preventDefault(); void handleDeleteSelectedDisplayItem();
      } else if (action.type === 'escape-floating-text') {
        e.preventDefault();
        setActiveFloatingTextId(null);
        setActiveTool('select');
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [goToPrev, goToNext, zoomIn, zoomOut, editingLine, selectedDisplayItem, activeFloatingImageId, activeFloatingTextId, selectedSignatureId, handleSignatureDelete, activeTool, handleValidateSignatures, handleEmbeddedImageMove, handleFloatingImageNudge, handleFloatingTextNudge, handleDeleteSelectedDisplayItem, pushEditorHistory, closeDialogOpen]);

  // Clean, Minimalist 3D Tilted Pink Square Rubber Block Eraser Cursor
  const eraser3dSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32"><defs><filter id="er-pinksq-shadow" x="-30%" y="-30%" width="160%" height="160%"><feDropShadow dx="1" dy="1.4" stdDeviation="1.2" flood-color="#000000" flood-opacity="0.45"/></filter><linearGradient id="er-pink-top" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#FFA8E0"/><stop offset="60%" stop-color="#FF65C8"/><stop offset="100%" stop-color="#E840A8"/></linearGradient><linearGradient id="er-pink-left" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#FF52B7"/><stop offset="100%" stop-color="#D6208A"/></linearGradient><linearGradient id="er-pink-right" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#BF157A"/><stop offset="100%" stop-color="#80094F"/></linearGradient></defs><g filter="url(#er-pinksq-shadow)"><path d="M 4 16 L 16 4 L 28 16 L 28 19 L 16 31 L 4 19 Z" fill="none" stroke="#FFFFFF" stroke-width="2.4" stroke-linejoin="round" stroke-linecap="round"/><path d="M 4 16 L 16 4 L 28 16 L 16 28 Z" fill="url(#er-pink-top)" stroke="#80094F" stroke-width="0.6"/><path d="M 4 16 L 16 28 L 16 31 L 4 19 Z" fill="url(#er-pink-left)" stroke="#80094F" stroke-width="0.6"/><path d="M 16 28 L 28 16 L 28 19 L 16 31 Z" fill="url(#er-pink-right)" stroke="#80094F" stroke-width="0.6"/><path d="M 4 16 L 16 4 L 22 10 L 10 22 Z" fill="#FFFFFF" fill-opacity="0.45"/><circle cx="4" cy="28" r="0.8" fill="#FFFFFF" stroke="#80094F" stroke-width="0.4"/></g></svg>`;
  const eraserCursorUrl = `url('data:image/svg+xml;utf8,${encodeURIComponent(eraser3dSvg)}') 4 28, auto`;

  // Hyper-Realistic 3D Apple Pencil Replica Cursor with active drawColor tip, chrome collar, ceramic cylinder body, and color cap band
  const drawPenSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32"><defs><filter id="pen3d-shadow" x="-30%" y="-30%" width="160%" height="160%"><feDropShadow dx="1" dy="1.2" stdDeviation="1" flood-color="#000000" flood-opacity="0.5"/></filter><linearGradient id="pen3d-chrome" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#E5E5EA"/><stop offset="25%" stop-color="#FFFFFF"/><stop offset="50%" stop-color="#A2A2A7"/><stop offset="80%" stop-color="#636366"/><stop offset="100%" stop-color="#2C2C2E"/></linearGradient><linearGradient id="pen3d-body" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#FFFFFF"/><stop offset="45%" stop-color="#F2F2F7"/><stop offset="80%" stop-color="#E5E5EA"/><stop offset="100%" stop-color="#D1D1D6"/></linearGradient><linearGradient id="pen3d-cap-ring" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#F2F2F7"/><stop offset="50%" stop-color="#A2A2A7"/><stop offset="100%" stop-color="#3A3A3C"/></linearGradient></defs><g filter="url(#pen3d-shadow)"><path d="M 1 31 L 5 21 L 9 16 L 23 2 L 30 9 L 16 23 L 11 27 Z" fill="none" stroke="#FFFFFF" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round" stroke-opacity="0.95"/><path d="M 9 16 L 23 2 L 30 9 L 16 23 Z" fill="url(#pen3d-body)" stroke="#2C2C2E" stroke-width="0.7" stroke-linejoin="round"/><path d="M 9 16 L 23 2 L 26 5 L 12 19 Z" fill="#FFFFFF" fill-opacity="0.6"/><line x1="12" y1="19" x2="26" y2="5" stroke="#D1D1D6" stroke-width="0.5"/><path d="M 12 19 L 26 5 L 30 9 L 16 23 Z" fill="#000000" fill-opacity="0.12"/><path d="M 18 7 L 23 2 L 28 7 L 23 12 Z" fill="${drawColor}" stroke="#2C2C2E" stroke-width="0.7" stroke-linejoin="round"/><path d="M 18 7 L 23 2 L 25.5 4.5 L 20.5 9.5 Z" fill="#FFFFFF" fill-opacity="0.4"/><path d="M 20.5 9.5 L 25.5 4.5 L 28 7 L 23 12 Z" fill="#000000" fill-opacity="0.25"/><path d="M 23 2 L 25 -0.5 C 27 -0.5 30 2.5 30.5 4.5 L 28 7 Z" fill="url(#pen3d-cap-ring)" stroke="#1C1C1E" stroke-width="0.7"/><path d="M 5 21 L 9 16 L 16 23 L 11 27 Z" fill="url(#pen3d-chrome)" stroke="#2C2C2E" stroke-width="0.7" stroke-linejoin="round"/><path d="M 1 31 L 5 21 L 11 27 Z" fill="#F4F4F6" stroke="#2C2C2E" stroke-width="0.7" stroke-linejoin="round"/><path d="M 1 31 L 5 21 L 8 24 Z" fill="#FFFFFF" fill-opacity="0.5"/><path d="M 1 31 L 3.5 25 L 7 28.5 Z" fill="${drawColor}" stroke="#1C1C1E" stroke-width="0.6" stroke-linejoin="round"/><path d="M 1 31 L 3.5 25 L 5.25 26.75 Z" fill="#FFFFFF" fill-opacity="0.45"/><path d="M 1 31 L 5.25 26.75 L 7 28.5 Z" fill="#000000" fill-opacity="0.2"/><circle cx="1" cy="31" r="0.75" fill="#FFFFFF" stroke="#000000" stroke-width="0.4"/></g></svg>`;
  const penCursorUrl = `url('data:image/svg+xml;utf8,${encodeURIComponent(drawPenSvg)}') 1 31, crosshair`;

  // Hyper-Realistic 3D Apple-style Highlighter Marker Replica Cursor with active highlightColor chisel tip, ribbed grip, and glass ink chamber
  const highlighterMarkerSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32"><defs><filter id="hl3d-shadow" x="-30%" y="-30%" width="160%" height="160%"><feDropShadow dx="1" dy="1.2" stdDeviation="1" flood-color="#000000" flood-opacity="0.5"/></filter><linearGradient id="hl3d-barrel" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#545456"/><stop offset="35%" stop-color="#3A3A3C"/><stop offset="70%" stop-color="#2C2C2E"/><stop offset="100%" stop-color="#1C1C1E"/></linearGradient><linearGradient id="hl3d-grip" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#8E8E93"/><stop offset="40%" stop-color="#636366"/><stop offset="80%" stop-color="#3A3A3C"/><stop offset="100%" stop-color="#1C1C1E"/></linearGradient><linearGradient id="hl3d-cap" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#AEAEB2"/><stop offset="50%" stop-color="#636366"/><stop offset="100%" stop-color="#2C2C2E"/></linearGradient></defs><g filter="url(#hl3d-shadow)"><path d="M 2 28 L 7 20 L 12 14 L 23 3 L 29 9 L 18 20 L 12 26 L 6 30 Z" fill="none" stroke="#FFFFFF" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round" stroke-opacity="0.95"/><path d="M 12 14 L 23 3 L 29 9 L 18 20 Z" fill="url(#hl3d-barrel)" stroke="#1C1C1E" stroke-width="0.7" stroke-linejoin="round"/><path d="M 12 14 L 23 3 L 25.5 5.5 L 14.5 16.5 Z" fill="#FFFFFF" fill-opacity="0.18"/><path d="M 16 10 L 21 5 L 25.5 9.5 L 20.5 14.5 Z" fill="${highlightColor}" stroke="#1C1C1E" stroke-width="0.7" stroke-linejoin="round"/><path d="M 16 10 L 21 5 L 23.25 7.25 L 18.25 12.25 Z" fill="#FFFFFF" fill-opacity="0.5"/><path d="M 18.25 12.25 L 23.25 7.25 L 25.5 9.5 L 20.5 14.5 Z" fill="#000000" fill-opacity="0.2"/><path d="M 23 3 L 25.5 0.5 C 27.5 0.5 30.5 3.5 31 5.5 L 29 9 Z" fill="url(#hl3d-cap)" stroke="#1C1C1E" stroke-width="0.7"/><path d="M 7 20 L 12 14 L 18 20 L 12 26 Z" fill="url(#hl3d-grip)" stroke="#1C1C1E" stroke-width="0.7" stroke-linejoin="round"/><line x1="8.5" y1="18.5" x2="13.5" y2="23.5" stroke="#1C1C1E" stroke-width="0.6"/><line x1="10" y1="16.5" x2="15" y2="21.5" stroke="#1C1C1E" stroke-width="0.6"/><path d="M 2 28 L 7 20 L 12 26 L 6 30 Z" fill="${highlightColor}" stroke="#1C1C1E" stroke-width="0.7" stroke-linejoin="round"/><path d="M 2 28 L 7 20 L 9.5 23 Z" fill="#FFFFFF" fill-opacity="0.6"/><path d="M 2 28 L 9.5 23 L 12 26 L 6 30 Z" fill="#000000" fill-opacity="0.22"/><line x1="2" y1="28" x2="6" y2="30" stroke="#FFFFFF" stroke-width="1.2" stroke-linecap="round"/></g></svg>`;
  const highlightCursorUrl = `url('data:image/svg+xml;utf8,${encodeURIComponent(highlighterMarkerSvg)}') 2 28, pointer`;

  const cursorForTool = isPanning ? 'grabbing'
    : spacePanHeld || (scale > 1 && !['draw', 'highlight', 'erase', 'sign'].includes(activeTool)) ? 'grab'
    : activeTool === 'text' ? 'text'
      : activeTool === 'draw' ? penCursorUrl
        : activeTool === 'highlight' ? highlightCursorUrl
          : activeTool === 'erase' ? eraserCursorUrl
            : activeTool === 'sign' ? 'default'
              : activeTool === 'select' ? 'grab'
                : 'default';

  const isPanIgnoreTarget = useCallback((target: EventTarget | null) => {
    if (!(target instanceof Element)) return false;
    return !!target.closest(
      'textarea, input, button, a, [data-no-pan], [contenteditable="true"]',
    );
  }, []);

  const endPanDrag = useCallback((pointerId?: number) => {
    const drag = panDragRef.current;
    if (!drag) return false;
    if (pointerId != null && drag.pointerId !== pointerId) return false;
    const didPan = drag.moved;
    panDragRef.current = null;
    setIsPanning(false);
    const viewport = scrollViewportRef.current;
    try {
      viewport?.releasePointerCapture(drag.pointerId);
    } catch {
      // ignore
    }
    return didPan;
  }, []);

  const handleViewportPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 && e.button !== 1) return;
    if (isPanIgnoreTarget(e.target)) return;

    const middle = e.button === 1;
    const leftPan =
      e.button === 0 &&
      (spacePanHeld ||
        (scale > 1 && !['draw', 'highlight', 'erase'].includes(activeTool)));
    if (!middle && !leftPan) return;

    const viewport = scrollViewportRef.current;
    if (!viewport) return;

    if (
      e.button === 0 &&
      !spacePanHeld &&
      (e.target as Element).closest?.('.absolute.z-20, [data-edit-box], [data-resize-handle]')
    ) {
      return;
    }

    panDragRef.current = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      scrollLeft: viewport.scrollLeft,
      scrollTop: viewport.scrollTop,
      moved: false,
    };

    if (middle || spacePanHeld) {
      setIsPanning(true);
      try {
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      } catch {
        // ignore
      }
      e.preventDefault();
    }
  }, [activeTool, scale, spacePanHeld, isPanIgnoreTarget]);

  const handleViewportPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const drag = panDragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    const viewport = scrollViewportRef.current;
    if (!viewport) return;

    const dx = e.clientX - drag.startX;
    const dy = e.clientY - drag.startY;
    if (!drag.moved) {
      if (Math.abs(dx) <= 3 && Math.abs(dy) <= 3) return;
      drag.moved = true;
      setIsPanning(true);
      try {
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      } catch {
        // ignore
      }
    }
    // Flex + justify-center breaks scrollLeft; pan via scroll on a max-content wrapper.
    viewport.scrollLeft = drag.scrollLeft - dx;
    viewport.scrollTop = drag.scrollTop - dy;
  }, []);

  const handleViewportPointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const didPan = endPanDrag(e.pointerId);
    if (didPan) {
      e.preventDefault();
      e.stopPropagation();
    }
  }, [endPanDrag]);

  // Space = temporary hand tool (Photoshop-style)
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (closeDialogOpen || closeOperationRef.current || downloadOperationRef.current) return;
      if (e.code !== 'Space' || e.repeat) return;
      if (editingLine) return;
      if (document.activeElement?.tagName === 'INPUT' || document.activeElement?.tagName === 'TEXTAREA') return;
      e.preventDefault();
      setSpacePanHeld(true);
    }
    function onKeyUp(e: KeyboardEvent) {
      if (e.code !== 'Space') return;
      setSpacePanHeld(false);
      if (!panDragRef.current) setIsPanning(false);
    }
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    };
  }, [editingLine, closeDialogOpen]);

  // ── Loading state ──
  if (isLoading) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center bg-surface text-app-muted">
        <div className="w-8 h-8 border-4 border-[var(--border)] border-t-accent rounded-full animate-spin" />
        <p className="mt-4 text-sm font-medium animate-pulse">Processing PDF...</p>
      </div>
    );
  }

  // ── Password prompt for encrypted PDFs ──
  if (needsPassword && !doc) {
    return (
      <div className="min-h-screen bg-surface">
        <PasswordDialog
          fileName={fileName}
          error={passwordError}
          isVerifying={isVerifyingPassword}
          onSubmit={handlePasswordSubmit}
          onCancel={handleClose}
        />
      </div>
    );
  }

  // ── Error state ──
  if (error && !doc) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center font-sans bg-surface text-app">
        <p className="text-red-500 text-sm max-w-[400px] text-center leading-relaxed">
          {error}
        </p>
        <button
          onClick={handleClose}
          className="mt-6 px-4 py-2 rounded-lg border border-app text-app-muted hover:bg-panel-elevated transition-colors flex items-center gap-2"
        >
          <ChevronLeft size={16} /> Go Back
        </button>
      </div>
    );
  }

  // ── Main editor UI ──
  return (
    <div inert={isDownloading || isCheckingClose} className="flex flex-col h-screen font-sans bg-surface text-app overflow-hidden">

      {/* ── Top toolbar ── */}
      <Toolbar
        fileName={fileName}
        currentPage={currentPage}
        totalPages={totalPages}
        scale={scale}
        drawnPaths={drawnPaths.filter(path => path.pageKey === doc?.pages[currentPage]?.ref.toKey())}
        isSaving={isSaving}
        canUndo={canUndo}
        canRedo={canRedo}
        onClose={handleClose}
        onPrevPage={goToPrev}
        onNextPage={goToNext}
        onZoomIn={zoomIn}
        onZoomOut={zoomOut}
        onUndo={handleUndo}
        onRedo={handleRedo}
        onClearPaths={async () => {
          let editor: SessionDocumentEditor | undefined;
          const lease = doc ? documentOwnerRef.current.lease(doc) : null;
          try {
            await annotationCommitPendingRef.current;
            if (lease && !lease.isCurrent()) return;
            if (doc && engineRef.current) {
              const { textMarkup, legacy } = collectMarkupRemovals(doc, currentPage, engineRef.current.clearMarkupAnnotationsOnPage);
              if (textMarkup.length > 0) {
                editor = new SessionDocumentEditor();
                await editor.edit(doc, 'clear-markup', async staged => { removeMarkupReferences(staged, currentPage, textMarkup); }, { isCurrent: lease?.isCurrent });
                if (lease && !lease.isCurrent()) return;
              }
              removeMarkupReferences(doc, currentPage, legacy);
              const remainingPaths = drawnPathsRef.current.filter(path => path.pageKey !== doc.pages[currentPage].ref.toKey());
              setDrawnPaths(remainingPaths);
              drawnPathsRef.current = remainingPaths;
              pushEditorHistory('clear-markup', { drawnPaths: remainingPaths }, undefined, false, editor);
              // The byte boundary covers text markup; keep legacy clear redo coverage.
              if (editor && (legacy.length > 0 || drawnPaths.length > 0)) {
                pushEditorHistory('clear-markup', { drawnPaths: remainingPaths }, undefined, true);
              }
              if (editor) setThumbnailKey(k => k + 1);
            } else {
              setDrawnPaths([]);
              drawnPathsRef.current = [];
              pushEditorHistory('clear-markup', { drawnPaths: [] });
            }
            setIsDirty(true);
            setRenderKey(k => k + 1);
          } catch (error) {
            console.warn('[Editor] Clear markup failed:', error);
          }
        }}
        onDownload={handleDownload}
        saveMode={saveMode}
        onSaveModeChange={setSaveMode}
        isSearchOpen={isSearchOpen}
        onToggleSearch={() => setIsSearchOpen(!isSearchOpen)}
        onExport={async () => {
          await annotationCommitPendingRef.current;
          await documentOwnerRef.current.whenIdle();
          setShowExportPanel(true);
        }}
        doc={doc}
        onCompressedDownload={handleCompressedDownload}
        isFocusMode={isFocusMode}
        onToggleFocusMode={isMobile ? undefined : () => setIsFocusMode(v => !v)}
        isThumbnailsOpen={isThumbnailsOpen && !isFocusMode}
        onToggleThumbnails={isMobile ? undefined : () => {
          // Showing pages while focused leaves Focus Mode; the options panel keeps its own state.
          if (isFocusMode) {
            setIsFocusMode(false);
            setIsThumbnailsOpen(true);
          } else {
            setIsThumbnailsOpen(v => !v);
          }
        }}
      />

      <PdfConformanceNotice doc={doc} isDirty={isDirty} />
      <div className="flex-1 flex relative min-h-0 overflow-hidden">

        {/* ── Left sidebar (Tools only) — on mobile renders as fixed bottom strip ── */}
        <ToolsSidebar
          activeTool={activeTool}
          setActiveTool={setActiveTool}
          highlightColor={highlightColor}
          isPanelOpen={isPanelOpen && !isFocusMode}
          isFocusMode={isFocusMode}
          onTogglePanel={() => {
            // The panel button also leaves Focus Mode and shows the options panel.
            if (isFocusMode) {
              setIsFocusMode(false);
              setIsPanelOpen(true);
            } else {
              setIsPanelOpen(v => !v);
            }
          }}
          isMobile={isMobile}
        />

        {/* ── Left Sidebar (Properties / Security) ── */}
        {isPanelOpen && !isFocusMode && (
          activeTool === 'security' ? (
            <SecurityPanel
              doc={doc}
              engine={engineModule}
              onDocChange={(d) => {
                setDoc(d);
                setIsDirty(true);
              }}
              markDirty={() => setIsDirty(true)}
              onBusyChange={(busy) => { securityBusyRef.current = busy; setSecurityBusy(busy); }}
              onRedact={applyRedaction}
              documentRevision={renderKey}
              documentEditRevision={editRevision}
              documentPageKey={doc?.pages[currentPage]?.ref.toKey()}
              onSelectRedactionRegion={() => {
                if (!renderReadyRef.current) { setError('Wait for the current page to finish rendering.'); return; }
                setRedactionRegion(null);
                setRedactionSelecting(true);
              }}
              onCancelRedactionRegion={() => { setRedactionSelecting(false); setRedactionRegion(null); setRedactionPreview(null); redactionDragRef.current = null; }}
              selectingRedactionRegion={redactionSelecting}
              hasRedactionRegion={!!redactionRegion}
              onClose={() => { setIsPanelOpen(false); setRedactionSelecting(false); setRedactionRegion(null); setRedactionPreview(null); }}
              isMobile={isMobile}
            />
          ) : (
            <div className="contents" inert={!renderReady}>
            <PropertiesSidebar
              activeTool={activeTool}
              setActiveTool={setActiveTool}
              onClose={() => setIsPanelOpen(false)}
              selectedRun={selectedLine?.runs[0] ?? null}
          textFontFamily={textFontFamily}
          setTextFontFamily={handleTextFontFamily}
          textFontSize={textFontSize}
          setTextFontSize={handleTextFontSize}
          textBold={textBold}
          setTextBold={handleTextBold}
          textItalic={textItalic}
          setTextItalic={handleTextItalic}
          textUnderline={textUnderline}
          setTextUnderline={handleTextUnderline}
          textColor={textColor}
          setTextColor={handleTextColor}
          textAlign={textAlign}
          setTextAlign={handleTextAlign}
          textOpacity={textOpacity}
          setTextOpacity={setTextOpacity}
          replacingImageIdRef={replacingImageIdRef}
          fileInputRef={fileInputRef}
          drawColor={drawColor}
          setDrawColor={setDrawColor}
          drawSize={drawSize}
          setDrawSize={setDrawSize}
          drawMode={drawMode}
          setDrawMode={setDrawMode}
          highlightColor={highlightColor}
          setHighlightColor={setHighlightColor}
          highlightSize={highlightSize}
          setHighlightSize={setHighlightSize}
          eraserSize={eraserSize}
          setEraserSize={setEraserSize}
          pageLinkCount={pageLinks.length}
          linksHighlighted={linksHighlighted}
          onScanLinks={() => {
            if (!doc || !engineRef.current) return;
            try {
              const links = engineRef.current.listPageLinks(doc, currentPage);
              setPageLinks(links);
              setLinksHighlighted(true);
              setLinkCreatePending(false);
              closeLinkPopover();
              if (links.length === 0) {
                window.alert('No links found on this page.');
              }
            } catch (err) {
              console.warn('[Editor] Scan links failed:', err);
            }
          }}
          hasSelectedLink={false}
          linkCreatePending={linkCreatePending}
          selectedLinkUrl={linkDraftUrl}
          onSelectedLinkUrlChange={setLinkDraftUrl}
          onSaveSelectedLink={async () => {
            if (!doc || !engineRef.current) return;
            const url = linkDraftUrl.trim();
            if (!url || url === 'https://') return;

            // Create from current text selection / line
            const line = editAnchorLineRef.current ?? selectedLine ?? editingLine;
            if (!line) {
              window.alert('Select or click a text line first, then add a link.');
              return;
            }
            const sel = editSelRef.current;
            let start = 0;
            let end = line.text.length;
            if (editingLine && sel.end > sel.start) {
              start = sel.start;
              end = sel.end;
            } else if (editingLine) {
              const range = resolveEditStyleRange(line, sel.start, sel.end);
              start = range.start;
              end = range.end;
            }
            const noSelection = new Error('Select some text first, then add a link.');
            const engine = engineRef.current;
            const lease = documentOwnerRef.current.lease(doc);
            try {
              await queueNativeEdit(doc, async isCurrent => {
                const editor = new SessionDocumentEditor();
                await editor.edit(doc, 'add-link', async staged => {
                  const ref = engine.addLinkFromLineSelection(staged, currentPage, line, start, end, url);
                  if (!ref) throw noSelection;
                }, { isCurrent });
                if (!isCurrent()) throw new Error('The document was replaced before link creation completed.');
                pushEditorHistory('add-link', undefined, undefined, false, editor);
              });
              if (!lease.isCurrent()) return;
              setLinkCreatePending(false);
              setLinkDraftUrl('');
              setLinksHighlighted(true);
              setIsDirty(true);
              setRenderKey(k => k + 1);
              setThumbnailKey(k => k + 1);
            } catch (err) {
              if (err === noSelection) window.alert(noSelection.message);
              else {
                console.warn('[Editor] Add link failed:', err);
                setError(`Add link failed: ${err instanceof Error ? err.message : String(err)}`);
              }
            }
          }}
          onRemoveSelectedLink={() => {
            setLinkCreatePending(false);
            setLinkDraftUrl('');
          }}
          onAddLink={() => {
            const line = editAnchorLineRef.current ?? selectedLine ?? editingLine;
            if (!line) {
              window.alert('Select or click a text line first, then add a link.');
              return;
            }
            closeLinkPopover();
            setLinkCreatePending(true);
            setLinkDraftUrl('https://');
            setActiveTool('text');
          }}
          selectedDisplayItem={selectedDisplayItem}
          setSelectedDisplayItem={setSelectedDisplayItem}
          onDeleteSelectedDisplayItem={handleDeleteSelectedDisplayItem}
          onReplaceSelectedImage={handleReplaceEmbeddedImage}
          onCommitSelectedImageBox={handleEmbeddedImageResize}
          onPreviewSelectedImageBox={handleImageBoxPreview}
          selectedImagePageBox={doc?.pages[currentPage]?.mediaBox}
          onClearImageReplaceMode={() => { replacingEmbeddedImageRef.current = null; }}
          displayItems={displayItems}
          formFields={formFields}
          selectedFormField={selectedFormField}
          formFieldDraft={formFieldDraft}
          onFormFieldSelect={handleFormFieldSelect}
          onFormFieldChange={handleFormFieldChange}
          onFormFieldDraftChange={handleFormFieldDraftChange}
          onFormFieldCommit={() => { void commitFormFieldDraft(); }}
          onFormFieldCompositionChange={(active) => { formComposingRef.current = active; }}
          onFlattenForms={handleFlattenForms}
          onDuplicateLineBelow={handleDuplicateLineBelow}
          tableInfo={selectedTableCell ? {
            rows: selectedTableCell.table.rows,
            cols: selectedTableCell.table.cols,
            row: selectedTableCell.cell.row,
            col: selectedTableCell.cell.col,
          } : null}
          onAddTableRow={handleAddTableRow}
          onAddTableColumn={handleAddTableColumn}
          watermarkType={watermarkType}
          setWatermarkType={setWatermarkType}
          watermarkShapeType={watermarkShapeType}
          setWatermarkShapeType={setWatermarkShapeType}
          watermarkShapeColor={watermarkShapeColor}
          setWatermarkShapeColor={setWatermarkShapeColor}
          watermarkImageFile={watermarkImageFile}
          onWatermarkImageUpload={handleWatermarkImageUpload}
          onWatermarkImageClear={handleWatermarkImageClear}
          watermarkText={watermarkText}
          setWatermarkText={setWatermarkText}
          watermarkFontName={watermarkFontName}
          setWatermarkFontName={setWatermarkFontName}
          watermarkOpacity={watermarkOpacity}
          setWatermarkOpacity={setWatermarkOpacity}
          watermarkRotation={watermarkRotation}
          setWatermarkRotation={setWatermarkRotation}
          watermarkSize={watermarkSize}
          setWatermarkSize={setWatermarkSize}
          watermarkPosition={watermarkPosition}
          setWatermarkPosition={setWatermarkPosition}
          watermarkBlendMode={watermarkBlendMode}
          setWatermarkBlendMode={setWatermarkBlendMode}
          watermarkMosaic={watermarkMosaic}
          setWatermarkMosaic={setWatermarkMosaic}
          watermarkPageFrom={watermarkPageFrom}
          setWatermarkPageFrom={setWatermarkPageFrom}
          watermarkPageTo={watermarkPageTo}
          setWatermarkPageTo={setWatermarkPageTo}
          watermarkLayer={watermarkLayer}
          setWatermarkLayer={setWatermarkLayer}
          watermarkColor={watermarkColor}
          setWatermarkColor={setWatermarkColor}
          watermarkLivePreview={watermarkLivePreview}
          setWatermarkLivePreview={setWatermarkLivePreview}
          onApplyWatermark={handleApplyWatermark}
          hasScannedWatermarks={detectedWatermarks !== null}
          detectedWatermarksCount={detectedWatermarks?.length}
          onScanWatermarks={handleScanWatermarks}
          onRemoveWatermarks={handleConfirmRemoveWatermarks}
          onCancelScan={handleCancelScan}
          // Signature tool
          signatureLibraryEntries={signatureLibraryEntries}
          activeLibraryId={activeLibraryId}
          setActiveLibraryId={setActiveLibraryId}
          selectedSignatureId={selectedSignatureId}
          selectedSignature={signatures.find((s) => s.id === selectedSignatureId) ?? null}
          onOpenSignatureCreate={() => setSignatureCreateOpen(true)}
          onSignatureDelete={handleSignatureDelete}
          onSignatureOpacity={handleSignatureOpacity}
          onSignatureLockToggle={handleSignatureLockToggle}
          onSignatureRotate={handleSignatureRotate}
          onLibraryRename={handleLibraryRename}
          onLibraryDelete={handleLibraryDelete}
          onLibraryDuplicate={handleLibraryDuplicate}
          onLibraryFavorite={handleLibraryFavorite}
          pdfSignatureFields={pdfSignatureFields}
          selectedPdfSigFieldId={selectedPdfSigFieldId}
          setSelectedPdfSigFieldId={setSelectedPdfSigFieldId}
          onPlaceIntoSelectedField={() => {
            const field = pdfSignatureFields.find((f) => f.id === selectedPdfSigFieldId);
            if (field) void placeLibrarySignatureIntoField(field);
          }}
          certificateIdentities={certificateIdentities}
          selectedCertificateId={selectedCertificateId}
          onOpenCertificateImport={() => setCertificateImportOpen(true)}
          onSelectCertificate={handleSelectCertificate}
          onCryptographicSign={() => void handleCryptographicSign()}
          cryptoSignBusy={cryptoSignBusy}
          enableTimestamp={enableTimestamp}
          setEnableTimestamp={setEnableTimestamp}
          onValidateSignatures={() => void handleValidateSignatures()}
          validationBusy={validationBusy}
          validationReport={validationReport}
          onEnableLtv={handleEnableLtv}
          ltvStatus={ltvStatus}
          managedSignatures={managedSignatures}
          revisionEntries={revisionEntries}
          isMobile={isMobile}
        />
            </div>
      )
    )}

        <input
          type="file"
          accept="image/*"
          ref={fileInputRef}
          className="hidden"
          onChange={handleImageUpload}
        />

        {/* Canvas-local layers (0–99): see Z_LAYERS in ./zLayers. No new clipping. */}
        <div
          ref={scrollViewportRef}
          data-canvas-stack="true"
          className="flex-1 overflow-auto relative isolate checkerboard"
          style={{ cursor: cursorForTool, touchAction: isMobile ? 'manipulation' : (scale > 1 || spacePanHeld ? 'none' : undefined), paddingBottom: isMobile ? '56px' : undefined }}
          onPointerDown={handleViewportPointerDown}
          onPointerMove={handleViewportPointerMove}
          onPointerUp={handleViewportPointerUp}
          onPointerCancel={handleViewportPointerUp}
        >
          <UnassignedOverlays
            overlays={{ drawnPaths, floatingTexts, floatingImages }}
            pageKeys={doc?.pages.map(page => page.ref.toKey()) ?? []}
            invalidSignatures={signatures.filter(signature => !doc?.pages[signature?.pageIndex])}
            onAssign={assignRecoveredOverlay}
          />
          {/* Keep search and render status in one stack so neither covers the other. */}
          {(isSearchOpen || isRendering || pageRenderError) && (
            <div className="absolute top-4 left-4 right-4 md:left-auto z-40 flex flex-col items-end gap-3 pointer-events-none animate-in fade-in slide-in-from-top-4 duration-200">
              {isSearchOpen && (<>
              <div className="pointer-events-auto flex items-center justify-between gap-2 bg-zinc-900/95 backdrop-blur-md px-3 py-2 rounded-xl border border-zinc-700/80 shadow-lg w-full md:w-72">
                <button
                  onClick={() => void handleRecognizeText()}
                  className="flex items-center gap-2 text-xs font-semibold text-zinc-300 hover:text-white transition-colors"
                  title="OCR recognize text"
                >
                  <Type size={14} /> Recognize text (OCR)
                </button>
                {isDirty && <span className="text-[10px] text-amber-400 font-medium border-l border-zinc-700/50 pl-2">Unsaved</span>}
              </div>
              <div className="pointer-events-auto">
                <FindReplacePanel
                  findText={findText}
                  onFindTextChange={setFindText}
                  replaceText={replaceText}
                  onReplaceTextChange={setReplaceText}
                  matchCount={searchResults.length}
                  currentMatchIndex={activeMatchIndex}
                  onNextMatch={handleNextMatch}
                  onPrevMatch={handlePrevMatch}
                  onReplaceCurrent={handleReplaceCurrent}
                  onReplaceAll={handleReplaceAll}
                  caseSensitive={caseSensitive}
                  onToggleCaseSensitive={() => setCaseSensitive(v => !v)}
                  onClose={() => setIsSearchOpen(false)}
                  busy={searchBusy}
                />
                {searchResults[activeMatchIndex]?.highlightVisible === false && (
                  <p role="status" aria-live="polite" className="mt-1 max-w-72 rounded bg-zinc-800 px-2 py-1 text-xs text-zinc-200">
                    The current match cannot be highlighted reliably because of its position or clipping.
                  </p>
                )}
              </div>
              </>)}
              {isRendering && (
                <div className="bg-zinc-900/90 backdrop-blur border border-zinc-800 shadow-lg rounded-full px-4 py-2 flex items-center gap-2 text-zinc-300 text-sm font-medium animate-in slide-in-from-top-4 fade-in">
                  <Loader2 size={16} className="animate-spin text-accent" />
                  Rendering...
                </div>
              )}
              {!isRendering && pageRenderError && (
                <div role="status" className="pointer-events-auto max-w-full rounded-lg border border-red-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100">
                  <span>Unable to display this page. Your edits are preserved.</span>{' '}
                  <button type="button" className="underline" onClick={() => setRenderRetry(value => value + 1)}>
                    Retry rendering
                  </button>
                </div>
              )}
            </div>
          )}

          {/*
            Centering wrapper: minWidth 100% + width max-content so overflow scroll
            works left/right after zoom (flex justify-center on the scroller breaks scrollLeft).
          */}
          <div
            className="flex justify-center items-start py-12"
            style={{ minWidth: '100%', width: 'max-content', minHeight: '100%' }}
          >
          <div
            ref={canvasContainerRef}
            data-page-render-surface="true"
            className="relative inline-block shrink-0 shadow-[0_20px_50px_-12px_rgba(15,23,42,0.18),0_4px_16px_-2px_rgba(0,0,0,0.06),0_0_0_1px_rgba(15,23,42,0.06)] rounded-sm bg-white transition-shadow duration-300"
            aria-hidden={!renderReady}
            style={{ cursor: cursorForTool, visibility: renderReady ? 'visible' : 'hidden', pointerEvents: renderReady ? 'auto' : 'none', touchAction: !spacePanHeld && ['draw', 'highlight', 'erase'].includes(activeTool) ? 'none' : undefined }}
            onDragOver={(e) => {
              e.preventDefault();
              e.dataTransfer.dropEffect = 'copy';
            }}
            onDrop={handleSignatureDrop}
            onClick={(e) => {
              if (panDragRef.current?.moved || isPanning) {
                e.preventDefault();
                e.stopPropagation();
                return;
              }
              handleCanvasClick(e);
            }}
            onDoubleClick={handleCanvasDoubleClick}
            {...drawingPointer}
            onMouseMove={handleCanvasMouseMove}
            onMouseLeave={handleCanvasMouseLeave}
          >
            {/* PDF canvas is prepended here by the render effect */}

            {/* Overlay canvas for caret / drawings */}
            <canvas
              ref={overlayRef}
              className="absolute top-0 left-0 z-10"
              style={{
                pointerEvents: ['draw', 'highlight', 'erase'].includes(activeTool) ? 'auto' : 'none',
                cursor: cursorForTool,
              }}
            />

            {(redactionSelecting || redactionRegion) && activeTool === 'security' && (
              <div
                data-redaction-surface="true"
                className="absolute inset-0 z-50"
                style={{ pointerEvents: redactionSelecting ? 'auto' : 'none', cursor: 'crosshair', touchAction: 'none' }}
                onPointerDown={e => {
                  if (!redactionSelecting || !e.isPrimary || !renderReadyRef.current) return;
                  e.preventDefault(); e.stopPropagation();
                  const box = e.currentTarget.getBoundingClientRect();
                  const x = e.clientX - box.left, y = e.clientY - box.top;
                  const pageKey = doc?.pages[currentPage]?.ref.toKey();
                  if (!doc || !pageKey || redactionViewRef.current.tool !== 'security') return;
                  redactionDragRef.current = { pointerId: e.pointerId, x, y, width: box.width, height: box.height,
                    doc, pageKey, page: currentPage, scale, revision: renderKey };
                  setRedactionPreview({ x, y, width: 0, height: 0 });
                  e.currentTarget.setPointerCapture(e.pointerId);
                }}
                onPointerMove={e => {
                  const start = redactionDragRef.current;
                  if (!start || start.pointerId !== e.pointerId) return;
                  e.preventDefault(); e.stopPropagation();
                  const box = e.currentTarget.getBoundingClientRect();
                  const x = e.clientX - box.left, y = e.clientY - box.top;
                  setRedactionPreview({ x: Math.min(start.x, x), y: Math.min(start.y, y),
                    width: Math.abs(start.x - x), height: Math.abs(start.y - y) });
                }}
                onPointerUp={e => {
                  const start = redactionDragRef.current;
                  if (!start || start.pointerId !== e.pointerId) return;
                  e.preventDefault(); e.stopPropagation();
                  redactionDragRef.current = null;
                  const box = e.currentTarget.getBoundingClientRect();
                  const x = e.clientX - box.left, y = e.clientY - box.top;
                  try {
                    const view = redactionViewRef.current;
                    if (!doc || !renderReadyRef.current || start.doc !== doc || start.page !== currentPage ||
                        start.scale !== scale || start.revision !== renderKey || start.pageKey !== doc.pages[currentPage]?.ref.toKey() ||
                        view.doc !== doc || view.page !== currentPage || view.scale !== scale || view.revision !== renderKey || view.tool !== 'security' ||
                        Math.abs(start.width - box.width) > 0.1 || Math.abs(start.height - box.height) > 0.1) {
                      throw new Error('Page display changed. Select the redaction region again.');
                    }
                    const page = doc.pages[currentPage];
                    if (!page) throw new Error('The selected page is unavailable.');
                    const pdf = redactionRegionFromDrag(page, scale, box.width, box.height, start, { x, y });
                    setRedactionRegion({ pageKey: page.ref.toKey(), scale, revision: renderKey, pdf,
                      screen: { x: Math.min(start.x, x), y: Math.min(start.y, y), width: Math.abs(start.x - x), height: Math.abs(start.y - y) } });
                    setRedactionSelecting(false);
                    setRedactionPreview(null);
                  } catch (error) {
                    setRedactionPreview(null);
                    setError(error instanceof Error ? error.message : 'Could not select the redaction region.');
                  }
                }}
                onPointerCancel={e => {
                  e.stopPropagation(); redactionDragRef.current = null; setRedactionPreview(null);
                }}
              >
                {(redactionPreview || redactionRegion?.screen) && (() => {
                  const box = redactionPreview ?? redactionRegion!.screen;
                  return <div className="absolute border-2 border-red-600 bg-red-500/25 pointer-events-none"
                    style={{ left: box.x, top: box.y, width: box.width, height: box.height }} />;
                })()}
              </div>
            )}

            {/* Search matches highlights overlay */}
            {isSearchOpen && searchResults.length > 0 && searchResults
              .filter(m => m.pageIndex === currentPage && m.highlightVisible !== false)
              .flatMap((m) => {
                const isCurrent = searchResults[activeMatchIndex]?.id === m.id;
                const page = doc?.pages[currentPage];
                if (!page) return [];

                const rects = m.highlightRects ?? [{ x: m.pdfX, y: m.pdfY, width: m.pdfWidth, height: m.pdfHeight }];
                return rects.map((rect, rectIndex) => {
                  // A Form's glyph rectangle may fit its clip while CSS ring,
                  // shadow or scaling would still paint beyond that clip.
                  const boundedByForm = m.source === 'form' || !!m.parts?.some(part => part.source === 'form');
                  const bounds = searchHighlightBounds(rect, page, scale, !!m.highlightClipped || boundedByForm);
                  if (!bounds) return null;
                  const w = bounds.clipped ? bounds.width : Math.max(bounds.width, 4);
                  const h = bounds.clipped ? bounds.height : Math.max(bounds.height, 8);

                  return (
                    <div
                      key={`${m.id}-${rectIndex}`}
                      data-search-highlight="true"
                      className={`absolute rounded-sm pointer-events-none transition-all duration-150 ${
                        bounds.clipped
                          ? (isCurrent ? 'bg-amber-400/80 z-30' : 'bg-yellow-300/45 z-20')
                          : isCurrent
                          ? 'bg-amber-400/80 border-2 border-amber-600 ring-4 ring-amber-400/40 shadow-lg scale-[1.04] z-30'
                          : 'bg-yellow-300/45 border border-yellow-500/80 shadow-sm z-20 hover:bg-yellow-300/70'
                      }`}
                      style={{
                        left: bounds.left,
                        top: bounds.top,
                        width: w,
                        height: h,
                      }}
                    />
                  );
                });
              })}

            {/* DOM overlays for FloatingText */}
            {activeTool === 'watermark' && watermarkLivePreview && (
              <WatermarkPreview
                doc={doc}
                currentPage={currentPage}
                scale={scale}
                watermarkType={watermarkType}
                watermarkText={watermarkText}
                watermarkFontName={watermarkFontName}
                watermarkSize={watermarkSize}
                watermarkColor={watermarkColor}
                watermarkOpacity={watermarkOpacity}
                watermarkRotation={watermarkRotation}
                watermarkMosaic={watermarkMosaic}
                watermarkPosition={watermarkPosition}
                watermarkImageDims={watermarkImageDims}
                watermarkImageFile={watermarkImageFile}
                watermarkShapeType={watermarkShapeType}
                watermarkShapeColor={watermarkShapeColor}
                watermarkBlendMode={watermarkBlendMode}
              />
            )}

            {/* Detected watermarks dotted boxes */}
            {activeTool === 'watermark' && detectedWatermarks?.filter(d => d.pageIndex === currentPage).map(dw =>
              dw.positions.map((pos, i) => {
                const { cssX, cssY } = pdfToCanvas(
                  pos.x,
                  pos.y,
                  scale,
                  doc?.pages[currentPage]?.mediaBox.height || 0,
                  doc?.pages[currentPage]?.mediaBox.x || 0,
                  doc?.pages[currentPage]?.mediaBox.y || 0
                );
                const boxW = (pos.width || 120) * scale;
                const boxH = (pos.height || 60) * scale;
                const rot = pos.rotation ?? dw.rotation ?? 0;

                return (
                  <div
                    key={`det-${dw.id}-${i}`}
                    className="absolute border-2 border-red-500 border-dashed bg-red-500/20 rounded z-50 pointer-events-none animate-in fade-in zoom-in duration-200"
                    style={{
                      left: cssX,
                      top: cssY,
                      width: boxW,
                      height: boxH,
                      transform: `translate(-50%, -50%) rotate(${-rot}deg)`
                    }}
                  />
                );
              })
            )}

            {/* Interactive overlay for selected embedded PDF image */}
            {activeTool === 'select' && selectedDisplayItem?.type === 'image' && renderResult && doc && (() => {
              const item = selectedDisplayItem as ImageItem;
              const page = doc.pages[currentPage];
              const { mediaBox } = page;
              return (
                <EmbeddedImageOverlay
                  catalog={doc.catalog}
                  item={item}
                  previewBox={activeTool === 'select' && imageBoxPreview?.item === item ? imageBoxPreview.box : null}
                  page={page}
                  objects={doc.objects}
                  scale={scale}
                  toCss={(b) => {
                    const tl = pdfToCanvas(
                      b.x, b.y + b.height,
                      scale, renderResult.pageHeight, mediaBox.x, mediaBox.y,
                    );
                    const br = pdfToCanvas(
                      b.x + b.width, b.y,
                      scale, renderResult.pageHeight, mediaBox.x, mediaBox.y,
                    );
                    return {
                      left: Math.min(tl.cssX, br.cssX),
                      top: Math.min(tl.cssY, br.cssY),
                      width: Math.abs(br.cssX - tl.cssX),
                      height: Math.abs(br.cssY - tl.cssY),
                    };
                  }}
                  onCommitMove={handleEmbeddedImageMove}
                  onCommitResize={handleEmbeddedImageResize}
                  onReplace={handleReplaceEmbeddedImage}
                  onDeselect={() => setSelectedDisplayItem(null)}
                />
              );
            })()}

            {/* Visual signatures — render above page contents */}
            {renderResult && doc && signatures.filter((s) => s.pageIndex === currentPage).map((sig) => {
              const page = doc.pages[currentPage];
              const { mediaBox } = page;
              return (
                <SignatureOverlay
                  key={sig.id}
                  signature={sig}
                  imageDataUrl={resolveSignatureImage(sig)}
                  scale={scale}
                  selected={selectedSignatureId === sig.id}
                  toCss={(b) => {
                    const tl = pdfToCanvas(
                      b.x, b.y + b.height,
                      scale, renderResult.pageHeight, mediaBox.x, mediaBox.y,
                    );
                    const br = pdfToCanvas(
                      b.x + b.width, b.y,
                      scale, renderResult.pageHeight, mediaBox.x, mediaBox.y,
                    );
                    return {
                      left: Math.min(tl.cssX, br.cssX),
                      top: Math.min(tl.cssY, br.cssY),
                      width: Math.abs(br.cssX - tl.cssX),
                      height: Math.abs(br.cssY - tl.cssY),
                    };
                  }}
                  onSelect={handleSignatureSelect}
                  onCommitMove={handleSignatureMove}
                  onCommitResize={handleSignatureResize}
                  onCommitRotate={handleSignatureRotate}
                  onDelete={handleSignatureDelete}
                  onDeselect={() => setSelectedSignatureId(null)}
                />
              );
            })}

            {/* PDF AcroForm signature field widgets */}
            {(activeTool === 'sign' || selectedPdfSigFieldId) && renderResult && doc &&
              pdfSignatureFields.map((field) => {
                const page = doc.pages[currentPage];
                const { mediaBox } = page;
                const tl = pdfToCanvas(
                  field.rect.x, field.rect.y + field.rect.height,
                  scale, renderResult.pageHeight, mediaBox.x, mediaBox.y,
                );
                const br = pdfToCanvas(
                  field.rect.x + field.rect.width, field.rect.y,
                  scale, renderResult.pageHeight, mediaBox.x, mediaBox.y,
                );
                const selected = selectedPdfSigFieldId === field.id;
                return (
                  <div
                    key={`pdf-sig-${field.id}`}
                    className={`absolute z-35 pointer-events-none border-2 border-dashed ${
                      selected ? 'border-emerald-400 bg-emerald-400/10' : 'border-sky-400/80 bg-sky-400/5'
                    }`}
                    style={{
                      left: Math.min(tl.cssX, br.cssX),
                      top: Math.min(tl.cssY, br.cssY),
                      width: Math.abs(br.cssX - tl.cssX),
                      height: Math.abs(br.cssY - tl.cssY),
                    }}
                  >
                    <span className="absolute -top-5 left-0 text-[9px] px-1 rounded bg-sky-700 text-white whitespace-nowrap">
                      {field.fieldName}{field.signed ? ' · signed' : field.hasAppearance ? ' · AP' : ''}
                    </span>
                  </div>
                );
              })}

            {floatingTexts.filter(ft => ft.pageKey === doc?.pages[currentPage]?.ref.toKey()).map(ft => {
              const { cssX, cssY } = pdfToCanvas(
                ft.pdfX,
                ft.pdfY,
                scale,
                doc?.pages[currentPage]?.mediaBox.height || 0,
                doc?.pages[currentPage]?.mediaBox.x || 0,
                doc?.pages[currentPage]?.mediaBox.y || 0
              );
              const isActive = activeFloatingTextId === ft.id;

              return (
                <div
                  key={ft.id}
                  className={`absolute z-20 cursor-move touch-none border-2 ${isActive ? 'border-accent border-dashed' : 'border-transparent hover:border-zinc-500 hover:border-dashed'} p-1 -m-1`}
                  style={{
                    left: cssX,
                    top: cssY - (ft.fontSize * scale),
                  }}
                  onPointerDown={(e) => handleFloatingTextPointerDown(e, ft.id)}
                  onClick={(e) => e.stopPropagation()}
                >
                  <div
                    aria-hidden="true"
                    data-floating-text-drag-handle
                    className="absolute inset-x-0 top-0 h-[14px] cursor-move touch-none z-10"
                    onPointerDown={(e) => {
                      if (e.pointerType !== 'mouse') {
                        handleFloatingTextPointerDown(e, ft.id);
                      }
                    }}
                  />
                  {isActive && (
                    <button
                      className="absolute -top-3 -right-3 bg-red-500 text-white rounded-full p-1 shadow hover:bg-red-600 transition-colors z-30"
                      onClick={(e) => {
                        e.stopPropagation();
                        const nextTexts = floatingTextsRef.current.filter(p => p.id !== ft.id);
                        setFloatingTexts(nextTexts);
                        floatingTextsRef.current = nextTexts;
                        pushEditorHistory('delete-text-box', { floatingTexts: nextTexts });
                        if (activeFloatingTextId === ft.id) setActiveFloatingTextId(null);
                      }}
                    >
                      <X size={12} />
                    </button>
                  )}
                  <textarea
                    value={ft.text}
                    autoFocus={isActive && activeFloatingTextId === ft.id}
                    onChange={(e) => {
                      setIsDirty(true);
                      setFloatingTexts(prev => {
                        const next = prev.map(p => p.id === ft.id ? { ...p, text: e.target.value } : p);
                        floatingTextsRef.current = next;
                        return next;
                      });
                    }}
                    onFocus={(e) => {
                      const selection = initialFloatingTextSelection(pendingFloatingTextSelectionRef.current, ft.id, ft.text);
                      if (selection) {
                        pendingFloatingTextSelectionRef.current = null;
                        e.currentTarget.setSelectionRange(...selection);
                      }
                      setActiveFloatingTextId(ft.id);
                      if (!floatingTextEditStartRef.current) {
                        floatingTextEditStartRef.current = floatingTextsRef.current.map(text => ({ ...text }));
                      }
                    }}
                    onBlur={() => {
                      const before = floatingTextEditStartRef.current;
                      const after = floatingTextsRef.current;
                      floatingTextEditStartRef.current = null;
                      if (before && JSON.stringify(before) !== JSON.stringify(after)) {
                        pushEditorHistory('edit-text-box', { floatingTexts: after });
                      }
                    }}
                    className="bg-transparent outline-none overflow-hidden block resize"
                    style={{
                      fontFamily: ft.fontFamily,
                      fontSize: ft.fontSize * scale,
                      color: ft.color,
                      fontWeight: ft.bold ? 'bold' : 'normal',
                      fontStyle: ft.italic ? 'italic' : 'normal',
                      textDecoration: ft.underline ? 'underline' : 'none',
                      opacity: ft.opacity ?? 1,
                      minWidth: '100px',
                      minHeight: `${ft.fontSize * scale * 1.5}px`,
                      width: ft.pdfWidth ? `${ft.pdfWidth * scale}px` : undefined,
                      height: ft.pdfHeight ? `${ft.pdfHeight * scale}px` : undefined,
                    }}
                    onPointerDown={e => {
                      if (e.pointerType === 'touch' || isActive) e.stopPropagation();
                    }}
                    onMouseUp={e => {
                      // Capture size after resize handle is released
                      const target = e.target as HTMLTextAreaElement;
                      const w = target.offsetWidth / scale;
                      const h = target.offsetHeight / scale;
                      setFloatingTexts(prev => prev.map(p => p.id === ft.id ? { ...p, pdfWidth: w, pdfHeight: h } : p));
                    }}
                  />
                </div>
              );
            })}

            {/* DOM overlays for FloatingImage */}
            {floatingImages.filter(fi => fi.pageKey === doc?.pages[currentPage]?.ref.toKey()).map(fi => {
              const { cssX, cssY } = pdfToCanvas(
                fi.pdfX,
                fi.pdfY,
                scale,
                doc?.pages[currentPage]?.mediaBox.height || 0,
                doc?.pages[currentPage]?.mediaBox.x || 0,
                doc?.pages[currentPage]?.mediaBox.y || 0
              );
              const isActive = activeFloatingImageId === fi.id;

              return (
                <div
                  key={fi.id}
                  className={`absolute z-20 cursor-move touch-none border-2 ${isActive ? 'border-accent border-dashed' : 'border-transparent hover:border-zinc-500 hover:border-dashed'} p-1 -m-1`}
                  style={{
                    left: cssX,
                    top: cssY,
                    width: fi.pdfWidth * scale + 8, // +8 for padding/border
                    height: fi.pdfHeight * scale + 8,
                  }}
                  onPointerDown={(e) => handleFloatingImagePointerDown(e, fi.id)}
                  onClick={(e) => e.stopPropagation()}
                >
                  <img
                    src={fi.dataUrl}
                    alt="floating"
                    className="w-full h-full object-fill pointer-events-none"
                  />

                  {isActive && (
                    <>
                      <button
                        className="absolute -top-3 -right-3 bg-red-500 text-white rounded-full p-1 shadow hover:bg-red-600 transition-colors z-30"
                        title="Delete Image"
                        onClick={(e) => {
                          e.stopPropagation();
                          const nextImages = floatingImagesRef.current.filter(p => p.id !== fi.id);
                          setFloatingImages(nextImages);
                          floatingImagesRef.current = nextImages;
                          pushEditorHistory('delete-image', { floatingImages: nextImages });
                          if (activeFloatingImageId === fi.id) setActiveFloatingImageId(null);
                        }}
                      >
                        <X size={12} />
                      </button>
                      <button
                        className="absolute -top-3 right-8 bg-bloom-500 text-white rounded-full p-1 shadow hover:bg-bloom-600 transition-colors z-30"
                        title="Replace Image"
                        data-control="replace-image"
                        onClick={(e) => {
                          e.stopPropagation();
                          replacingImageIdRef.current = fi.id;
                          fileInputRef.current?.click();
                        }}
                      >
                        <Image size={12} />
                      </button>

                      {/* Dimensions panel in cm */}
                      <div
                        className="absolute top-0 -right-[110px] bg-zinc-900 text-white rounded p-2 shadow-xl border border-zinc-700 text-xs flex flex-col gap-2 z-30 w-24"
                        onClick={e => e.stopPropagation()}
                        onPointerDown={e => e.stopPropagation()}
                      >
                        <div className="text-[9px] text-zinc-400 font-bold uppercase tracking-wider mb-0.5">Dimensions</div>
                        <div className="flex items-center justify-between gap-1">
                          <span className="text-zinc-500 w-3 text-center">W</span>
                          <input
                            type="number"
                            value={Math.round((fi.pdfWidth * 2.54 * 10) / 72) / 10}
                            onChange={e => {
                              const newW = (parseFloat(e.target.value) * 72) / 2.54;
                              if (newW > 0) setFloatingImages(prev => prev.map(p => p.id === fi.id ? { ...p, pdfWidth: newW } : p));
                            }}
                            className="w-10 bg-zinc-800 rounded px-1 py-0.5 text-right no-spinners outline-none focus:ring-1 focus:ring-accent"
                            step="0.1"
                          />
                          <span className="text-zinc-500 text-[10px]">cm</span>
                        </div>
                        <div className="flex items-center justify-between gap-1">
                          <span className="text-zinc-500 w-3 text-center">H</span>
                          <input
                            type="number"
                            value={Math.round((fi.pdfHeight * 2.54 * 10) / 72) / 10}
                            onChange={e => {
                              const newH = (parseFloat(e.target.value) * 72) / 2.54;
                              if (newH > 0) setFloatingImages(prev => prev.map(p => p.id === fi.id ? { ...p, pdfHeight: newH } : p));
                            }}
                            className="w-10 bg-zinc-800 rounded px-1 py-0.5 text-right no-spinners outline-none focus:ring-1 focus:ring-accent"
                            step="0.1"
                          />
                          <span className="text-zinc-500 text-[10px]">cm</span>
                        </div>
                      </div>
                    </>
                  )}

                  {/* Corner resize preserves proportions unless Shift is held. */}
                  <div
                    className="absolute bottom-0 right-0 w-3 h-3 cursor-se-resize bg-accent/50"
                    onPointerDown={e => {
                      e.stopPropagation(); // prevent dragging
                      const startX = e.clientX;
                      const startY = e.clientY;
                      const origin = {
                        x: fi.pdfX, y: fi.pdfY - fi.pdfHeight,
                        width: fi.pdfWidth, height: fi.pdfHeight,
                      };

                      const handleMove = (me: PointerEvent) => {
                        const resized = resizeBox(origin, 'se', {
                          dx: (me.clientX - startX) / scale,
                          dy: -(me.clientY - startY) / scale,
                          minWidth: 10, minHeight: 10, free: me.shiftKey,
                        });
                        // Floating images store their fixed top-left, not the PDF lower-left.
                        setFloatingImages(prev => prev.map(p => p.id === fi.id ? { ...p, pdfWidth: resized.width, pdfHeight: resized.height } : p));
                      };

                      const handleUp = () => {
                        window.removeEventListener('pointermove', handleMove);
                        window.removeEventListener('pointerup', handleUp);
                      };

                      window.addEventListener('pointermove', handleMove);
                      window.addEventListener('pointerup', handleUp);
                    }}
                  />
                </div>
              );
            })}

            {/* Word-like line editor — same size/position as canvas text */}
            {editingLine && editAnchorLine && renderResult && doc && (() => {
              const anchor = editAnchorLine;
              const bounds = getLineBounds(anchor);
              const page = doc.pages[currentPage];
              const { mediaBox } = page;
              const primaryRun = anchor.runs[0];
              const visualSize = primaryRun ? visualFontSize(primaryRun) : anchor.fontSize;
              // Box height follows the tallest glyph on the line (mixed sizes / overrides)
              let maxFontSizeCss = visualSize * scale;
              for (const run of anchor.runs) {
                maxFontSizeCss = Math.max(maxFontSizeCss, visualFontSize(run) * scale);
              }
              for (const ov of editStyleOverrides) {
                if (ov.fontSize != null) {
                  maxFontSizeCss = Math.max(maxFontSizeCss, ov.fontSize * scale);
                }
              }
              const tsSize = typingStyle.fontSize;
              if (tsSize != null) {
                maxFontSizeCss = Math.max(maxFontSizeCss, tsSize * scale);
              }
              // Include sidebar size while typing so the box grows with the caret style
              if (editSel.end <= editSel.start && textFontSize > 0) {
                maxFontSizeCss = Math.max(maxFontSizeCss, textFontSize * scale);
              }
              const fontSizeCss = maxFontSizeCss;
              const baseline = anchor.baseline;
              const ascent = fontSizeCss * 0.85;
              const lineHasUnderline = textUnderline || anchor.runs.some(r =>
                !!r.isUnderline || runHasPathUnderline(r, strokePaths),
              ) || editStyleOverrides.some(o => o.underline);
              const descent = fontSizeCss * (lineHasUnderline ? 0.45 : 0.25);
              const origin = pdfToCanvas(
                bounds.x,
                baseline,
                scale, renderResult.pageHeight, mediaBox.x, mediaBox.y,
              );
              const left = origin.cssX;
              const top = origin.cssY - ascent;
              const naturalWidth = Math.max(20, bounds.width * scale);
              const naturalHeight = ascent + descent;
              const fontData = primaryRun ? renderResult.fonts.get(primaryRun.fontName) : undefined;
              const [r, g, b] = primaryRun?.fillColor || [0, 0, 0];
              const colorCss = textColor.startsWith('#')
                ? textColor
                : `rgb(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)})`;

              const pathItems = strokePaths;
              const edits = distributeTextChangeToSegments(
                anchor,
                anchor.text,
                editText,
                caretPos,
              );

              type Piece = {
                start: number;
                end: number;
                text: string;
                run: TextRun;
              };
              let pieces: Piece[] = [];
              {
                let pos = 0;
                for (const edit of edits) {
                  pieces.push({
                    start: pos,
                    end: pos + edit.newText.length,
                    text: edit.newText,
                    run: edit.run,
                  });
                  pos += edit.newText.length;
                }
              }

              // Split pieces at override boundaries so bold-off only affects the selection
              for (const ov of editStyleOverrides) {
                if (ov.end <= ov.start) continue;
                const next: Piece[] = [];
                for (const p of pieces) {
                  if (ov.end <= p.start || ov.start >= p.end) {
                    next.push(p);
                    continue;
                  }
                  if (ov.start > p.start) {
                    next.push({
                      ...p,
                      end: ov.start,
                      text: p.text.slice(0, ov.start - p.start),
                    });
                  }
                  const midStart = Math.max(p.start, ov.start);
                  const midEnd = Math.min(p.end, ov.end);
                  next.push({
                    ...p,
                    start: midStart,
                    end: midEnd,
                    text: p.text.slice(midStart - p.start, midEnd - p.start),
                  });
                  if (ov.end < p.end) {
                    next.push({
                      ...p,
                      start: ov.end,
                      text: p.text.slice(ov.end - p.start),
                    });
                  }
                }
                pieces = next.filter(p => p.text.length > 0 || p.end > p.start);
              }

              const overlaySegments: OverlaySegmentStyle[] = pieces.map((piece) => {
                const run = piece.run;
                const fd = renderResult.fonts.get(run.fontName);
                const flags = resolveRunStyleFlags(run.fontName, fd);
                const faceStyle = getOverlayFontStyle(run.fontName, fd);
                // Embedded faces already carry weight — don't synthesize extra bold
                // (matches canvas renderer). Fall back to flag-based weight otherwise.
                let bold = fd?.fontBytes
                  ? faceStyle.fontWeight === 'bold' || flags.bold
                  : flags.bold;
                let italic = fd?.fontBytes
                  ? faceStyle.fontStyle === 'italic' || flags.italic
                  : flags.italic;
                // When embedded bold face is used, CSS weight stays normal
                const useEmbeddedFace = !!(fd?.fontBytes && fd.baseFont);
                let underline = !!run.isUnderline || runHasPathUnderline(run, pathItems);
                let color = run.fillColor
                  ? `rgb(${Math.round(run.fillColor[0] * 255)}, ${Math.round(run.fillColor[1] * 255)}, ${Math.round(run.fillColor[2] * 255)})`
                  : colorCss;
                let segFontSize = visualFontSize(run) * scale;
                let segFontFamily = getOverlayFontFamily(run.fontName, fd);

                for (const ov of editStyleOverrides) {
                  if (piece.start >= ov.start && piece.end <= ov.end) {
                    if (ov.bold != null) bold = ov.bold;
                    if (ov.italic != null) italic = ov.italic;
                    if (ov.underline != null) underline = ov.underline;
                    if (ov.color) color = ov.color.startsWith('#') ? ov.color : color;
                    if (ov.fontSize != null) segFontSize = ov.fontSize * scale;
                    if (ov.fontFamily) {
                      segFontFamily = cssFontFamilyFromUI(ov.fontFamily);
                    }
                  }
                }

                const hasBoldOv = editStyleOverrides.some(
                  o => piece.start >= o.start && piece.end <= o.end && o.bold != null,
                );
                const hasItalicOv = editStyleOverrides.some(
                  o => piece.start >= o.start && piece.end <= o.end && o.italic != null,
                );

                const fontWeight = useEmbeddedFace && !hasBoldOv ? 'normal' : (bold ? 'bold' : 'normal');

                return {
                  text: piece.text,
                  fontFamily: segFontFamily,
                  fontSizeCss: segFontSize,
                  // Embedded faces already include weight — synthesizing CSS bold
                  // on top makes mid-line inserts look heavier/wrong vs neighbors.
                  fontWeight,
                  fontStyle: useEmbeddedFace && !hasItalicOv ? 'normal' : (italic ? 'italic' : 'normal'),
                  underline,
                  color,
                };
              });

              return (
                <EditableLineBox
                  left={left}
                  top={top}
                  naturalWidth={naturalWidth}
                  naturalHeight={naturalHeight}
                  fontSizeCss={fontSizeCss}
                  fontFamily={getOverlayFontFamily(primaryRun?.fontName || '', fontData)}
                  fontWeight={textBold ? 'bold' : 'normal'}
                  fontStyle={textItalic ? 'italic' : 'normal'}
                  underline={textUnderline}
                  color={colorCss}
                  segments={overlaySegments}
                  text={editText}
                  caretStart={editSel.start}
                  caretEnd={editSel.end}
                  textRef={hiddenInputRef}
                  onTextInput={handleHiddenInput}
                  onKeyDown={handleHiddenKeyDown}
                  onSelect={handleEditSelection}
                  onBlur={handleHiddenBlur}
                  offsetCssX={editOffsetCss.x}
                  offsetCssY={editOffsetCss.y}
                  manualWidth={editManualSize.w}
                  manualHeight={editManualSize.h}
                  onOffsetChange={(x, y, noSnap) => {
                    if (noSnap) {
                      setSnapGuides({ x: null, y: null });
                      setEditOffsetCss({ x, y });
                      return;
                    }
                    // Snap the box's left/center/right and baseline to other lines on the page.
                    const TH = 6;
                    const lines = renderResult.documentFlow?.lines ?? [];
                    const boxL = left + x;
                    const boxXs = [boxL, boxL + naturalWidth / 2, boxL + naturalWidth];
                    const baseCss = origin.cssY + y;
                    let bestX: { d: number; at: number } | null = null;
                    let bestY: { d: number; at: number } | null = null;
                    for (const ln of lines) {
                      if (ln.id === anchor.id) continue;
                      const b = getLineBounds(ln);
                      const l = pdfToCanvas(b.x, ln.baseline, scale, renderResult.pageHeight, mediaBox.x, mediaBox.y);
                      const w = b.width * scale;
                      for (const tx of [l.cssX, l.cssX + w / 2, l.cssX + w]) {
                        for (const bx of boxXs) {
                          const d = tx - bx;
                          if (Math.abs(d) <= TH && (!bestX || Math.abs(d) < Math.abs(bestX.d))) bestX = { d, at: tx };
                        }
                      }
                      const dy = l.cssY - baseCss;
                      if (Math.abs(dy) <= TH && (!bestY || Math.abs(dy) < Math.abs(bestY.d))) bestY = { d: dy, at: l.cssY };
                    }
                    setSnapGuides({ x: bestX ? bestX.at : null, y: bestY ? bestY.at : null });
                    setEditOffsetCss({ x: x + (bestX ? bestX.d : 0), y: y + (bestY ? bestY.d : 0) });
                  }}
                  onDragEnd={() => setSnapGuides({ x: null, y: null })}
                  onSizeChange={(w, h) => setEditManualSize({ w, h })}
                />
              );
            })()}

            {/* Snap guides while dragging a text box */}
            {editingLine && snapGuides.x !== null && (
              <div
                className="absolute top-0 bottom-0 w-px bg-accent pointer-events-none z-[45]"
                style={{ left: snapGuides.x }}
              />
            )}
            {editingLine && snapGuides.y !== null && (
              <div
                className="absolute left-0 right-0 h-px bg-accent pointer-events-none z-[45]"
                style={{ top: snapGuides.y }}
              />
            )}

            {/* Link hover / edit popovers on the PDF (after Scan for links) */}
            {linksHighlighted && selectedLink && linkPopoverMode && renderResult && doc && (() => {
              const page = doc.pages[currentPage];
              const { mediaBox } = page;
              const topLeft = pdfToCanvas(
                selectedLink.rect.x,
                selectedLink.rect.y + selectedLink.rect.height,
                scale, renderResult.pageHeight, mediaBox.x, mediaBox.y,
              );
              const bottomRight = pdfToCanvas(
                selectedLink.rect.x + selectedLink.rect.width,
                selectedLink.rect.y,
                scale, renderResult.pageHeight, mediaBox.x, mediaBox.y,
              );
              const bx = Math.min(topLeft.cssX, bottomRight.cssX);
              const by = Math.min(topLeft.cssY, bottomRight.cssY);
              const bw = Math.abs(bottomRight.cssX - topLeft.cssX);
              const bh = Math.abs(bottomRight.cssY - topLeft.cssY);
              return (
                <LinkPopover
                  mode={linkPopoverMode}
                  anchorX={bx + bw / 2}
                  anchorY={by + bh}
                  url={linkDraftUrl}
                  displayText={linkDisplayDraft}
                  onUrlChange={setLinkDraftUrl}
                  onDisplayChange={setLinkDisplayDraft}
                  onEdit={() => {
                    if (linkHoverTimerRef.current) {
                      clearTimeout(linkHoverTimerRef.current);
                      linkHoverTimerRef.current = null;
                    }
                    setLinkPopoverMode('edit');
                  }}
                  onOpen={() => {
                    const url = linkDraftUrl || selectedLink.url || '';
                    if (url && openDocumentLink(url) === 'blocked') setError('This document link cannot be opened safely.');
                  }}
                  onRemove={removeLinkFromPopover}
                  onClose={() => { void saveLinkFromPopover(true); }}
                  onPopoverEnter={() => {
                    linkPopoverHoverRef.current = true;
                    if (linkHoverTimerRef.current) {
                      clearTimeout(linkHoverTimerRef.current);
                      linkHoverTimerRef.current = null;
                    }
                  }}
                  onPopoverLeave={() => {
                    linkPopoverHoverRef.current = false;
                    if (linkPopoverMode === 'hover') scheduleLinkHoverClose();
                  }}
                />
              );
            })()}
          </div>
          </div>
        </div>

        {/* ── Right Sidebar: Page Thumbnails (hidden on mobile, shown via floating button) ── */}
        {!isMobile && isThumbnailsOpen && !isFocusMode && (
          <ThumbnailsSidebar
            conformanceNotice={<PdfConformanceNotice doc={doc} isDirty={isDirty} announce={false} />}
            onClose={() => setIsThumbnailsOpen(false)}
            totalPages={totalPages}
            currentPage={currentPage}
            thumbnails={thumbnails}
            isGeneratingThumbnails={isGeneratingThumbnails}
            onPageSelect={async (i) => {
              if (!await commitFormFieldDraft()) return;
              try {
                await prepareOverlayText();
                if (editingLineRef.current && !await handleEditSubmit()) return;
                await commitDrawingsToPdf();
              } catch (e) {
                if (!showUnsupportedGlyphWarning(e)) {
                  setError(`Failed to commit page overlays: ${e instanceof Error ? e.message : String(e)}`);
                }
                return;
              }
              closeLinkPopover();
              setLinkCreatePending(false);
              changePage(i);
            }}
            onDeletePage={handleDeletePage}
            onInsertBlankPage={handleInsertBlankPage}
            onInsertPdf={handleInsertPdf}
            onRotatePage={handleRotatePage}
            onReorderPages={handleReorderPages}
            onMergePdf={handleMergePdf}
            onSplitCurrentPage={handleSplitCurrentPage}
            onSplitAllPages={handleSplitAllPages}
            onRemoveCurrentPage={handleRemoveCurrentPage}
          />
        )}

        {/* Mobile Pages button: Z_LAYERS.chrome (100). */}
        {isMobile && !showMobileThumbnails && (
          <button
            onClick={() => setShowMobileThumbnails(true)}
            className="fixed bottom-16 right-3 z-[100] flex items-center gap-1.5 px-3 py-2 bg-panel/95 backdrop-blur-md border border-app rounded-xl shadow-lg text-app-muted text-xs font-medium hover:text-app transition-colors"
            title="Show page thumbnails"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="3" width="20" height="18" rx="2"/><line x1="8" y1="3" x2="8" y2="21"/></svg>
            {totalPages}p
          </button>
        )}

        {/* ── Mobile: Thumbnails drawer ── */}
        {isMobile && showMobileThumbnails && (
          <ThumbnailsSidebar
            conformanceNotice={<PdfConformanceNotice doc={doc} isDirty={isDirty} announce={false} />}
            totalPages={totalPages}
            currentPage={currentPage}
            thumbnails={thumbnails}
            isGeneratingThumbnails={isGeneratingThumbnails}
            onPageSelect={async (i) => {
              if (!await commitFormFieldDraft()) return;
              try {
                await prepareOverlayText();
                if (editingLineRef.current && !await handleEditSubmit()) return;
                await commitDrawingsToPdf();
              } catch (e) {
                if (!showUnsupportedGlyphWarning(e)) {
                  setError(`Failed to commit page overlays: ${e instanceof Error ? e.message : String(e)}`);
                }
                return;
              }
              closeLinkPopover();
              setLinkCreatePending(false);
              changePage(i);
              setShowMobileThumbnails(false);
            }}
            onDeletePage={handleDeletePage}
            onInsertBlankPage={handleInsertBlankPage}
            onInsertPdf={handleInsertPdf}
            onRotatePage={handleRotatePage}
            onReorderPages={handleReorderPages}
            onMergePdf={handleMergePdf}
            onSplitCurrentPage={handleSplitCurrentPage}
            onSplitAllPages={handleSplitAllPages}
            onRemoveCurrentPage={handleRemoveCurrentPage}
            isMobile={true}
            onClose={() => setShowMobileThumbnails(false)}
          />
        )}
      </div>

      {/* ── Bottom status bar ── */}
      <div className="shrink-0">
        <StatusBar
          renderResult={renderResult}
          activeTool={activeTool}
          selectedRun={selectedLine?.runs[0] ?? null}
          doc={doc}
          totalPages={totalPages}
        />
      </div>

      {/* Global notifications: Z_LAYERS.toast (700), above modal surfaces. */}
      {loadingFont && (
        <div role="status" aria-live="polite" className="fixed bottom-10 left-1/2 -translate-x-1/2 bg-zinc-900 border border-app text-app-muted px-4 py-3 rounded-xl text-sm shadow-xl z-[700]">
          Loading font...
        </div>
      )}

      {glyphWarning && (
        <div role="status" aria-live="polite" className="fixed bottom-10 left-1/2 -translate-x-1/2 max-w-[90vw] bg-zinc-900 border border-amber-500/40 text-amber-200 px-4 py-3 rounded-xl text-sm flex items-center gap-4 shadow-xl z-[700]">
          <span>{glyphWarning}</span>
          <button onClick={() => setGlyphWarning(null)} aria-label="Dismiss font warning" className="shrink-0">
            <X size={16} />
          </button>
        </div>
      )}

      <FieldRenameNotice changes={renamedFields} onDismiss={() => setRenamedFields([])} />

      {/* Error toast */}
      {error && (
        <div className="fixed bottom-10 left-1/2 -translate-x-1/2 bg-red-500/10 backdrop-blur-md border border-red-500/30 text-red-400 px-4 py-3 rounded-xl text-sm font-medium flex items-center gap-4 shadow-xl z-[700] animate-in slide-in-from-bottom-5 fade-in">
          {error}
          <button onClick={() => setError(null)} className="text-red-400 hover:text-red-300 transition-colors">
            <X size={16} />
          </button>
        </div>
      )}
      {/* Z_LAYERS.modalBackdrop (500) / modal (600); content is a flex item. */}
      {isConfirmingRemoval && (
        <div className="fixed inset-0 z-[500] bg-black/80 flex items-center justify-center p-4 animate-in fade-in duration-200">
          <div className="z-[600] bg-zinc-900 border border-zinc-700/50 rounded-xl p-6 shadow-2xl max-w-sm w-full">
            <h3 className="text-white font-medium text-lg mb-2">Remove Watermarks</h3>
            <p className="text-zinc-400 text-sm mb-6">
              Do you really want to remove the detected watermarks from this document? This action cannot be undone.
            </p>
            <div className="flex gap-3 justify-end">
              <button
                onClick={() => setIsConfirmingRemoval(false)}
                className="px-4 py-2 rounded font-medium text-sm text-zinc-300 hover:text-white hover:bg-zinc-800 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={executeRemoveWatermarks}
                className="px-4 py-2 rounded font-medium text-sm bg-red-600 hover:bg-red-700 text-white transition-colors"
              >
                Yes, Remove
              </button>
            </div>
          </div>
        </div>
      )}

      {showApplySuccessModal && (
        <div className="fixed inset-0 z-[500] bg-black/80 flex items-center justify-center p-4 animate-in fade-in duration-200">
          <div className="z-[600] bg-zinc-900 border border-zinc-700/50 rounded-xl p-6 shadow-2xl max-w-sm w-full text-center">
            <h3 className="text-white font-medium text-lg mb-4">Watermark Applied</h3>
            <p className="text-zinc-400 text-sm mb-6 leading-relaxed">
              Watermark has been applied and live preview is off. To add more watermarks, turn on the live preview to preview it live.
            </p>
            <button
              onClick={() => setShowApplySuccessModal(false)}
              className="w-full px-4 py-2.5 rounded font-medium text-sm bg-bloom-500 hover:bg-bloom-700 text-white transition-colors"
            >
              Okay
            </button>
          </div>
        </div>
      )}

      <SignatureCreateDialog
        open={signatureCreateOpen}
        onOpenChange={setSignatureCreateOpen}
        onSave={handleSignatureCreateSave}
      />
      <CertificateImportDialog
        open={certificateImportOpen}
        onOpenChange={setCertificateImportOpen}
        onChange={handleCertificateImportChange}
      />
      <UnsavedChangesDialog
        open={closeDialogOpen}
        busy={closeBusy}
        error={closeError}
        onCancel={() => { setCloseError(null); setCloseDialogOpen(false); }}
        onDiscard={() => void handleCloseChoice(false)}
        onSave={() => void handleCloseChoice(true)}
      />

      {/* ── Export Panel ── */}
      <ExportPanel
        isOpen={showExportPanel}
        onClose={() => setShowExportPanel(false)}
        doc={doc}
        engine={engineModule}
        fileName={fileName}
        totalPages={totalPages}
        currentPage={currentPage}
      />
    </div>
  );
}
