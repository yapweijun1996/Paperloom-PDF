import { describe, expect, it, vi } from 'vitest';
import { openDocumentLink } from './document-link';

function browser(accept = false) {
  return { open: vi.fn(), confirm: vi.fn(() => accept) };
}

describe('opening links from untrusted PDF documents', () => {
  it.each(['https://example.com/p', 'http://example.com/', 'mailto:reader@example.com', 'tel:+15551234567'])(
    'opens allowed %s links without confirmation and with no opener', (url) => {
      const target = browser();
      expect(openDocumentLink(url, target)).toBe('requested');
      expect(target.confirm).not.toHaveBeenCalled();
      expect(target.open).toHaveBeenCalledWith(url, '_blank', 'noopener,noreferrer');
    },
  );

  it.each(['javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'data:text/html,test', 'file:///private/data', 'blob:https://example.com/id', 'about:blank', 'java\nscript:alert(1)', '/relative', 'mailto:', 'tel:'])(
    'blocks %s without trying to open or confirm it', (url) => {
      const target = browser(true);
      expect(openDocumentLink(url, target)).toBe('blocked');
      expect(target.confirm).not.toHaveBeenCalled();
      expect(target.open).not.toHaveBeenCalled();
    },
  );

  it('requires explicit confirmation before opening other schemes', () => {
    const denied = browser(false);
    expect(openDocumentLink('custom-app://record/42', denied)).toBe('cancelled');
    expect(denied.confirm).toHaveBeenCalledWith(expect.stringContaining('custom-app://record/42'));
    expect(denied.open).not.toHaveBeenCalled();
    const approved = browser(true);
    expect(openDocumentLink('custom-app://record/42', approved)).toBe('requested');
    expect(approved.open).toHaveBeenCalledWith('custom-app://record/42', '_blank', 'noopener,noreferrer');
  });
});
