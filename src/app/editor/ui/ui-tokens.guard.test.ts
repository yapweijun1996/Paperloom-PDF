// @vitest-environment node
// Stricter than the palette ratchet: that one only reads className attributes,
// while primitives keep their classes in variant maps. This guard reads every
// string in src/app/editor/ui, so maps, defaults and helpers are covered too.
import { relative } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { attribute, isRawPaletteClass, openings, parseSource, sourceFiles } from '../__tests__/classNames';

const sources = sourceFiles(__dirname)
  .filter(file => !file.includes('__tests__'))
  .map(parseSource);
const HEX = /#[0-9a-f]{3,8}\b/i;

function where(source: ts.SourceFile, node: ts.Node): string {
  return `${relative(__dirname, source.fileName)}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}`;
}

function visit(node: ts.Node, callback: (node: ts.Node) => void) {
  callback(node);
  ts.forEachChild(node, child => visit(child, callback));
}

describe('editor ui primitives use tokens only', () => {
  it('covers every primitive module', () => {
    const names = sources.map(source => relative(__dirname, source.fileName)).sort();
    expect(names).toEqual(expect.arrayContaining(['Button.tsx', 'Dialog.tsx', 'Field.tsx', 'MobileSheet.tsx', 'Notice.tsx', 'index.ts']));
  });

  it('contains no raw palette classes or hex colours in any string', () => {
    const failures: string[] = [];
    for (const source of sources) {
      visit(source, node => {
        if (!ts.isStringLiteralLike(node) && !ts.isTemplateHead(node) && !ts.isTemplateMiddle(node) && !ts.isTemplateTail(node)) return;
        const raw = node.text.split(/\s+/).filter(isRawPaletteClass);
        if (raw.length) failures.push(`${where(source, node)}: ${raw.join(' ')}`);
        if (HEX.test(node.text)) failures.push(`${where(source, node)}: hex colour ${HEX.exec(node.text)![0]}`);
      });
    }
    expect(failures).toEqual([]);
  });

  it('keeps variant class maps static and never builds class names from templates', () => {
    const failures: string[] = [];
    for (const source of sources) {
      visit(source, node => {
        if (ts.isVariableDeclaration(node) && /CLASSES$/.test(node.name.getText())) {
          const value = node.initializer;
          const literal = (item: ts.Node | undefined) => !!item && (ts.isStringLiteral(item) || ts.isNoSubstitutionTemplateLiteral(item));
          const ok = literal(value) || (!!value && ts.isObjectLiteralExpression(value) &&
            value.properties.every(item => ts.isPropertyAssignment(item) && literal(item.initializer)));
          if (!ok) failures.push(`${where(source, node)}: ${node.name.getText()} must be a string or a map of string literals`);
        }
      });
      for (const opening of openings(source)) {
        const value = attribute(opening, 'className')?.initializer;
        let dynamic = false;
        if (value) visit(value, child => { if (ts.isTemplateExpression(child)) dynamic = true; });
        if (dynamic) failures.push(`${where(source, opening)}: className uses a template expression`);
      }
    }
    expect(failures).toEqual([]);
  });
});
