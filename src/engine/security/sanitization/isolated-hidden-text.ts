import { PDFArray, PDFBoolean, PDFDict, PDFHexString, PDFName, PDFNull, PDFNumber, PDFRef, PDFStream, PDFString, type PDFDocumentData, type PDFObject } from '../../types';
import { PDFLexer, TokenType } from '../../parser/lexer';
import { decodeZlibFully } from '../../parser/filters';
import { OptionalContentVisibility } from '../../content/optional-content';
import { serializeToString } from '../../editor/stream-compiler';
import { hasDocumentSignature } from '../../writer/save-pipeline';
import { assertCompletePageTree } from '../validate-page-tree';
import { decodeStrictHexString } from '../strict-hex-string';

/** Only remove a complete, isolated text-only optional-content block. */
function unsupported(): never {
  throw new Error('Hidden layer cleanup is unavailable for this optional content; no changes were made.');
}
function resolve(value: PDFObject | undefined, doc: PDFDocumentData): PDFObject | undefined {
  const seen = new Set<string>();
  while (value instanceof PDFRef) {
    const key = value.toKey();
    if (seen.has(key) || seen.size >= 128) unsupported();
    seen.add(key);
    value = doc.objects.get(key);
    if (!value) unsupported();
  }
  return value;
}
function dict(value: PDFObject | undefined, doc: PDFDocumentData): PDFDict {
  const item = resolve(value, doc);
  if (!(item instanceof PDFDict)) unsupported();
  return item;
}
function onlyKeys(value: PDFDict, keys: string[]): void {
  if ([...value.keys()].some(key => !keys.includes(key))) unsupported();
}
const STANDARD_FONTS = new Set(['Courier', 'Courier-Bold', 'Courier-Oblique', 'Courier-BoldOblique', 'Helvetica', 'Helvetica-Bold', 'Helvetica-Oblique', 'Helvetica-BoldOblique', 'Times-Roman', 'Times-Bold', 'Times-Italic', 'Times-BoldItalic']);
type Token = { text: string; start: number; end: number; kind: 'name' | 'number' | 'string' | 'operator' };
const OPERANDS: Record<string, string[]> = {
  q: [], Q: [], BT: [], ET: [], Tf: ['name', 'number'], Td: ['number', 'number'],
  Tm: ['number', 'number', 'number', 'number', 'number', 'number'], Tj: ['string'],
  cm: ['number', 'number', 'number', 'number', 'number', 'number'],
  g: ['number'], rg: ['number', 'number', 'number'], k: ['number', 'number', 'number', 'number'],
  BDC: ['name', 'name'], EMC: [],
};
function tokens(bytes: Uint8Array): Token[] {
  if (bytes.some(b => b > 0x7e || (b < 0x20 && ![0, 9, 10, 12, 13].includes(b)))) unsupported();
  const text = new TextDecoder().decode(bytes);
  // This intentionally excludes comments, composite operands and
  // unknown operators: none may be silently skipped by a permissive parser.
  const pattern = /[\x00\x09\x0a\x0c\x0d\x20]*(\/[A-Za-z_][A-Za-z0-9_.-]*|\((?:[^()\\\x00-\x1f]|\\(?:[()\\nrtbf]|[0-7]{1,3}))*\)|<[0-9A-Fa-f\x00\x09\x0a\x0c\x0d\x20]*>|[+-]?(?:\d+(?:\.\d*)?|\.\d+)|[A-Za-z][A-Za-z0-9]*)(?=[\x00\x09\x0a\x0c\x0d\x20]|$)/gy;
  const whitespace = /[\x00\x09\x0a\x0c\x0d\x20]*/y;
  const result: Token[] = [];
  let pos = 0;
  while (pos < text.length) {
    whitespace.lastIndex = pos; whitespace.exec(text);
    if (whitespace.lastIndex === text.length) break;
    pattern.lastIndex = pos;
    const found = pattern.exec(text);
    if (!found) unsupported();
    const word = found[1];
    const start = pattern.lastIndex - word.length;
    const kind = word[0] === '/' ? 'name' : word[0] === '(' || word[0] === '<' ? 'string' : /^[-+.\d]/.test(word) ? 'number' : 'operator';
    if (kind === 'operator' && !Object.hasOwn(OPERANDS, word)) unsupported();
    if (kind === 'number' && !Number.isFinite(Number(word))) unsupported();
    result.push({ text: word, start, end: pattern.lastIndex, kind });
    pos = pattern.lastIndex;
  }
  return result;
}
function decodedText(token: Token): Uint8Array {
  if (token.text.startsWith('<')) return decodeStrictHexString(token.text.slice(1, -1)) ?? unsupported();
  const lexer = new PDFLexer(new TextEncoder().encode(token.text));
  const result = lexer.nextToken();
  if (!result || result.type !== TokenType.String || typeof result.value !== 'string' || !lexer.isEOF) unsupported();
  return new Uint8Array(Array.from(result.value, char => char.charCodeAt(0)));
}
/** Include the writer's rounded spelling and decimal form of exponent values. */
function numericSpellings(value: PDFNumber): string[] {
  if (!Number.isFinite(value.value)) unsupported();
  const serialized = serializeToString(value), canonical = value.toString();
  const match = /^(-?)(\d+)(?:\.(\d+))?e([+-]?\d+)$/i.exec(canonical);
  if (!match) return [serialized, canonical];
  const digits = match[2] + (match[3] ?? '');
  const decimal = match[2].length + Number(match[4]);
  const expanded = decimal <= 0 ? `0.${'0'.repeat(-decimal)}${digits}`
    : decimal >= digits.length ? `${digits}${'0'.repeat(decimal - digits.length)}`
      : `${digits.slice(0, decimal)}.${digits.slice(decimal)}`;
  return [serialized, canonical, `${match[1]}${expanded}`];
}
function contains(haystack: Uint8Array, needle: Uint8Array): boolean {
  if (!needle.length || needle.length > haystack.length) return false;
  // Linear-time search avoids quadratic work for repeated adversarial bytes.
  const prefix = new Uint32Array(needle.length);
  for (let i = 1, matched = 0; i < needle.length; i++) {
    while (matched && needle[i] !== needle[matched]) matched = prefix[matched - 1];
    if (needle[i] === needle[matched]) matched++;
    prefix[i] = matched;
  }
  for (let i = 0, matched = 0; i < haystack.length; i++) {
    while (matched && haystack[i] !== needle[matched]) matched = prefix[matched - 1];
    if (haystack[i] === needle[matched]) matched++;
    if (matched === needle.length) return true;
  }
  return false;
}

/** Raw signed bytes are intentionally omitted from sanitizer preflight clones. */
export function assertHiddenTextSourceSafe(doc: PDFDocumentData): void {
  if (doc.catalog.has('OCProperties') && hasDocumentSignature(doc)) unsupported();
}

/** Validate the page hierarchy and its resource inheritance before removing anything. */
function inspectPageTree(doc: PDFDocumentData): {
  nodes: Set<PDFDict>;
  inherited: Map<PDFDict, PDFObject | undefined>;
  inheritedResources: Set<PDFDict>;
} {
  assertCompletePageTree(doc, () => unsupported());
  const root = doc.catalog.get('Pages');
  if (!(root instanceof PDFRef)) unsupported();
  const nodes = new Set<PDFDict>(), seen = new Set<PDFDict>(), counts = new Map<PDFDict, number>();
  const inherited = new Map<PDFDict, PDFObject | undefined>(), inheritedResources = new Set<PDFDict>();
  const pending: Array<{ ref: PDFRef; parent?: PDFDict; resource?: PDFObject; depth: number; finish?: boolean }> = [
    { ref: root, depth: 0 },
  ];
  while (pending.length) {
    const { ref, parent, resource, depth, finish } = pending.pop()!;
    const node = doc.objects.get(ref.toKey());
    if (!(node instanceof PDFDict) || depth > 128) unsupported();
    if (finish) {
      const children = resolve(node.get('Kids'), doc);
      if (!(children instanceof PDFArray)) unsupported();
      let count = 0;
      for (const child of children.items) {
        if (!(child instanceof PDFRef)) unsupported();
        const item = doc.objects.get(child.toKey());
        if (!(item instanceof PDFDict) || !counts.has(item)) unsupported();
        count += counts.get(item)!;
      }
      if (node.getNumber('Count') !== count) unsupported();
      counts.set(node, count);
      continue;
    }
    if (seen.has(node) || seen.size >= 4096) unsupported();
    seen.add(node);
    if (parent && resolve(node.get('Parent'), doc) !== parent) unsupported();
    if (node.getName('Type') === 'Page' && parent) {
      inherited.set(node, resource);
      counts.set(node, 1);
      continue;
    }
    if (node.getName('Type') !== 'Pages') unsupported();
    onlyKeys(node, parent ? ['Type', 'Parent', 'Kids', 'Count', 'MediaBox', 'CropBox', 'Rotate', 'Resources']
      : ['Type', 'Kids', 'Count', 'MediaBox', 'CropBox', 'Rotate', 'Resources']);
    nodes.add(node);
    const own = node.get('Resources');
    if (own !== undefined) inheritedResources.add(dict(own, doc));
    const nextResource = own ?? resource;
    const children = resolve(node.get('Kids'), doc);
    if (!(children instanceof PDFArray) || children.length + seen.size + pending.length > 4096) unsupported();
    pending.push({ ref, parent, resource, depth, finish: true });
    for (let i = children.length - 1; i >= 0; i--) {
      const child = children.items[i];
      if (!(child instanceof PDFRef)) unsupported();
      pending.push({ ref: child, parent: node, resource: nextResource, depth: depth + 1 });
    }
  }
  if (counts.get(doc.objects.get(root.toKey()) as PDFDict) !== doc.pages.length) unsupported();
  return { nodes, inherited, inheritedResources };
}

/** Returns 0 when no optional content exists, otherwise removes supported content. */
export function removeIsolatedHiddenText(doc: PDFDocumentData, metadataWillBeRemoved = false): number {
  const hexBudget = { characters: 0, bytes: 0 };
  const stringBytes = (value: PDFString | PDFHexString): Uint8Array =>
    value instanceof PDFString ? value.toBytes() : decodeStrictHexString(value.hex, hexBudget) ?? unsupported();
  const oc = doc.catalog.get('OCProperties');
  if (!oc) return 0;
  if (!doc.pages.length || doc.pages.length > 64 || doc.decryptedFromEncrypted || doc.xref.trailerDict.has('Encrypt') || hasDocumentSignature(doc)) unsupported();
  const rootRef = doc.xref.trailerDict.getRef('Root');
  if (!rootRef || doc.objects.get(rootRef.toKey()) !== doc.catalog || doc.catalog.getName('Type') !== 'Catalog') unsupported();
  onlyKeys(doc.catalog, ['Type', 'Pages', 'OCProperties']);
  for (const key of doc.xref.trailerDict.keys()) if (!['Root', 'Info', 'ID', 'Size', 'Prev'].includes(key)) unsupported();
  const info = doc.xref.trailerDict.get('Info');
  if (info) {
    const information = dict(info, doc);
    // Retained text can encode a removed secret across multiple keys or values
    // in arbitrary order, so a single concatenation is not a safety proof.
    const standardKeys = new Set(['Title', 'Author', 'Subject', 'Keywords', 'Creator', 'Producer', 'CreationDate', 'ModDate', 'Trapped']);
    for (const [key, value] of information.entries()) {
      if (!(value instanceof PDFString || value instanceof PDFHexString || value instanceof PDFName || value instanceof PDFNumber || value instanceof PDFBoolean)) unsupported();
      if (!metadataWillBeRemoved && (!standardKeys.has(key) ||
          ((value instanceof PDFString || value instanceof PDFHexString) && stringBytes(value).length > 0) ||
          (!(value instanceof PDFString || value instanceof PDFHexString) &&
           !(value instanceof PDFName && key === 'Trapped' && ['True', 'False', 'Unknown'].includes(value.name))))) {
        throw new Error('Hidden layer cleanup cannot safely retain document information metadata; no changes were made.');
      }
    }
  }
  const ocProperties = dict(oc, doc);
  onlyKeys(ocProperties, ['OCGs', 'D']);
  const groups = resolve(ocProperties.get('OCGs'), doc);
  if (!(groups instanceof PDFArray) || groups.length !== 1) unsupported();
  const group = dict(groups.items[0], doc);
  onlyKeys(group, ['Type', 'Name']);
  if (group.getName('Type') !== 'OCG') unsupported();
  const label = group.get('Name');
  if (!(label instanceof PDFString || label instanceof PDFHexString)) unsupported();
  const groupLabel = stringBytes(label);
  if (!groupLabel.length || groupLabel.some(byte => byte < 0x20 || byte > 0x7e || byte === 0x27 || byte === 0x60)) unsupported();
  const configuration = dict(ocProperties.get('D'), doc);
  onlyKeys(configuration, ['BaseState', 'ON', 'OFF']);
  const baseState = configuration.getName('BaseState') ?? 'ON';
  if (!['ON', 'OFF'].includes(baseState)) unsupported();
  for (const key of ['ON', 'OFF'] as const) {
    const entry = configuration.get(key);
    if (!entry) continue;
    const array = resolve(entry, doc);
    if (!(array instanceof PDFArray)) unsupported();
    if (key === 'ON' && array.length !== 0) unsupported();
    if (key === 'OFF' && (array.length !== 1 || resolve(array.items[0], doc) !== group)) unsupported();
  }
  const visibility = new OptionalContentVisibility(doc.catalog, doc.objects);
  if (visibility.isVisible(groups.items[0])) unsupported();
  const tree = inspectPageTree(doc);
  const pageDicts = new Set<PDFDict>(), pageResources = new Set<PDFDict>(), streams = new Set<PDFStream>(), propertyNames = new Set<string>();
  const resourcePages: Array<{ page: PDFDocumentData['pages'][number]; resources: PDFDict; inherited: boolean }> = [];
  const contentKeys = new Set<string>(), secrets: Uint8Array[] = [], comparable: Uint8Array[] = [], visibleText: Uint8Array[] = [];
  const edits: Array<{ page: PDFDocumentData['pages'][number]; ref: PDFRef; output: Uint8Array; changed: boolean }> = [];
  let decodedTotal = 0, cutCount = 0;
  const encode = (value: string) => new TextEncoder().encode(value);
  const join = (values: Uint8Array[]) => {
    const joined = new Uint8Array(values.reduce((sum, value) => sum + value.length, 0));
    let offset = 0; for (const value of values) { joined.set(value, offset); offset += value.length; }
    return joined;
  };
  const inspectResources = (resources: PDFDict, requireFont: boolean) => {
    pageResources.add(resources);
    onlyKeys(resources, ['Font', 'Properties']);
    const propertiesValue = resources.get('Properties');
    const properties = propertiesValue ? dict(propertiesValue, doc) : undefined;
    if (properties && properties.size !== 1) unsupported();
    const [propertyName, propertyValue] = properties ? [...properties.entries()][0] : [undefined, undefined];
    if (properties && resolve(propertyValue, doc) !== group) unsupported();
    if (propertyName) propertyNames.add(propertyName);
    const fontValue = resources.get('Font');
    if (!fontValue && !requireFont) return { propertyName, fonts: undefined };
    const fonts = dict(fontValue, doc);
    if (fonts.size > 64) unsupported();
    for (const value of fonts.values()) {
      const font = dict(value, doc);
      onlyKeys(font, ['Type', 'Subtype', 'BaseFont', 'Encoding']);
      if (font.getName('Type') !== 'Font' || font.getName('Subtype') !== 'Type1' || !STANDARD_FONTS.has(font.getName('BaseFont') ?? '') ||
          (font.has('Encoding') && font.getName('Encoding') !== 'WinAnsiEncoding')) unsupported();
    }
    return { propertyName, fonts };
  };
  // Ancestor resources are still retained as part of the page tree, even if
  // every descendant overrides them. Inspect them before stripping Properties.
  for (const resources of tree.inheritedResources) inspectResources(resources, false);
  for (let pageIndex = 0; pageIndex < doc.pages.length; pageIndex++) {
    const page = doc.pages[pageIndex];
    if (doc.objects.get(page.ref.toKey()) !== page.dict || pageDicts.has(page.dict) ||
        page.dict.getName('Type') !== 'Page' || !tree.inherited.has(page.dict)) unsupported();
    pageDicts.add(page.dict);
    onlyKeys(page.dict, ['Type', 'Parent', 'MediaBox', 'CropBox', 'Rotate', 'Resources', 'Contents']);
    const contents = page.dict.get('Contents');
    const ownResources = page.dict.get('Resources');
    const resourcesValue = ownResources ?? tree.inherited.get(page.dict);
    if (resourcesValue === undefined) {
      if ((contents && !(contents instanceof PDFNull)) || page.contentRefs.length) unsupported();
      continue;
    }
    if (resolve(resourcesValue, doc) !== page.resources) unsupported();
    resourcePages.push({ page, resources: page.resources, inherited: ownResources === undefined });
    const { propertyName, fonts } = inspectResources(page.resources, !!contents && !(contents instanceof PDFNull));
    if (!contents || contents instanceof PDFNull) {
      if (page.contentRefs.length) unsupported();
      continue;
    }
    if (!fonts) unsupported();
    const ref = page.dict.getRef('Contents');
    if (!ref || contentKeys.has(ref.toKey()) || page.contentRefs.length !== 1 || page.contentRefs[0].toKey() !== ref.toKey()) unsupported();
    contentKeys.add(ref.toKey());
    const stream = doc.objects.get(ref.toKey());
    if (!(stream instanceof PDFStream) || streams.has(stream) || stream.dict.has('DecodeParms')) unsupported();
    streams.add(stream);
    onlyKeys(stream.dict, ['Length', 'Filter']);
    if (stream.dict.getNumber('Length') !== stream.rawBytes.length || stream.rawBytes.length > 1_048_576) unsupported();
    let decoded: Uint8Array;
    const filter = stream.dict.get('Filter');
    if (!filter) decoded = stream.rawBytes;
    else if (filter instanceof PDFName && ['FlateDecode', 'Fl'].includes(filter.name)) {
      try { decoded = decodeZlibFully(stream.rawBytes, 65_536); }
      catch { return unsupported(); }
    } else return unsupported();
    decodedTotal += decoded.length;
    if (decodedTotal > 1_048_576) unsupported();
    if (decoded.length > 65_536 || (stream.decodedBytes &&
        (stream.decodedBytes.length !== decoded.length || stream.decodedBytes.some((v, i) => v !== decoded[i])))) unsupported();
    const sequence = tokens(decoded);
    const operands: Token[] = [], cuts: Array<[number, number]> = [];
    let inText = false, depth = 0, hidden: { start: number; depth: number; operators: string[]; closed: boolean } | null = null;
    for (const token of sequence) {
      if (token.kind !== 'operator') { operands.push(token); continue; }
      const expected = OPERANDS[token.text];
      if (operands.length !== expected.length || operands.some((operand, i) => operand.kind !== expected[i])) unsupported();
      if (token.text === 'BDC') {
        if (hidden || inText || !propertyName || operands[0].text !== '/OC' || operands[1].text !== `/${propertyName}`) unsupported();
        hidden = { start: operands[0].start, depth, operators: [], closed: false };
      } else if (token.text === 'EMC') {
        if (!hidden || !hidden.closed || inText || depth !== hidden.depth || hidden.operators[0] !== 'q' || hidden.operators.at(-1) !== 'Q') unsupported();
        cuts.push([hidden.start, token.end]); hidden = null;
      } else {
        if (hidden) {
          // Once the outer saved state is restored, any subsequent operator
          // could affect visible content outside the block when it is removed.
          if (hidden.closed || (!hidden.operators.length && token.text !== 'q')) unsupported();
          hidden.operators.push(token.text);
        }
        if (token.text === 'q') depth++;
        if (token.text === 'Q' && (--depth < 0 || inText)) unsupported();
        if (token.text === 'Q' && hidden && depth === hidden.depth) hidden.closed = true;
        if (token.text === 'BT') { if (inText) unsupported(); inText = true; }
        if (token.text === 'ET') { if (!inText) unsupported(); inText = false; }
        if (token.text === 'Tf' && (!inText || !fonts.has(operands[0].text.slice(1)))) unsupported();
        if (['Td', 'Tm', 'Tj'].includes(token.text) && !inText) unsupported();
        if (token.text === 'Tj' && hidden) {
          if (secrets.length >= 64) unsupported();
          const secret = decodedText(operands[0]);
          // Standard-font ASCII has a stable byte-to-character mapping. Other
          // encodings cannot be compared reliably against retained metadata.
          if (secret.some(byte => byte < 0x20 || byte > 0x7e || byte === 0x27 || byte === 0x60)) unsupported();
          secrets.push(secret);
        }
      }
      operands.length = 0;
    }
    if (hidden || depth || inText || operands.length) unsupported();
    cutCount += cuts.length;
    const pieces: Uint8Array[] = [];
    let cursor = 0;
    for (const [start, end] of cuts) { pieces.push(decoded.slice(cursor, start)); cursor = end; }
    pieces.push(decoded.slice(cursor));
    const length = pieces.reduce((sum, part) => sum + part.length, 0);
    const output = new Uint8Array(length); let offset = 0;
    for (const piece of pieces) { output.set(piece, offset); offset += piece.length; }
    // Only simple, independently inspectable live objects remain. Search decoded
    // literal and hex operands rather than asserting a clear scan
    // over unknown encodings.
    const outputTokens = tokens(output);
    const visibleStrings = outputTokens.filter(token => token.kind === 'string').map(decodedText);
    visibleText.push(...visibleStrings);
    comparable.push(...visibleStrings);
    for (const token of outputTokens) {
      if (token.kind !== 'number') continue;
      // The retained bytes can use a different spelling from the numerical
      // equivalent or the spelling emitted when a PDF object is rewritten.
      comparable.push(encode(token.text), ...numericSpellings(new PDFNumber(Number(token.text))).map(encode));
    }
    comparable.push(...numericSpellings(new PDFNumber(output.length)).map(encode));
    if (!cuts.length) {
      comparable.push(...numericSpellings(new PDFNumber(stream.rawBytes.length)).map(encode));
      if (filter instanceof PDFName) comparable.push(encode(filter.name));
    }
    edits.push({ page, ref, output, changed: cuts.length > 0 });
  }
  if (!cutCount || !secrets.some(secret => secret.length)) unsupported();
  comparable.push(join(visibleText));
  const seen = new Set<PDFObject>();
  const pending: PDFObject[] = [doc.catalog, doc.xref.trailerDict];
  // Walk resource children separately so that a second retained reference to
  // an original resources dictionary is detected instead of skipping its
  // optional-content properties outside the page's own Resources edge.
  for (const resources of pageResources) for (const [key, value] of resources.entries()) {
    if (key === 'Properties') continue;
    comparable.push(encode(key));
    pending.push(value);
  }
  while (pending.length) {
    const value = pending.pop()!;
    if (seen.has(value)) continue;
    seen.add(value);
    if (seen.size > 4096 || pageResources.has(value as PDFDict)) unsupported();
    if (value instanceof PDFRef) {
      const target = doc.objects.get(value.toKey());
      if (!target) unsupported();
      pending.push(target);
    } else if (value instanceof PDFArray) pending.push(...value.items);
    else if (value instanceof PDFDict) {
      for (const [key, child] of value.entries()) {
        if ((value === doc.catalog && key === 'OCProperties') ||
            (pageDicts.has(value) && (key === 'Contents' || key === 'Resources')) ||
            (tree.nodes.has(value) && key === 'Resources')) continue;
        comparable.push(new TextEncoder().encode(key));
        pending.push(child);
      }
    } else if (value instanceof PDFStream) {
      // Any other reachable stream may hide an independent or encoded copy.
      unsupported();
    } else if (value instanceof PDFString || value instanceof PDFHexString) comparable.push(stringBytes(value));
    else if (value instanceof PDFName) comparable.push(new TextEncoder().encode(value.name));
    else if (value instanceof PDFNumber) comparable.push(...numericSpellings(value).map(encode));
  }
  const representations = [...secrets, join(secrets), groupLabel, ...[...propertyNames].map(encode)].flatMap(secret => {
    const be = new Uint8Array(secret.length * 2), le = new Uint8Array(secret.length * 2);
    secret.forEach((byte, index) => { be[index * 2 + 1] = byte; le[index * 2] = byte; });
    return [secret, be, le];
  });
  if (comparable.reduce((sum, value) => sum + value.length, 0) > 131_072) unsupported();
  comparable.push(join(comparable));
  if (representations.some(secret => comparable.some(value => contains(value, secret)))) unsupported();
  for (const { ref, output, changed } of edits) {
    if (changed) doc.objects.set(ref.toKey(), new PDFStream(new PDFDict([['Length', new PDFNumber(output.length)]]), output, output));
  }
  for (const { page, resources, inherited } of resourcePages) {
    if (inherited || resources.has('Properties')) {
      const nextResources = new PDFDict([...resources.entries()].filter(([key]) => key !== 'Properties'));
      page.dict.set('Resources', nextResources);
      page.resources = nextResources;
    }
  }
  for (const node of tree.nodes) {
    const value = node.get('Resources');
    if (value !== undefined) {
      const resources = dict(value, doc);
      if (resources.has('Properties')) {
        node.set('Resources', new PDFDict([...resources.entries()].filter(([key]) => key !== 'Properties')));
      }
    }
  }
  doc.catalog.delete('OCProperties');
  doc.requiresFullRewrite = true;
  return 1;
}
