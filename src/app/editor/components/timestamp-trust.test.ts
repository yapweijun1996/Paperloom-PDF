import { createElement, type ComponentProps } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { PropertiesSidebar } from './PropertiesSidebar';

it('discloses timestamp trust limits and fallback beside the timestamp setting', () => {
  const props = { activeTool: 'sign', enableTimestamp: true, displayItems: [] } as unknown as ComponentProps<typeof PropertiesSidebar>;
  const html = renderToStaticMarkup(createElement(PropertiesSidebar, props));
  expect(html).toContain('TSA certificate trust and revocation are not verified');
  expect(html).toContain('Signing continues without a timestamp');
  expect(html).toContain('Use a trusted PDF validator');
});

it('distinguishes document-signature validation from timestamp trust', () => {
  const props = {
    activeTool: 'sign', displayItems: [], validationReport: {
      documentStatus: 'Valid', signatures: [], revisionCount: 1, validatedAt: '', errors: [],
    },
  } as unknown as ComponentProps<typeof PropertiesSidebar>;
  const html = renderToStaticMarkup(createElement(PropertiesSidebar, props));
  expect(html).toContain('Timestamp trust is not verified');
});
