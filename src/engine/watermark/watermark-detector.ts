/**
 * Watermark Detection Engine — v3 (Robust Parser)
 *
 * Scans PDF pages to identify watermarks with high precision and minimal
 * false positives. Detection strategies:
 *
 * 1. **Content-stream analysis** — Full graphics state machine that tracks
 *    opacity (via gs/ExtGState), transformation matrices (cm), text matrices
 *    (Tm/Td), font sizes (Tf), and color state to distinguish watermarks
 *    from normal document content. Uses regex-based parsing on the full
 *    content string to handle multi-line and concatenated operators.
 *
 * 2. **Form XObject scanning** — Recursively scans form XObjects referenced
 *    from the page resources, since watermarks are often placed in separate
 *    form XObjects overlaid on the page.
 *
 * 3. **Multi-signal scoring** — Each text occurrence is scored across
 *    multiple independent signals: rotation angle, opacity, font size,
 *    page coverage, position centrality, repetition count, and overlap
 *    with normal content flow. Only candidates with sufficient combined
 *    evidence are reported.
 *
 * 4. **Annotation-based detection** — Looks for watermark annotations
 *    (custom /Subtype "Watermark" or marked content with /Tag "Watermark")
 *    with proper Rect-based position extraction.
 *
 * 5. **Resource analysis** — Identifies ExtGState dictionaries with
 *    unusually low opacity values that are characteristic of watermarks.
 *
 * The engine returns a list of detected watermarks with confidence scores
 * and metadata (position, text content, opacity, rotation, etc.).
 */

import {
  PDFArray,
  PDFDict,
  PDFName,
  PDFNumber,
  PDFObject,
  PDFStream,
  PDFString,
  PDFRef,
  type PDFPageInfo,
} from '../types';

// ─── Detection result types ─────────────────────────────────────────────────

export interface DetectedWatermark {
  /** Unique ID assigned to this detection */
  id: string;
  /** Type of detected watermark */
  type: 'text' | 'image' | 'pattern';
  /** Confidence score (0-1) */
  confidence: number;
  /** The detected text content (for text/pattern watermarks) */
  text?: string;
  /** Font name if detected */
  fontName?: string;
  /** Font size if detected */
  fontSize?: number;
  /** Detected opacity (0-1) */
  opacity?: number;
  /** Detected rotation angle in degrees */
  rotation?: number;
  /** Whether the watermark is tiled/repeated */
  isTiled: boolean;
  /** Approximate position(s) on the page */
  positions: Array<{ x: number; y: number; width?: number; height?: number; rotation?: number }>;
  /** Page index where found */
  pageIndex: number;
  /** The raw content region (byte offset range) for removal */
  contentRegion?: { start: number; end: number };
  /** Detection method used */
  detectionMethod: 'content-analysis' | 'annotation' | 'resource-analysis';
  /** Additional metadata */
  metadata: Record<string, unknown>;
}

export interface DetectionOptions {
  /** Minimum confidence threshold (0-1) for reporting a detection */
  minConfidence: number;
  /** Whether to scan content streams */
  scanContentStreams: boolean;
  /** Whether to scan annotations */
  scanAnnotations: boolean;
  /** Whether to scan resources for opacity hints */
  scanResources: boolean;
  /** Minimum number of repetitions to consider something "tiled" */
  minTileRepetitions: number;
  /** Maximum opacity to consider as watermark-like */
  maxWatermarkOpacity: number;
  /** Minimum font size (in points) to even consider as a watermark candidate */
  minWatermarkFontSize: number;
  /** Minimum rotation angle (degrees) to consider as diagonal watermark */
  minDiagonalAngle: number;
}

const DEFAULT_DETECTION_OPTIONS: DetectionOptions = {
  minConfidence: 0.6,
  scanContentStreams: true,
  scanAnnotations: true,
  scanResources: true,
  minTileRepetitions: 4,
  maxWatermarkOpacity: 0.5,
  minWatermarkFontSize: 20,
  minDiagonalAngle: 10,
};

// ─── Main detection function ────────────────────────────────────────────────

/**
 * Detect watermarks across all pages of a document.
 */
export function detectWatermarks(
  doc: { pages: PDFPageInfo[]; objects: Map<string, PDFObject> },
  options?: Partial<DetectionOptions>,
): DetectedWatermark[] {
  const opts = { ...DEFAULT_DETECTION_OPTIONS, ...options };
  const results: DetectedWatermark[] = [];

  for (let i = 0; i < doc.pages.length; i++) {
    const page = doc.pages[i];
    const pageResults = detectWatermarksOnPage(page, doc.objects, i, opts);
    results.push(...pageResults);
  }

  return results;
}

/**
 * Detect watermarks on a single page.
 */
export function detectWatermarksOnPage(
  page: PDFPageInfo,
  objects: Map<string, PDFObject>,
  pageIndex: number,
  options?: Partial<DetectionOptions>,
): DetectedWatermark[] {
  const opts = { ...DEFAULT_DETECTION_OPTIONS, ...options };
  const results: DetectedWatermark[] = [];

  if (opts.scanContentStreams) {
    const contentResults = analyzeContentStream(page, objects, pageIndex, opts);
    results.push(...contentResults);
  }

  if (opts.scanAnnotations) {
    const annotationResults = analyzeAnnotations(page, objects, pageIndex, opts);
    results.push(...annotationResults);
  }

  if (opts.scanResources) {
    const resourceResults = analyzeResources(page, objects, pageIndex, opts);
    results.push(...resourceResults);
  }

  // Deduplicate overlapping detections
  return deduplicateDetections(results);
}

// ─── Graphics state types ───────────────────────────────────────────────────

interface TextOccurrence {
  text: string;
  x: number;
  y: number;
  fontSize: number;
  fontName: string;
  opacity: number;
  /** Rotation angle in degrees extracted from the text matrix or CTM */
  rotation: number;
  /** The approximate width this text covers on the page */
  estimatedWidth: number;
  byteOffset: number;
  byteLength: number;
  /** Which ExtGState was active */
  gsName: string;
  /** Raw text matrix values */
  rawTm: [number, number, number, number, number, number];
}

interface ImageOccurrence {
  imageName: string;
  x: number;
  y: number;
  width: number;
  height: number;
  opacity: number;
  byteOffset: number;
  byteLength: number;
}

// ─── Content stream analysis ────────────────────────────────────────────────

function analyzeContentStream(
  page: PDFPageInfo,
  objects: Map<string, PDFObject>,
  pageIndex: number,
  opts: DetectionOptions,
): DetectedWatermark[] {
  const results: DetectedWatermark[] = [];

  // Get decoded content bytes
  const contentBytes = getPageContentBytes(page, objects);
  if (!contentBytes || contentBytes.length === 0) {
    return results;
  }

  const contentStr = bytesToString(contentBytes);

  // Build the ExtGState opacity lookup table from page resources
  const opacityMap = buildOpacityMap(page, objects);

  // Parse text occurrences with robust full-string regex parsing
  const textOccurrences = extractTextOccurrences(contentStr, opacityMap);

  const imageOccurrences = extractImageOccurrences(contentStr, opacityMap);

  // Also scan form XObjects referenced from the page for watermark text
  const xObjectOccurrences = scanFormXObjects(page, objects, opacityMap);
  textOccurrences.push(...xObjectOccurrences);

  const pageWidth = page.mediaBox.width;
  const pageHeight = page.mediaBox.height;

  // ── Strategy 1: Combined multi-signal scoring for each text group ──
  const scoredResults = scoreTextCandidates(textOccurrences, pageIndex, pageWidth, pageHeight, opts);
  results.push(...scoredResults);

  // ── Strategy 2: Tiled image detection ──
  const tiledImageResults = detectTiledImages(imageOccurrences, pageIndex, opts);
  results.push(...tiledImageResults);

  // ── Strategy 3: Low-opacity image detection ──
  const lowOpacityImageResults = detectLowOpacityImages(imageOccurrences, pageIndex, opts);
  results.push(...lowOpacityImageResults);

  return results;
}

// ── Build ExtGState opacity map from page resources ─────────────────────────

/**
 * Scans the page's /Resources -> /ExtGState dictionary and builds
 * a map of GS name → opacity value.
 */
function buildOpacityMap(
  page: PDFPageInfo,
  objects: Map<string, PDFObject>,
): Map<string, number> {
  const opacityMap = new Map<string, number>();

  const resources = page.dict.get('Resources');
  if (!resources) return opacityMap;

  let resDict: PDFDict | undefined;
  if (resources instanceof PDFRef) {
    const resolved = objects.get(resources.toKey());
    if (resolved instanceof PDFDict) resDict = resolved;
  } else if (resources instanceof PDFDict) {
    resDict = resources;
  }
  if (!resDict) return opacityMap;

  const extGState = resDict.get('ExtGState');
  if (!extGState) return opacityMap;

  let gsDict: PDFDict | undefined;
  if (extGState instanceof PDFRef) {
    const resolved = objects.get(extGState.toKey());
    if (resolved instanceof PDFDict) gsDict = resolved;
  } else if (extGState instanceof PDFDict) {
    gsDict = extGState;
  }
  if (!gsDict) return opacityMap;

  for (const [key, value] of gsDict.entries()) {
    let stateDict: PDFDict | undefined;
    if (value instanceof PDFRef) {
      const resolved = objects.get(value.toKey());
      if (resolved instanceof PDFDict) stateDict = resolved;
    } else if (value instanceof PDFDict) {
      stateDict = value;
    }

    if (stateDict) {
      const ca = stateDict.get('ca');
      const CA = stateDict.get('CA');
      const opacity = ca instanceof PDFNumber ? ca.value
        : CA instanceof PDFNumber ? CA.value
        : 1.0;
      opacityMap.set(key, opacity);
    }
  }

  return opacityMap;
}

// ── Scan Form XObjects for watermark content ────────────────────────────────

/**
 * Many watermark tools place watermarks inside form XObjects rather than
 * directly in the page content stream. This function scans all form XObjects
 * referenced from the page's resources.
 */
function scanFormXObjects(
  page: PDFPageInfo,
  objects: Map<string, PDFObject>,
  opacityMap: Map<string, number>,
): TextOccurrence[] {
  const occurrences: TextOccurrence[] = [];

  const resources = page.dict.get('Resources');
  if (!resources) return occurrences;

  let resDict: PDFDict | undefined;
  if (resources instanceof PDFRef) {
    const resolved = objects.get(resources.toKey());
    if (resolved instanceof PDFDict) resDict = resolved;
  } else if (resources instanceof PDFDict) {
    resDict = resources;
  }
  if (!resDict) return occurrences;

  const xObjects = resDict.get('XObject');
  if (!xObjects) return occurrences;

  let xObjDict: PDFDict | undefined;
  if (xObjects instanceof PDFRef) {
    const resolved = objects.get(xObjects.toKey());
    if (resolved instanceof PDFDict) xObjDict = resolved;
  } else if (xObjects instanceof PDFDict) {
    xObjDict = xObjects;
  }
  if (!xObjDict) return occurrences;

  for (const [_name, value] of xObjDict.entries()) {
    let stream: PDFStream | undefined;
    if (value instanceof PDFRef) {
      const resolved = objects.get(value.toKey());
      if (resolved instanceof PDFStream) stream = resolved;
    } else if (value instanceof PDFStream) {
      stream = value;
    }
    if (!stream) continue;

    // Check if it's a Form XObject
    const subtype = stream.dict.get('Subtype');
    if (!(subtype instanceof PDFName) || subtype.name !== 'Form') continue;

    // Scan the form XObject's content stream
    const formBytes = stream.decodedBytes || stream.rawBytes;
    const formStr = bytesToString(formBytes);

    // Build opacity map for the form's own resources (if any)
    const formOpacityMap = new Map(opacityMap);
    const formResources = stream.dict.get('Resources');
    if (formResources instanceof PDFDict) {
      const formExtGState = formResources.get('ExtGState');
      if (formExtGState instanceof PDFDict) {
        for (const [k, v] of formExtGState.entries()) {
          let sd: PDFDict | undefined;
          if (v instanceof PDFRef) {
            const r = objects.get(v.toKey());
            if (r instanceof PDFDict) sd = r;
          } else if (v instanceof PDFDict) {
            sd = v;
          }
          if (sd) {
            const ca = sd.get('ca');
            const CA = sd.get('CA');
            const op = ca instanceof PDFNumber ? ca.value
              : CA instanceof PDFNumber ? CA.value
              : 1.0;
            formOpacityMap.set(k, op);
          }
        }
      }
    }

    const formOccs = extractTextOccurrences(formStr, formOpacityMap);
    occurrences.push(...formOccs);
  }

  return occurrences;
}

// ── Text occurrence extraction — robust regex-based parsing ─────────────────

/**
 * Extract text occurrences from a PDF content stream string.
 *
 * Uses regex-based parsing on the FULL content string (not line-by-line)
 * to correctly handle operators that span multiple lines or are concatenated
 * on a single line.
 */
function extractTextOccurrences(
  contentStr: string,
  opacityMap: Map<string, number>,
): TextOccurrence[] {
  const occurrences: TextOccurrence[] = [];

  // ── Step 1: Pre-scan for gs (opacity) state changes and their positions ──
  // NOTE: ExtGState names can contain hyphens (e.g. GS_wm_wm-17832), so use [\\w-]+
  const gsChanges: Array<{ pos: number; gsName: string; opacity: number }> = [];
  const gsRegex = /\/([\w-]+)\s+gs/g;
  let gsM: RegExpExecArray | null;
  while ((gsM = gsRegex.exec(contentStr)) !== null) {
    const gsName = gsM[1];
    const resolved = opacityMap.get(gsName);
    if (resolved !== undefined) {
      gsChanges.push({ pos: gsM.index, gsName, opacity: resolved });
    }
  }

  /** Get the opacity active at a given byte position in the content stream */
  function getOpacityAt(pos: number): { opacity: number; gsName: string } {
    let opacity = 1.0;
    let gsName = '';
    for (const gc of gsChanges) {
      if (gc.pos <= pos) {
        opacity = gc.opacity;
        gsName = gc.gsName;
      } else {
        break;
      }
    }
    return { opacity, gsName };
  }

  // ── Step 2: Build a proper q/Q-aware CTM state tracker ──
  // We need to track the graphics state stack to properly accumulate
  // CTMs. The watermark often uses: q / cm (translate) / cm (rotate) / BT...ET / Q
  // where the two cm operators multiply together.
  function getCTMAt(pos: number): [number, number, number, number, number, number] {
    // Replay all graphics state operators up to `pos` to build the CTM
    let ctm: [number, number, number, number, number, number] = [1, 0, 0, 1, 0, 0];
    const ctmStack: Array<[number, number, number, number, number, number]> = [];

    // q/Q operators: standalone single-char graphic state operators.
    // They can appear adjacent (e.g. "Qq" = Q then q), so use word-boundary matching.
    // cm operators: 6 numbers followed by cm.
    const stateRegex = /(?:^|[^a-zA-Z])(q|Q)(?=[^a-zA-Z]|$)|([\d.\-e]+)\s+([\d.\-e]+)\s+([\d.\-e]+)\s+([\d.\-e]+)\s+([\d.\-e]+)\s+([\d.\-e]+)\s+cm/g;
    let stateMatch: RegExpExecArray | null;
    while ((stateMatch = stateRegex.exec(contentStr)) !== null) {
      if (stateMatch.index > pos) break;

      if (stateMatch[1] === 'q') {
        ctmStack.push([...ctm] as [number, number, number, number, number, number]);
      } else if (stateMatch[1] === 'Q') {
        if (ctmStack.length > 0) {
          ctm = ctmStack.pop()!;
        }
      } else if (stateMatch[2] !== undefined) {
        // cm operator — multiply into current CTM
        const newCm: [number, number, number, number, number, number] = [
          parseFloat(stateMatch[2]), parseFloat(stateMatch[3]),
          parseFloat(stateMatch[4]), parseFloat(stateMatch[5]),
          parseFloat(stateMatch[6]), parseFloat(stateMatch[7]),
        ];
        ctm = multiplyCTM(newCm, ctm);
      }
    }
    return ctm;
  }

  // ── Step 3: Find all BT...ET blocks and parse text within them ──
  const btRegex = /BT([\s\S]*?)ET/g;
  let btMatch: RegExpExecArray | null;

  while ((btMatch = btRegex.exec(contentStr)) !== null) {
    const blockContent = btMatch[1];
    const blockStart = btMatch.index;

    // Get the opacity and CTM active at this BT block's position
    const { opacity, gsName } = getOpacityAt(blockStart);
    const ctm = getCTMAt(blockStart);

    // Parse font setting: First check within this BT...ET block
    let fontName = 'Helvetica';
    let fontSize = 12;
    const tfMatch = blockContent.match(/\/(\S+)\s+([\d.]+)\s+Tf/);
    if (tfMatch) {
      fontName = tfMatch[1];
      fontSize = parseFloat(tfMatch[2]);
    } else {
      // Tf can appear BEFORE the BT block (e.g. in watermark: /Arial 72 Tf ... BT ... ET)
      // Search backwards from blockStart in the content stream
      const preContent = contentStr.substring(Math.max(0, blockStart - 200), blockStart);
      const preTfMatch = preContent.match(/\/(\S+)\s+([\d.]+)\s+Tf/);
      if (preTfMatch) {
        fontName = preTfMatch[1];
        fontSize = parseFloat(preTfMatch[2]);
      }
    }

    // Parse text matrix: a b c d e f Tm
    let textTM: [number, number, number, number, number, number] = [1, 0, 0, 1, 0, 0];
    const tmMatch = blockContent.match(/([\d.\-e]+)\s+([\d.\-e]+)\s+([\d.\-e]+)\s+([\d.\-e]+)\s+([\d.\-e]+)\s+([\d.\-e]+)\s+Tm/);
    if (tmMatch) {
      textTM = [
        parseFloat(tmMatch[1]), parseFloat(tmMatch[2]),
        parseFloat(tmMatch[3]), parseFloat(tmMatch[4]),
        parseFloat(tmMatch[5]), parseFloat(tmMatch[6]),
      ];
    }

    // Parse text position: x y Td or x y TD
    const tdMatch = blockContent.match(/([\d.\-e]+)\s+([\d.\-e]+)\s+T[dD]/);
    if (tdMatch && !tmMatch) {
      // Td sets translation only (no rotation) — apply to text matrix
      textTM[4] = parseFloat(tdMatch[1]);
      textTM[5] = parseFloat(tdMatch[2]);
    }

    // Compute rotation from combined text matrix + CTM
    const rotation = extractRotationFromMatrix(textTM, ctm);
    const effectiveFontSize = computeEffectiveFontSize(fontSize, textTM, ctm);

    // ── Extract Tj (show text) operations: (text) Tj ──
    const tjRegex = /\(([^)]*(?:\\.[^)]*)*)\)\s*Tj/g;
    let tjMatch: RegExpExecArray | null;
    while ((tjMatch = tjRegex.exec(blockContent)) !== null) {
      const text = unescapePDFString(tjMatch[1]);
      if (text.trim().length === 0) continue;

      const estWidth = text.length * effectiveFontSize * 0.5;
      const pos = transformPoint(textTM[4], textTM[5], ctm);

      occurrences.push({
        text,
        x: pos.x,
        y: pos.y,
        fontSize: effectiveFontSize,
        fontName,
        opacity,
        rotation,
        estimatedWidth: estWidth,
        byteOffset: blockStart + tjMatch.index,
        byteLength: tjMatch[0].length,
        gsName,
        rawTm: [...textTM],
      });
    }

    // ── Extract TJ (show text array) operations: [...] TJ ──
    const tjArrRegex = /\[([\s\S]*?)\]\s*TJ/g;
    let tjArrMatch: RegExpExecArray | null;
    while ((tjArrMatch = tjArrRegex.exec(blockContent)) !== null) {
      const inner = tjArrMatch[1];
      // Extract all string literals from the TJ array
      const strMatches = inner.match(/\(([^)]*(?:\\.[^)]*)*)\)/g);
      if (strMatches) {
        const combinedText = strMatches.map(s => unescapePDFString(s.slice(1, -1))).join('');
        if (combinedText.trim().length === 0) continue;

        const estWidth = combinedText.length * effectiveFontSize * 0.5;
        const pos = transformPoint(textTM[4], textTM[5], ctm);

        occurrences.push({
          text: combinedText,
          x: pos.x,
          y: pos.y,
          fontSize: effectiveFontSize,
          fontName,
          opacity,
          rotation,
          estimatedWidth: estWidth,
          byteOffset: blockStart + tjArrMatch.index,
          byteLength: tjArrMatch[0].length,
          gsName,
          rawTm: [...textTM],
        });
      }
    }

    // ── Extract hex string text: <hex> Tj or in TJ arrays ──
    const hexTjRegex = /<([0-9A-Fa-f\s]+)>\s*Tj/g;
    let hexMatch: RegExpExecArray | null;
    while ((hexMatch = hexTjRegex.exec(blockContent)) !== null) {
      const text = decodeHexString(hexMatch[1]);
      if (text.trim().length === 0) continue;

      const estWidth = text.length * effectiveFontSize * 0.5;
      const pos = transformPoint(textTM[4], textTM[5], ctm);

      occurrences.push({
        text,
        x: pos.x,
        y: pos.y,
        fontSize: effectiveFontSize,
        fontName,
        opacity,
        rotation,
        estimatedWidth: estWidth,
        byteOffset: blockStart + hexMatch.index,
        byteLength: hexMatch[0].length,
        gsName,
        rawTm: [...textTM],
      });
    }

    // ── Extract ' operator: (text) ' ──
    const quoteRegex = /\(([^)]*(?:\\.[^)]*)*)\)\s*'/g;
    let quoteMatch: RegExpExecArray | null;
    while ((quoteMatch = quoteRegex.exec(blockContent)) !== null) {
      const text = unescapePDFString(quoteMatch[1]);
      if (text.trim().length === 0) continue;

      const estWidth = text.length * effectiveFontSize * 0.5;
      const pos = transformPoint(textTM[4], textTM[5], ctm);

      occurrences.push({
        text,
        x: pos.x,
        y: pos.y,
        fontSize: effectiveFontSize,
        fontName,
        opacity,
        rotation,
        estimatedWidth: estWidth,
        byteOffset: blockStart + quoteMatch.index,
        byteLength: quoteMatch[0].length,
        gsName,
        rawTm: [...textTM],
      });
    }
  }

  return occurrences;
}

function extractImageOccurrences(
  contentStr: string,
  opacityMap: Map<string, number>,
): ImageOccurrence[] {
  const occurrences: ImageOccurrence[] = [];

  // Pre-scan gs operators for opacity tracking
  // NOTE: ExtGState names can contain hyphens, so use [\w-]+
  const gsPositions: Array<{ pos: number; opacity: number }> = [];
  const gsRegex = /\/([\w-]+)\s+gs/g;
  let gsMatch: RegExpExecArray | null;
  while ((gsMatch = gsRegex.exec(contentStr)) !== null) {
    const gsName = gsMatch[1];
    const resolved = opacityMap.get(gsName);
    if (resolved !== undefined) {
      gsPositions.push({ pos: gsMatch.index, opacity: resolved });
    }
  }

  // Match: /ImName Do — image names can also contain hyphens
  const doRegex = /\/([\w-]+)\s+Do/g;
  let match: RegExpExecArray | null;
  while ((match = doRegex.exec(contentStr)) !== null) {
    // Find the most recent gs before this Do
    let opacity = 1.0;
    for (const gp of gsPositions) {
      if (gp.pos < match.index) {
        opacity = gp.opacity;
      } else {
        break;
      }
    }

    occurrences.push({
      imageName: match[1],
      x: 0,
      y: 0,
      width: 0,
      height: 0,
      opacity,
      byteOffset: match.index,
      byteLength: match[0].length,
    });
  }

  return occurrences;
}

// ─── Multi-signal watermark scoring ─────────────────────────────────────────

/**
 * Score text occurrences using multiple independent watermark signals.
 * Each signal contributes to the overall confidence. Only candidates
 * with sufficient combined evidence are reported.
 *
 * Signals:
 *   1. Rotation — Non-zero rotation strongly suggests watermark
 *   2. Opacity — Low opacity (transparency) is a classic watermark trait
 *   3. Font size — Watermarks use large fonts (24pt+)
 *   4. Page coverage — Watermarks span a significant portion of the page
 *   5. Position centrality — Watermarks are typically centered
 *   6. Repetition — Tiled watermarks repeat the same text many times
 *   7. Content overlap — Watermarks overlay on top of normal content areas
 */
function scoreTextCandidates(
  occurrences: TextOccurrence[],
  pageIndex: number,
  pageWidth: number,
  pageHeight: number,
  opts: DetectionOptions,
): DetectedWatermark[] {
  const results: DetectedWatermark[] = [];

  if (occurrences.length === 0) return results;

  // Build a content density profile to identify "normal text areas"
  const contentProfile = buildContentProfile(occurrences);

  // Group occurrences by text content
  const groups = new Map<string, TextOccurrence[]>();
  for (const occ of occurrences) {
    const key = occ.text.trim();
    if (key.length < 2) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(occ);
  }

  for (const [text, occs] of groups) {
    const rep = occs[0];

    // ── Score each signal independently (0–1 each) ──
    const rotationScore = scoreRotation(rep.rotation, opts.minDiagonalAngle);
    const opacityScore = scoreOpacity(rep.opacity, opts.maxWatermarkOpacity);
    const fontSizeScore = scoreFontSize(rep.fontSize, opts.minWatermarkFontSize, contentProfile.medianFontSize);
    const coverageScore = scoreCoverage(rep.estimatedWidth, pageWidth);
    const centralityScore = scoreCentrality(rep.x, rep.y, pageWidth, pageHeight);
    const repetitionScore = scoreRepetition(occs.length, opts.minTileRepetitions);
    const isTiled = occs.length >= opts.minTileRepetitions;
    const contentOverlapPenalty = scoreContentOverlap(rep, contentProfile, opts.minDiagonalAngle);

    // ── Combine signals into final confidence ──
    let confidence = 0;
    confidence += rotationScore * 0.30;
    confidence += opacityScore * 0.30;
    confidence += fontSizeScore * 0.15;
    confidence += coverageScore * 0.10;
    confidence += centralityScore * 0.05;
    confidence += repetitionScore * 0.10;

    // Apply content overlap penalty
    confidence *= (1 - contentOverlapPenalty * 0.6);

    // Bonus: multiple strong signals together
    const strongSignalCount = [
      rotationScore > 0.5,
      opacityScore > 0.5,
      fontSizeScore > 0.5 && rep.fontSize >= opts.minWatermarkFontSize,
      isTiled && checkGridPattern(occs),
    ].filter(Boolean).length;

    if (strongSignalCount >= 2) {
      confidence = Math.min(1.0, confidence * 1.3);
    }

    // ── Hard rejection filters ──
    if (shouldRejectAsContent(text, rep, contentProfile, occs, opts)) {
      continue;
    }

    // Check minimum confidence
    if (confidence < opts.minConfidence) continue;

    let type: 'text' | 'pattern' = 'text';
    if (isTiled) type = 'pattern';

    results.push({
      id: `detected-${type}-${pageIndex}-${hashString(text)}`,
      type,
      confidence: Math.round(confidence * 100) / 100,
      text,
      fontName: rep.fontName,
      fontSize: rep.fontSize,
      opacity: rep.opacity,
      rotation: rep.rotation,
      isTiled,
      positions: occs.map(o => {
        const rad = (o.rotation * Math.PI) / 180;
        const cx = o.x + (o.estimatedWidth / 2) * Math.cos(rad) - (o.fontSize * 0.3) * Math.sin(rad);
        const cy = o.y + (o.estimatedWidth / 2) * Math.sin(rad) + (o.fontSize * 0.3) * Math.cos(rad);
        return { 
          x: cx, 
          y: cy,
          width: o.estimatedWidth + o.fontSize * 0.5,
          height: o.fontSize * 1.2,
          rotation: o.rotation
        };
      }),
      pageIndex,
      detectionMethod: 'content-analysis',
      metadata: {
        occurrenceCount: occs.length,
        signals: {
          rotation: Math.round(rotationScore * 100) / 100,
          opacity: Math.round(opacityScore * 100) / 100,
          fontSize: Math.round(fontSizeScore * 100) / 100,
          coverage: Math.round(coverageScore * 100) / 100,
          centrality: Math.round(centralityScore * 100) / 100,
          repetition: Math.round(repetitionScore * 100) / 100,
          contentOverlapPenalty: Math.round(contentOverlapPenalty * 100) / 100,
        },
        strongSignalCount,
        gsName: rep.gsName,
        rawRotation: rep.rotation,
        rawOpacity: rep.opacity,
        isGrid: isTiled ? checkGridPattern(occs) : false,
      },
    });
  }

  return results;
}

// ─── Signal scoring functions ───────────────────────────────────────────────

function scoreRotation(rotation: number, minAngle: number): number {
  const absRotation = Math.abs(rotation);
  if (absRotation < minAngle) return 0;
  if (absRotation >= 20 && absRotation <= 70) return 1.0;
  if (absRotation >= 10 && absRotation < 20) return 0.5;
  if (absRotation > 70 && absRotation <= 90) return 0.6;
  return 0.3;
}

function scoreOpacity(opacity: number, maxWatermarkOpacity: number): number {
  if (opacity >= 1.0) return 0;
  if (opacity <= 0.1) return 0.8;
  if (opacity <= maxWatermarkOpacity) return 1.0;
  if (opacity <= 0.7) return 0.5;
  return 0.1;
}

function scoreFontSize(
  fontSize: number,
  minWatermarkSize: number,
  medianContentSize: number,
): number {
  if (fontSize < minWatermarkSize) return 0;
  const ratio = medianContentSize > 0 ? fontSize / medianContentSize : fontSize / 12;
  if (ratio >= 4) return 1.0;
  if (ratio >= 3) return 0.8;
  if (ratio >= 2) return 0.5;
  return 0.2;
}

function scoreCoverage(estimatedWidth: number, pageWidth: number): number {
  if (pageWidth <= 0) return 0;
  const coverage = estimatedWidth / pageWidth;
  if (coverage >= 0.5) return 1.0;
  if (coverage >= 0.3) return 0.7;
  if (coverage >= 0.15) return 0.3;
  return 0;
}

function scoreCentrality(x: number, y: number, pageWidth: number, pageHeight: number): number {
  if (pageWidth <= 0 || pageHeight <= 0) return 0;
  const cx = pageWidth / 2;
  const cy = pageHeight / 2;
  const distX = Math.abs(x - cx) / pageWidth;
  const distY = Math.abs(y - cy) / pageHeight;
  const dist = Math.sqrt(distX * distX + distY * distY);
  if (dist <= 0.15) return 1.0;
  if (dist <= 0.3) return 0.6;
  if (dist <= 0.45) return 0.3;
  return 0;
}

function scoreRepetition(count: number, minTileRepetitions: number): number {
  if (count >= minTileRepetitions * 2) return 1.0;
  if (count >= minTileRepetitions) return 0.8;
  if (count >= 3) return 0.3;
  return 0;
}

function scoreContentOverlap(
  occ: TextOccurrence,
  profile: ContentProfile,
  minDiagonalAngle: number,
): number {
  const matchesContentFont = profile.commonFonts.has(occ.fontName) &&
    Math.abs(occ.fontSize - profile.medianFontSize) < 4;

  if (occ.opacity >= 0.95 && Math.abs(occ.rotation) < minDiagonalAngle && matchesContentFont) {
    return 1.0;
  }

  if (matchesContentFont && occ.opacity >= 0.95) {
    return 0.7;
  }

  return 0;
}

// ─── Content profile ────────────────────────────────────────────────────────

interface ContentProfile {
  medianFontSize: number;
  commonFonts: Set<string>;
  avgOpacity: number;
  totalOccurrences: number;
}

function buildContentProfile(occurrences: TextOccurrence[]): ContentProfile {
  if (occurrences.length === 0) {
    return { medianFontSize: 12, commonFonts: new Set(), avgOpacity: 1.0, totalOccurrences: 0 };
  }

  const fontSizes = occurrences.map(o => o.fontSize).sort((a, b) => a - b);
  const medianFontSize = fontSizes[Math.floor(fontSizes.length / 2)];

  const fontCounts = new Map<string, number>();
  for (const occ of occurrences) {
    fontCounts.set(occ.fontName, (fontCounts.get(occ.fontName) || 0) + 1);
  }
  const commonFonts = new Set<string>();
  const threshold = occurrences.length * 0.2;
  for (const [font, count] of fontCounts) {
    if (count >= threshold) commonFonts.add(font);
  }

  const avgOpacity = occurrences.reduce((sum, o) => sum + o.opacity, 0) / occurrences.length;

  return { medianFontSize, commonFonts, avgOpacity, totalOccurrences: occurrences.length };
}

// ─── Hard rejection filters ─────────────────────────────────────────────────

function shouldRejectAsContent(
  text: string,
  rep: TextOccurrence,
  contentProfile: ContentProfile,
  allOccs: TextOccurrence[],
  opts: DetectionOptions,
): boolean {
  // 1. Reject if standard opacity, no rotation, and below watermark font size threshold
  if (rep.opacity >= 0.95 && Math.abs(rep.rotation) < opts.minDiagonalAngle) {
    if (rep.fontSize < opts.minWatermarkFontSize) return true;
    if (rep.fontSize < opts.minWatermarkFontSize * 2) return true;
  }

  // 2. Reject very short strings
  if (text.length < 3) return true;

  // 3. Reject single occurrence with no watermark signals
  if (allOccs.length === 1 &&
      rep.opacity >= 0.95 &&
      Math.abs(rep.rotation) < opts.minDiagonalAngle &&
      rep.fontSize < opts.minWatermarkFontSize) {
    return true;
  }

  // 4. Standard opacity + no rotation + below tile threshold + no signals
  if (rep.opacity >= 0.95 && Math.abs(rep.rotation) < opts.minDiagonalAngle) {
    if (allOccs.length < opts.minTileRepetitions) {
      const hasAnySignal = (
        rep.opacity < 0.8 ||
        Math.abs(rep.rotation) >= opts.minDiagonalAngle ||
        rep.fontSize >= opts.minWatermarkFontSize
      );
      if (!hasAnySignal) return true;
    }
  }

  // 5. Matches common content font profile with no distinguishing features
  if (contentProfile.commonFonts.has(rep.fontName) &&
      Math.abs(rep.fontSize - contentProfile.medianFontSize) < 4 &&
      rep.opacity >= 0.9 &&
      Math.abs(rep.rotation) < opts.minDiagonalAngle) {
    return true;
  }

  return false;
}

// ─── Image detection strategies ─────────────────────────────────────────────

function detectTiledImages(
  occurrences: ImageOccurrence[],
  pageIndex: number,
  opts: DetectionOptions,
): DetectedWatermark[] {
  const results: DetectedWatermark[] = [];

  const groups = new Map<string, ImageOccurrence[]>();
  for (const occ of occurrences) {
    if (!groups.has(occ.imageName)) groups.set(occ.imageName, []);
    groups.get(occ.imageName)!.push(occ);
  }

  for (const [name, occs] of groups) {
    if (occs.length >= opts.minTileRepetitions) {
      results.push({
        id: `detected-tiled-img-${pageIndex}-${hashString(name)}`,
        type: 'image',
        confidence: 0.8,
        opacity: occs[0].opacity,
        isTiled: true,
        positions: occs.map(o => ({ 
          x: o.x + o.width / 2, 
          y: o.y + o.height / 2,
          width: o.width,
          height: o.height,
          rotation: 0
        })),
        pageIndex,
        detectionMethod: 'content-analysis',
        metadata: { imageName: name, occurrenceCount: occs.length },
      });
    }
  }

  return results;
}

function detectLowOpacityImages(
  occurrences: ImageOccurrence[],
  pageIndex: number,
  opts: DetectionOptions,
): DetectedWatermark[] {
  const results: DetectedWatermark[] = [];

  const lowOpacityOccs = occurrences.filter(o => o.opacity <= opts.maxWatermarkOpacity && o.opacity > 0);
  if (lowOpacityOccs.length === 0) return results;

  for (const occ of lowOpacityOccs) {
    results.push({
      id: `detected-lowopacity-img-${pageIndex}-${hashString(occ.imageName)}`,
      type: 'image',
      confidence: 0.65,
      opacity: occ.opacity,
      isTiled: false,
      positions: [{ x: occ.x, y: occ.y }],
      pageIndex,
      detectionMethod: 'content-analysis',
      metadata: { imageName: occ.imageName, opacity: occ.opacity },
    });
  }

  return results;
}

// ── Annotation analysis ────────────────────────────────────────────────────

function analyzeAnnotations(
  page: PDFPageInfo,
  objects: Map<string, PDFObject>,
  pageIndex: number,
  _opts: DetectionOptions,
): DetectedWatermark[] {
  const results: DetectedWatermark[] = [];

  const annots = page.dict.get('Annots');
  if (!annots) return results;

  let annotArray: PDFArray;
  if (annots instanceof PDFRef) {
    const resolved = objects.get(annots.toKey());
    if (resolved instanceof PDFArray) {
      annotArray = resolved;
    } else {
      return results;
    }
  } else if (annots instanceof PDFArray) {
    annotArray = annots;
  } else {
    return results;
  }

  const pageWidth = page.mediaBox.width;
  const pageHeight = page.mediaBox.height;

  for (let i = 0; i < annotArray.length; i++) {
    const annotRef = annotArray.get(i);
    if (!(annotRef instanceof PDFRef)) continue;

    const annotObj = objects.get(annotRef.toKey());
    if (!(annotObj instanceof PDFDict)) continue;

    // Extract position from /Rect [llx lly urx ury]
    const position = extractAnnotationPosition(annotObj, objects, pageWidth, pageHeight);

    // Check for custom watermark subtype
    const subtype = annotObj.get('Subtype');
    if (subtype instanceof PDFName && subtype.name === 'Watermark') {
      const contents = annotObj.get('Contents');
      const text = contents instanceof PDFString ? contents.value : '';

      results.push({
        id: `detected-annot-${pageIndex}-${annotRef.toKey()}`,
        type: 'text',
        confidence: 0.95,
        text,
        isTiled: false,
        positions: [position],
        pageIndex,
        detectionMethod: 'annotation',
        metadata: { annotRef: annotRef.toKey(), subtype: 'Watermark' },
      });
    }

    // Check for marked content with /Tag "Watermark"
    const ap = annotObj.get('AP');
    if (ap instanceof PDFDict) {
      const n = ap.get('N');
      let apStream: PDFStream | undefined;
      if (n instanceof PDFRef) {
        const resolved = objects.get(n.toKey());
        if (resolved instanceof PDFStream) apStream = resolved;
      } else if (n instanceof PDFStream) {
        apStream = n;
      }

      if (apStream) {
        const apBytes = apStream.decodedBytes || apStream.rawBytes;
        const apStr = bytesToString(apBytes);
        if (apStr.includes('/Tag') && apStr.includes('Watermark')) {
          const contents = annotObj.get('Contents');
          const text = contents instanceof PDFString ? contents.value : '';

          results.push({
            id: `detected-ap-${pageIndex}-${annotRef.toKey()}`,
            type: 'text',
            confidence: 0.9,
            text,
            isTiled: false,
            positions: [position],
            pageIndex,
            detectionMethod: 'annotation',
            metadata: { annotRef: annotRef.toKey(), hasTag: true },
          });
        }
      }
    }
  }

  return results;
}

/**
 * Extract the center position of an annotation from its /Rect array.
 * Falls back to page center if Rect is not available.
 */
function extractAnnotationPosition(
  annotDict: PDFDict,
  objects: Map<string, PDFObject>,
  pageWidth: number,
  pageHeight: number,
): { x: number; y: number } {
  const rect = annotDict.get('Rect');
  if (!rect) return { x: pageWidth / 2, y: pageHeight / 2 };

  let rectArray: PDFArray | undefined;
  if (rect instanceof PDFRef) {
    const resolved = objects.get(rect.toKey());
    if (resolved instanceof PDFArray) rectArray = resolved;
  } else if (rect instanceof PDFArray) {
    rectArray = rect;
  }

  if (!rectArray || rectArray.length < 4) {
    return { x: pageWidth / 2, y: pageHeight / 2 };
  }

  // Rect = [llx, lly, urx, ury] — compute center
  const llx = rectArray.get(0) instanceof PDFNumber ? (rectArray.get(0) as PDFNumber).value : 0;
  const lly = rectArray.get(1) instanceof PDFNumber ? (rectArray.get(1) as PDFNumber).value : 0;
  const urx = rectArray.get(2) instanceof PDFNumber ? (rectArray.get(2) as PDFNumber).value : pageWidth;
  const ury = rectArray.get(3) instanceof PDFNumber ? (rectArray.get(3) as PDFNumber).value : pageHeight;

  return {
    x: (llx + urx) / 2,
    y: (lly + ury) / 2,
  };
}

// ── Resource analysis ──────────────────────────────────────────────────────

function analyzeResources(
  page: PDFPageInfo,
  objects: Map<string, PDFObject>,
  pageIndex: number,
  _opts: DetectionOptions,
): DetectedWatermark[] {
  const results: DetectedWatermark[] = [];

  const resources = page.dict.get('Resources');
  if (!resources) return results;

  let resDict: PDFDict;
  if (resources instanceof PDFRef) {
    const resolved = objects.get(resources.toKey());
    if (resolved instanceof PDFDict) {
      resDict = resolved;
    } else {
      return results;
    }
  } else if (resources instanceof PDFDict) {
    resDict = resources;
  } else {
    return results;
  }

  const pageWidth = page.mediaBox.width;
  const pageHeight = page.mediaBox.height;

  // Only flag ExtGState entries that follow our watermark engine naming (GS_wm_*)
  // or have very low opacity (< 0.3). Use page center as position.
  const extGState = resDict.get('ExtGState');
  if (extGState instanceof PDFDict) {
    for (const [key, value] of extGState.entries()) {
      const isWatermarkNamed = key.startsWith('GS_wm_');

      let gsDict: PDFDict | undefined;
      if (value instanceof PDFRef) {
        const resolved = objects.get(value.toKey());
        if (resolved instanceof PDFDict) gsDict = resolved;
      } else if (value instanceof PDFDict) {
        gsDict = value;
      }

      if (gsDict) {
        const ca = gsDict.get('ca');
        const CA = gsDict.get('CA');
        const opacity = ca instanceof PDFNumber ? ca.value : (CA instanceof PDFNumber ? CA.value : 1);

        if (isWatermarkNamed && opacity < 1) {
          results.push({
            id: `detected-res-${pageIndex}-${hashString(key)}`,
            type: 'text',
            confidence: 0.85,
            opacity,
            isTiled: false,
            positions: [{ x: pageWidth / 2, y: pageHeight / 2 }],
            pageIndex,
            detectionMethod: 'resource-analysis',
            metadata: { extGStateName: key, ca: opacity },
          });
        } else if (opacity <= 0.3 && opacity > 0) {
          results.push({
            id: `detected-res-${pageIndex}-${hashString(key)}`,
            type: 'text',
            confidence: 0.6,
            opacity,
            isTiled: false,
            positions: [{ x: pageWidth / 2, y: pageHeight / 2 }],
            pageIndex,
            detectionMethod: 'resource-analysis',
            metadata: { extGStateName: key, ca: opacity },
          });
        }
      }
    }
  }

  return results;
}

// ─── Matrix math helpers ────────────────────────────────────────────────────

function extractRotationFromMatrix(
  tm: [number, number, number, number, number, number],
  ctm: [number, number, number, number, number, number],
): number {
  const combined = multiplyCTM(tm, ctm);
  const a = combined[0];
  const b = combined[1];
  const radians = Math.atan2(b, a);
  const degrees = radians * (180 / Math.PI);
  return Math.round(degrees * 100) / 100;
}

function computeEffectiveFontSize(
  nominalSize: number,
  tm: [number, number, number, number, number, number],
  ctm: [number, number, number, number, number, number],
): number {
  const combined = multiplyCTM(tm, ctm);
  const yScale = Math.sqrt(combined[2] * combined[2] + combined[3] * combined[3]);
  return nominalSize * (yScale > 0 ? yScale : 1);
}

function multiplyCTM(
  m1: [number, number, number, number, number, number] | number[],
  m2: [number, number, number, number, number, number] | number[],
): [number, number, number, number, number, number] {
  return [
    m1[0] * m2[0] + m1[1] * m2[2],
    m1[0] * m2[1] + m1[1] * m2[3],
    m1[2] * m2[0] + m1[3] * m2[2],
    m1[2] * m2[1] + m1[3] * m2[3],
    m1[4] * m2[0] + m1[5] * m2[2] + m2[4],
    m1[4] * m2[1] + m1[5] * m2[3] + m2[5],
  ];
}

function transformPoint(
  x: number,
  y: number,
  ctm: [number, number, number, number, number, number],
): { x: number; y: number } {
  return {
    x: ctm[0] * x + ctm[2] * y + ctm[4],
    y: ctm[1] * x + ctm[3] * y + ctm[5],
  };
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function getPageContentBytes(page: PDFPageInfo, objects: Map<string, PDFObject>): Uint8Array | null {
  const contents = page.dict.get('Contents');
  if (!contents) return null;

  const refs: PDFRef[] = [];
  if (contents instanceof PDFRef) {
    refs.push(contents);
  } else if (contents instanceof PDFArray) {
    for (let i = 0; i < contents.length; i++) {
      const item = contents.get(i);
      if (item instanceof PDFRef) refs.push(item);
    }
  }

  const chunks: Uint8Array[] = [];
  for (const ref of refs) {
    const obj = objects.get(ref.toKey());
    if (obj instanceof PDFStream) {
      chunks.push(obj.decodedBytes || obj.rawBytes);
    }
  }

  if (chunks.length === 0) return null;
  if (chunks.length === 1) return chunks[0];

  const totalLen = chunks.reduce((sum, c) => sum + c.length, 0);
  const result = new Uint8Array(totalLen);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

function bytesToString(bytes: Uint8Array): string {
  // PDF content streams are raw byte data (Latin-1), NOT UTF-8.
  // We must preserve each byte value exactly as a char code point.
  let s = '';
  for (let i = 0; i < bytes.length; i++) {
    s += String.fromCharCode(bytes[i]);
  }
  return s;
}

function unescapePDFString(s: string): string {
  return s
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\r')
    .replace(/\\t/g, '\t')
    .replace(/\\\\/g, '\\')
    .replace(/\\\(/g, '(')
    .replace(/\\\)/g, ')');
}

/**
 * Decode a hex-encoded PDF string like <48656C6C6F> to "Hello"
 */
function decodeHexString(hex: string): string {
  const cleaned = hex.replace(/\s+/g, '');
  let result = '';
  for (let i = 0; i < cleaned.length; i += 2) {
    const byte = parseInt(cleaned.substring(i, i + 2), 16);
    if (!isNaN(byte)) {
      result += String.fromCharCode(byte);
    }
  }
  return result;
}

function checkGridPattern(occurrences: TextOccurrence[]): boolean {
  if (occurrences.length < 4) return false;

  const xs = occurrences.map(o => o.x).sort((a, b) => a - b);
  const ys = occurrences.map(o => o.y).sort((a, b) => a - b);

  const xDiffs: number[] = [];
  for (let i = 1; i < xs.length; i++) {
    const diff = xs[i] - xs[i - 1];
    if (diff > 5) xDiffs.push(diff);
  }

  const yDiffs: number[] = [];
  for (let i = 1; i < ys.length; i++) {
    const diff = ys[i] - ys[i - 1];
    if (diff > 5) yDiffs.push(diff);
  }

  if (xDiffs.length >= 2) {
    const xMean = xDiffs.reduce((a, b) => a + b, 0) / xDiffs.length;
    const xStd = Math.sqrt(xDiffs.reduce((sum, d) => sum + (d - xMean) ** 2, 0) / xDiffs.length);
    if (xMean > 0 && xStd / xMean > 0.3) return false;
  }

  if (yDiffs.length >= 2) {
    const yMean = yDiffs.reduce((a, b) => a + b, 0) / yDiffs.length;
    const yStd = Math.sqrt(yDiffs.reduce((sum, d) => sum + (d - yMean) ** 2, 0) / yDiffs.length);
    if (yMean > 0 && yStd / yMean > 0.3) return false;
  }

  return true;
}

function hashString(s: string): string {
  let hash = 0;
  for (let i = 0; i < s.length; i++) {
    const char = s.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash |= 0;
  }
  return Math.abs(hash).toString(16).substring(0, 8);
}

function deduplicateDetections(detections: DetectedWatermark[]): DetectedWatermark[] {
  if (detections.length <= 1) return detections;

  const result: DetectedWatermark[] = [];
  const seen = new Set<string>();

  const sorted = [...detections].sort((a, b) => b.confidence - a.confidence);

  for (const det of sorted) {
    const fingerprint = `${det.text || det.id}-${det.pageIndex}-${det.type}`;
    if (!seen.has(fingerprint)) {
      seen.add(fingerprint);
      result.push(det);
    }
  }

  return result;
}