import { useRef } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';

type DrawingEvent = ReactPointerEvent<HTMLDivElement>;

/** Track one gesture, including movement outside the page via pointer capture. */
export function useDrawingPointer(options: {
  enabled: boolean;
  start: (event: DrawingEvent) => boolean;
  move: (event: DrawingEvent) => void;
  end: (willClick: boolean) => void;
}) {
  const active = useRef<{ id: number; move: typeof options.move; end: typeof options.end } | null>(null);

  const finish = (event: DrawingEvent, release: boolean, willClick: boolean) => {
    const gesture = active.current;
    if (!gesture || gesture.id !== event.pointerId) return;
    active.current = null;
    if (release) {
      try {
        event.currentTarget.releasePointerCapture(event.pointerId);
      } catch {
        // The browser may already have released capture on cancellation.
      }
    }
    gesture.end(willClick);
  };

  return {
    onPointerDown(event: DrawingEvent) {
      if (!options.enabled || active.current || !event.isPrimary || event.button !== 0) return;
      if (!options.start(event)) return;
      active.current = { id: event.pointerId, move: options.move, end: options.end };
      try {
        event.currentTarget.setPointerCapture(event.pointerId);
      } catch {
        // The gesture can still complete while the pointer stays on the page.
      }
      event.preventDefault();
    },
    onPointerMove(event: DrawingEvent) {
      const gesture = active.current;
      if (!gesture || gesture.id !== event.pointerId) return;
      gesture.move(event);
      event.preventDefault();
    },
    onPointerUp(event: DrawingEvent) {
      const gesture = active.current;
      if (!gesture || gesture.id !== event.pointerId) return;
      gesture.move(event);
      finish(event, true, true);
    },
    onPointerCancel(event: DrawingEvent) { finish(event, true, false); },
    onLostPointerCapture(event: DrawingEvent) { finish(event, false, false); },
  };
}
