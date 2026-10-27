/**
 * Structure tree walker — tagged PDF role mapping and reading order extraction.
 *
 * ISO 32000-2 §14.8 (Tagged PDF), PDF/UA role mapping to HTML semantics.
 */

import {
  PDFArray,
  PDFDict,
  PDFName,
  PDFNumber,
  PDFRef,
  PDFString,
  type PDFObject,
} from '../types';
import type {
  MappedHtmlRole,
  ReadingOrderItem,
  RoleMappingTable,
  StructureNode,
  StructureTree,
  WalkStructureOptions,
} from './types';
import { DEFAULT_WALK_OPTIONS } from './types';

// ─── Role mapping ───────────────────────────────────────────────────────────

export const DEFAULT_ROLE_MAP: RoleMappingTable = {
  Document: 'document',
  Part: 'article',
  Art: 'article',
  Sect: 'section',
  Div: 'generic',
  BlockQuote: 'blockquote',
  P: 'p',
  H: 'h2',
  H1: 'h1',
  H2: 'h2',
  H3: 'h3',
  H4: 'h4',
  H5: 'h5',
  H6: 'h6',
  L: 'ul',
  LI: 'li',
  Lbl: 'span',
  LBody: 'span',
  Table: 'table',
  TR: 'tr',
  TH: 'th',
  TD: 'td',
  THead: 'generic',
  TBody: 'generic',
  TFoot: 'generic',
  Span: 'span',
  Link: 'a',
  Figure: 'figure',
  Formula: 'generic',
  Code: 'code',
  Form: 'form',
  Quote: 'blockquote',
  Note: 'generic',
  Caption: 'p',
  NonStruct: 'generic',
  Private: 'generic',
};

/**
 * Map PDF structure type (/S) to HTML semantic role.
 */
export function mapStructureRole(
  role: string,
  roleMap: Map<string, string> = new Map(),
  table: RoleMappingTable = DEFAULT_ROLE_MAP,
): MappedHtmlRole {
  let resolved = role;
  if (roleMap.has(role)) {
    resolved = roleMap.get(role)!;
  }
  return table[resolved] ?? table[resolved.replace(/^\//, '')] ?? 'generic';
}

// ─── Structure tree parsing ──────────────────────────────────────────────────

function parseAttributes(dict: PDFDict): Record<string, PDFObject | string | number | boolean> {
  const attrs: Record<string, PDFObject | string | number | boolean> = {};
  const a = dict.get('A');
  if (a instanceof PDFDict) {
    for (const [k, v] of a.entries()) {
      if (v instanceof PDFName) attrs[k] = v.name;
      else if (v instanceof PDFNumber) attrs[k] = v.value;
      else if (v instanceof PDFString) attrs[k] = v.value;
      else attrs[k] = v;
    }
  }
  return attrs;
}

function parseStructureNode(
  obj: PDFObject,
  roleMap: Map<string, string>,
  classMap: Map<string, PDFDict>,
): StructureNode | null {
  if (obj instanceof PDFNumber) {
    return {
      ref: null,
      dict: null,
      role: 'MCID',
      mappedRole: 'generic',
      altText: null,
      actualText: null,
      language: null,
      children: [],
      mcid: obj.value,
      pageRef: null,
      attributes: {},
    };
  }

  if (!(obj instanceof PDFDict)) return null;

  let role = obj.getName('S') ?? obj.getName('Type') ?? 'NonStruct';
  if (roleMap.has(role)) role = roleMap.get(role)!;

  const mappedRole = mapStructureRole(role, roleMap);
  const children: StructureNode[] = [];
  const k = obj.get('K');

  if (k instanceof PDFArray) {
    for (const item of k.items) {
      const child = parseStructureNode(item, roleMap, classMap);
      if (child) children.push(child);
    }
  } else if (k) {
    const child = parseStructureNode(k, roleMap, classMap);
    if (child) children.push(child);
  }

  return {
    ref: null,
    dict: obj,
    role,
    mappedRole,
    altText: obj.getString('Alt') ?? null,
    actualText: obj.getString('ActualText') ?? null,
    language: obj.getString('Lang') ?? null,
    children,
    mcid: null,
    pageRef: obj.getRef('Pg') ?? null,
    attributes: parseAttributes(obj),
  };
}

function parseRoleMap(dict: PDFDict | undefined): Map<string, string> {
  const map = new Map<string, string>();
  if (!dict) return map;
  for (const [k, v] of dict.entries()) {
    if (v instanceof PDFName) map.set(k, v.name);
  }
  return map;
}

function parseClassMap(dict: PDFDict | undefined): Map<string, PDFDict> {
  const map = new Map<string, PDFDict>();
  if (!dict) return map;
  for (const [k, v] of dict.entries()) {
    if (v instanceof PDFDict) map.set(k, v);
  }
  return map;
}

/**
 * Parse /StructTreeRoot dictionary into a StructureTree.
 */
export function parseStructureTree(rootDict: PDFDict, rootRef: PDFRef): StructureTree {
  const roleMap = parseRoleMap(rootDict.getDict('RoleMap'));
  const classMap = parseClassMap(rootDict.getDict('ClassMap'));
  const children: StructureNode[] = [];

  const k = rootDict.get('K');
  if (k instanceof PDFArray) {
    for (const item of k.items) {
      const node = parseStructureNode(item, roleMap, classMap);
      if (node) children.push(node);
    }
  } else if (k) {
    const node = parseStructureNode(k, roleMap, classMap);
    if (node) children.push(node);
  }

  return { rootRef, rootDict, roleMap, classMap, children };
}

// ─── Reading order walk ──────────────────────────────────────────────────────

let readingOrderId = 0;

function nodeText(node: StructureNode, opts: WalkStructureOptions): string {
  if (opts.preferActualText && node.actualText) return node.actualText;
  if (node.altText) return node.altText;
  return '';
}

function shouldInclude(node: StructureNode, opts: WalkStructureOptions): boolean {
  if (opts.includeNonStruct) return true;
  return node.role !== 'NonStruct' && node.role !== 'Private';
}

/**
 * Depth-first traversal producing flat reading order for assistive tech.
 */
export function walkStructureTree(
  tree: StructureTree,
  options: Partial<WalkStructureOptions> = {},
): ReadingOrderItem[] {
  const opts = { ...DEFAULT_WALK_OPTIONS, ...options };
  const items: ReadingOrderItem[] = [];

  function visit(node: StructureNode, depth: number): void {
    if (!shouldInclude(node, opts)) {
      for (const child of node.children) visit(child, depth);
      return;
    }

    const text = nodeText(node, opts);
    items.push({
      id: `ro_${++readingOrderId}`,
      role: node.role,
      mappedRole: node.mappedRole,
      text,
      altText: node.altText,
      language: node.language,
      pageRef: node.pageRef,
      mcid: node.mcid,
      depth,
    });

    for (const child of node.children) {
      visit(child, depth + 1);
    }
  }

  for (const child of tree.children) {
    visit(child, 0);
  }

  return items;
}

/**
 * Merge MCID-ordered content with structure tree reading order.
 * When marked-content text map provided, fills item text by MCID key.
 */
export function enrichReadingOrderWithMcidText(
  items: ReadingOrderItem[],
  mcidText: Map<string, string>,
): ReadingOrderItem[] {
  return items.map(item => {
    if (item.text || item.mcid === null) return item;
    const key = item.pageRef
      ? `${item.pageRef.objNum}_${item.pageRef.genNum}:${item.mcid}`
      : String(item.mcid);
    const text = mcidText.get(key);
    return text ? { ...item, text } : item;
  });
}

/** Reset reading order ID counter (tests). */
export function resetReadingOrderIdCounter(): void {
  readingOrderId = 0;
}
