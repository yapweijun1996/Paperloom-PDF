/**
 * Tagged PDF accessibility types — structure tree, roles, reading order.
 *
 * ISO 32000-2 §14.8 (Tagged PDF), PDF/UA (ISO 14289).
 */

import type { PDFDict, PDFObject, PDFRef } from '../types';

/** Standard structure types (Table 375 / PDF 1.7 — core subset). */
export type StandardStructureRole =
  | 'Document'
  | 'Part'
  | 'Art'
  | 'Sect'
  | 'Div'
  | 'BlockQuote'
  | 'Caption'
  | 'TOC'
  | 'TOCI'
  | 'Index'
  | 'NonStruct'
  | 'Private'
  | 'P'
  | 'H'
  | 'H1' | 'H2' | 'H3' | 'H4' | 'H5' | 'H6'
  | 'L'
  | 'LI'
  | 'Lbl'
  | 'LBody'
  | 'Table'
  | 'TR'
  | 'TH'
  | 'TD'
  | 'THead'
  | 'TBody'
  | 'TFoot'
  | 'Span'
  | 'Quote'
  | 'Note'
  | 'Reference'
  | 'BibEntry'
  | 'Code'
  | 'Link'
  | 'Figure'
  | 'Formula'
  | 'Form';

/** HTML ARIA / element mapping target. */
export type MappedHtmlRole =
  | 'document'
  | 'article'
  | 'section'
  | 'blockquote'
  | 'p'
  | 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6'
  | 'ul'
  | 'li'
  | 'table'
  | 'tr'
  | 'th'
  | 'td'
  | 'span'
  | 'a'
  | 'figure'
  | 'code'
  | 'form'
  | 'generic';

/** One node in the structure tree (/K entries). */
export interface StructureNode {
  ref: PDFRef | null;
  dict: PDFDict | null;
  /** Structure type — /S entry or role map alias. */
  role: string;
  /** Mapped HTML-ish role for export / a11y APIs. */
  mappedRole: MappedHtmlRole;
  /** Alternate text (/Alt). */
  altText: string | null;
  /** Actual text (/ActualText) when different from content. */
  actualText: string | null;
  /** Language (/Lang). */
  language: string | null;
  /** Child structure elements or MCID integers. */
  children: StructureNode[];
  /** Marked-content ID refs when child is integer MCID. */
  mcid: number | null;
  /** Page ref (/Pg) when present. */
  pageRef: PDFRef | null;
  /** Attribute class owner / attributes dict keys. */
  attributes: Record<string, PDFObject | string | number | boolean>;
}

/** Parsed StructTreeRoot. */
export interface StructureTree {
  rootRef: PDFRef;
  rootDict: PDFDict;
  roleMap: Map<string, string>;
  classMap: Map<string, PDFDict>;
  /** Top-level child nodes (typically Document parts). */
  children: StructureNode[];
}

/** Flat reading-order item for screen readers / export. */
export interface ReadingOrderItem {
  id: string;
  role: string;
  mappedRole: MappedHtmlRole;
  text: string;
  altText: string | null;
  language: string | null;
  pageRef: PDFRef | null;
  mcid: number | null;
  /** Depth in structure tree (0 = top). */
  depth: number;
}

export interface WalkStructureOptions {
  /** Resolve role map aliases to standard roles. */
  applyRoleMap: boolean;
  /** Include /NonStruct and /Private nodes in reading order. */
  includeNonStruct: boolean;
  /** Extract text from /ActualText when content unavailable. */
  preferActualText: boolean;
}

export const DEFAULT_WALK_OPTIONS: WalkStructureOptions = {
  applyRoleMap: true,
  includeNonStruct: false,
  preferActualText: true,
};

/** Role → HTML mapping table (PDF/UA guidance). */
export type RoleMappingTable = Record<string, MappedHtmlRole>;
