import { PDFArray, PDFDict, PDFHexString, PDFName, PDFRef, PDFStream, PDFString, type PDFDocumentData, type PDFObject } from '../../types';

const LIMIT = 100_000;
export interface RichMediaInspectionBudget { remaining: number }
const unsupported = (): never => { throw new Error('Cannot safely inspect or remove RichMedia JavaScript; no changes were made.'); };
function spend(budget: RichMediaInspectionBudget | undefined, amount = 1): void {
  if (budget && (budget.remaining -= amount) < 0) unsupported();
}
function resolve(value: PDFObject | undefined, doc: PDFDocumentData, budget?: RichMediaInspectionBudget): PDFObject | undefined {
  const seen = new Set<string>();
  while (value instanceof PDFRef) {
    spend(budget);
    const key = value.toKey();
    if (seen.has(key) || seen.size >= LIMIT) return unsupported();
    seen.add(key);
    value = doc.objects.get(key);
    if (!value) return unsupported();
  }
  return value;
}
function dict(value: PDFObject | undefined, doc: PDFDocumentData, budget?: RichMediaInspectionBudget): PDFDict {
  const result = resolve(value, doc, budget);
  return result instanceof PDFDict ? result : unsupported();
}
interface ScriptEntry { activation: PDFDict; scripts: PDFArray; }

/** RichMedia activation scripts are file-specification references, not action dictionaries. */
export function richMediaScripts(annot: PDFDict, doc: PDFDocumentData): ScriptEntry | null {
  const rawSettings = annot.get('RichMediaSettings');
  if (!rawSettings) return null;
  const subtype = resolve(annot.get('Subtype'), doc);
  if (!(subtype instanceof PDFName) || subtype.name !== 'RichMedia') return unsupported();
  const settings = dict(rawSettings, doc);
  const rawActivation = settings.get('Activation');
  if (!rawActivation) return null;
  const activation = dict(rawActivation, doc);
  const rawScripts = activation.get('Scripts');
  if (!rawScripts) return null;
  const scripts = resolve(rawScripts, doc);
  if (!(scripts instanceof PDFArray)) return unsupported();
  return scripts.length ? { activation, scripts } : null;
}

/** Walk the live graph, optionally omitting prospective removals before mutation. */
function liveGraph(
  doc: PDFDocumentData,
  budget: RichMediaInspectionBudget,
  omitted?: { activation: PDFDict; names: PDFArray; nameIndices: Set<number> },
): { nodes: Set<PDFObject>; incoming: Map<PDFObject, number> } {
  const nodes = new Set<PDFObject>();
  const incoming = new Map<PDFObject, number>();
  const roots: PDFObject[] = [doc.catalog, doc.xref.trailerDict];
  for (const page of doc.pages) {
    spend(budget, page.contentRefs.length + 2);
    roots.push(page.dict, page.resources, ...page.contentRefs);
  }
  const pending = [...new Set(roots)];
  let work = 0;
  while (pending.length) {
    spend(budget);
    if (++work > LIMIT || pending.length > LIMIT) return unsupported();
    const value = resolve(pending.pop(), doc, budget);
    if (!value || nodes.has(value)) continue;
    nodes.add(value);
    let count = 0;
    if (value instanceof PDFArray) count = value.length - (value === omitted?.names ? omitted.nameIndices.size : 0);
    else if (value instanceof PDFDict) count = value.size - (value === omitted?.activation && value.has('Scripts') ? 1 : 0);
    else if (value instanceof PDFStream) count = 1;
    // Account for every edge before enumerating or allocating its children,
    // including primitive entries and entries that point to previously seen objects.
    if (count + pending.length > LIMIT) return unsupported();
    spend(budget, count);
    const visit = (child: PDFObject) => {
      const target = resolve(child, doc, budget);
      if (!target) return unsupported();
      if (target instanceof PDFArray || target instanceof PDFDict || target instanceof PDFStream) {
        incoming.set(target, (incoming.get(target) ?? 0) + 1);
        pending.push(target);
      }
    };
    if (value instanceof PDFArray) {
      for (let i = 0; i < value.length; i++) {
        if (value === omitted?.names && omitted.nameIndices.has(i)) continue;
        visit(value.items[i]);
      }
    } else if (value instanceof PDFDict) {
      for (const [key, child] of value.entries()) {
        if (value === omitted?.activation && key === 'Scripts') continue;
        visit(child);
      }
    } else if (value instanceof PDFStream) visit(value.dict);
  }
  return { nodes, incoming };
}

/** Remove only individually identified script assets, preserving the media assets. */
export function removeRichMediaScripts(annot: PDFDict, doc: PDFDocumentData, entry: ScriptEntry, budget: RichMediaInspectionBudget): number {
  const content = dict(annot.get('RichMediaContent'), doc, budget);
  const assets = dict(content.get('Assets'), doc, budget);
  // A flat name tree needs no non-root Limits repair. More complex or shared
  // structures require a separate verified rewrite, so leave the input intact.
  if (assets.has('Kids') || assets.has('Limits')) return unsupported();
  const names = resolve(assets.get('Names'), doc, budget);
  if (!(names instanceof PDFArray) || names.length % 2 !== 0 || names.length > LIMIT) return unsupported();
  if (entry.scripts.length > 4096) return unsupported();
  spend(budget, entry.scripts.length);
  const specs = new Set<PDFDict>(), streams = new Set<PDFStream>();
  for (const raw of entry.scripts.items) {
    if (!(raw instanceof PDFRef)) return unsupported();
    const spec = dict(raw, doc, budget);
    const type = resolve(spec.get('Type'), doc, budget);
    if (specs.has(spec) || (type !== undefined && (!(type instanceof PDFName) || type.name !== 'Filespec')) || spec.has('RF')) return unsupported();
    const ef = dict(spec.get('EF'), doc, budget);
    if (!ef.size || ef.size > 64) return unsupported();
    spend(budget, ef.size);
    for (const rawStream of ef.values()) {
      const stream = resolve(rawStream, doc, budget);
      if (!(stream instanceof PDFStream)) return unsupported();
      streams.add(stream);
    }
    specs.add(spec);
  }
  spend(budget, names.length);
  const kept: PDFObject[] = [];
  const nameIndices = new Set<number>();
  const matched = new Map<PDFDict, number>();
  for (let i = 0; i < names.length; i += 2) {
    const key = resolve(names.get(i), doc, budget);
    const value = names.get(i + 1);
    if (!(key instanceof PDFString || key instanceof PDFHexString) || !value) return unsupported();
    const spec = dict(value, doc, budget);
    if (specs.has(spec)) {
      matched.set(spec, (matched.get(spec) ?? 0) + 1);
      nameIndices.add(i); nameIndices.add(i + 1);
    }
    else kept.push(names.items[i], value);
  }
  if ([...specs].some(spec => matched.get(spec) !== 1)) return unsupported();
  const before = liveGraph(doc, budget);
  for (const container of [entry.activation, entry.scripts, content, assets, names]) {
    if ((before.incoming.get(container) ?? 0) !== 1) return unsupported();
  }
  const after = liveGraph(doc, budget, { activation: entry.activation, names, nameIndices });
  if ([...specs, ...streams].some(value => after.nodes.has(value))) return unsupported();
  entry.activation.delete('Scripts');
  names.items.length = 0;
  for (const value of kept) names.items.push(value);
  doc.requiresFullRewrite = true;
  return specs.size;
}
