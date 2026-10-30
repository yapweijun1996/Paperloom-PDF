import type { PageOverlays } from '../overlay-pages';
import type { VisualSignature } from '@/engine/browser-core';

export type OverlayKind = keyof PageOverlays;

interface Props {
  overlays: PageOverlays;
  pageKeys: string[];
  invalidSignatures?: VisualSignature[];
  onAssign: (kind: OverlayKind, id: string, pageKey: string) => void;
}

/** Older recovery records cannot identify the page of an unsaved overlay. */
export function UnassignedOverlays({ overlays, pageKeys, onAssign, invalidSignatures = [] }: Props) {
  const items = [
    ...overlays.floatingTexts.filter(item => !item.pageKey).map(item => ({ kind: 'floatingTexts' as const, id: item.id, description: `Text: ${item.text}`, image: '' })),
    ...overlays.floatingImages.filter(item => !item.pageKey).map(item => ({ kind: 'floatingImages' as const, id: item.id, description: 'Image', image: item.dataUrl })),
    ...overlays.drawnPaths.filter(item => !item.pageKey).map(item => ({ kind: 'drawnPaths' as const, id: item.id, description: `Drawing: ${item.kind ?? 'freehand'} (${item.points.length} points)`, image: '' })),
  ];
  if (!items.length && !invalidSignatures.length) return null;
  return (
    <section aria-label="Assign recovered overlays" className="absolute z-50 top-4 left-4 right-4 max-h-[50vh] overflow-auto rounded-lg border border-amber-400 bg-panel p-4 shadow-lg text-app">
      <p className="font-semibold">Choose the page for each recovered item</p>
      <p className="text-sm">This older recovery did not record page locations. Your items are preserved until you assign them.</p>
      <ul className="mt-3 space-y-3">
        {items.map((item, index) => (
          <li key={`${item.kind}-${item.id}`} className="flex flex-wrap items-center gap-2">
            {item.image && <img src={item.image} alt="Recovered image" className="max-h-14 max-w-20 object-contain" />}
            <span className="min-w-0 flex-1 break-words">{item.description}</span>
            <label className="text-sm">
              <span className="sr-only">Page for recovered item {index + 1}: {item.description}</span>
              <select value="" onChange={event => onAssign(item.kind, item.id, event.target.value)} className="rounded border border-app bg-panel p-2 text-app">
                <option value="">Choose page</option>
                {pageKeys.map((key, pageIndex) => <option key={key} value={key}>Page {pageIndex + 1}</option>)}
              </select>
            </label>
          </li>
        ))}
        {invalidSignatures.map((signature, index) => (
          <li key={`signature-${signature?.id ?? index}`} className="text-sm">
            A recovered signature has no valid page. Its local recovery is preserved; restore an intact backup before saving.
          </li>
        ))}
      </ul>
    </section>
  );
}
