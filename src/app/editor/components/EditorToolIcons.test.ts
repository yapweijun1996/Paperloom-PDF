// @vitest-environment node
import { createElement, Fragment } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import * as icons from './EditorToolIcons';

const components = Object.entries(icons).filter(([name]) => name.endsWith('ToolIcon')) as
  [string, (props: icons.CustomIconProps) => React.JSX.Element][];

describe('EditorToolIcons gradient ids', () => {
  it('covers every gradient icon', () => {
    expect(components.length).toBeGreaterThanOrEqual(8);
  });

  for (const [name, Icon] of components) {
    it(`${name} gives each rendered instance its own resolvable gradient id`, () => {
      // The tool strip and its tooltip render the same icon twice on one page.
      const html = renderToStaticMarkup(createElement(Fragment, null, createElement(Icon), createElement(Icon)));
      const svgs = html.match(/<svg[\s\S]*?<\/svg>/g) ?? [];
      expect(svgs).toHaveLength(2);
      const ids = svgs.map(svg => [...svg.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]));
      for (const [index, svg] of svgs.entries()) {
        expect(ids[index].length).toBeGreaterThan(0);
        for (const id of ids[index]) expect(id).toMatch(/^[A-Za-z0-9_-]+$/);
        const references = [...svg.matchAll(/url\(#([^)]+)\)/g)].map(match => match[1]);
        expect(references.length).toBeGreaterThan(0);
        for (const reference of references) expect(ids[index]).toContain(reference);
      }
      const all = ids.flat();
      expect(new Set(all).size).toBe(all.length);
    });
  }
});
