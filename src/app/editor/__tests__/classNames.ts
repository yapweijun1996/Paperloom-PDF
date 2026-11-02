// Shared, test-only helpers for source guards that inspect JSX class names.
// Node environment only: reads source files and parses them with TypeScript.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';

export type Opening = ts.JsxOpeningElement | ts.JsxSelfClosingElement;

/** Non-test .ts/.tsx files below `directory`, sorted. */
export function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const file = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(file);
    return /\.tsx?$/.test(file) && !/\.(test|spec)\.tsx?$/.test(file) ? [file] : [];
  }).sort();
}

export function parseSource(file: string): ts.SourceFile {
  return ts.createSourceFile(
    file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true,
    file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
}

export function attribute(opening: Opening, name: string): ts.JsxAttribute | undefined {
  return opening.attributes.properties.find((item): item is ts.JsxAttribute =>
    ts.isJsxAttribute(item) && item.name.getText() === name);
}

// Expand conditional class branches independently, including templates whose
// common prefix contains the positioning classes. Class order/formatting is irrelevant.
export function classBranches(node: ts.Node | undefined): string[] {
  if (!node) return [''];
  if (ts.isStringLiteralLike(node)) return [node.text];
  if (ts.isJsxExpression(node)) return classBranches(node.expression);
  if (ts.isParenthesizedExpression(node)) return classBranches(node.expression);
  if (ts.isConditionalExpression(node)) {
    return [...classBranches(node.whenTrue), ...classBranches(node.whenFalse)];
  }
  if (ts.isTemplateExpression(node)) {
    return node.templateSpans.reduce<string[]>((prefixes, span) =>
      prefixes.flatMap(prefix => classBranches(span.expression).map(value => prefix + value + span.literal.text)),
    [node.head.text]);
  }
  if (ts.isBinaryExpression(node)) {
    if (node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      return classBranches(node.left).flatMap(left => classBranches(node.right).map(right => left + right));
    }
    if (node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) {
      return ['', ...classBranches(node.right)];
    }
  }
  return ['']; // Non-class expressions (e.g. a numeric width) add no utilities.
}

/** Every JSX opening or self-closing element in the source, in document order. */
export function openings(source: ts.SourceFile): Opening[] {
  const result: Opening[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) result.push(node);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return result;
}
