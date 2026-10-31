import type { VisualSignature } from '@/engine/browser-core';
import { rotateSignature } from '@/engine/signatures/visual/signature-model';
import { resizeRotatedBox, type ResizeHandle } from './components/resizeGeometry';

export interface SignatureResizeStep {
  handle: ResizeHandle;
  dx: number;
  dy: number;
  free: boolean;
  /** Displacement in signature-local PDF axes, used by keyboard activation. */
  local?: boolean;
}

/** Apply each increment to the signature that exists when its edit is dequeued. */
export function resizeSignatureByStep(signature: VisualSignature, step: SignatureResizeStep): VisualSignature {
  if (signature.locked) return signature;
  const angle = signature.rotation * Math.PI / 180;
  const dx = step.local ? Math.cos(angle) * step.dx - Math.sin(angle) * step.dy : step.dx;
  const dy = step.local ? Math.sin(angle) * step.dx + Math.cos(angle) * step.dy : step.dy;
  const edge = step.handle.length === 1;
  const box = resizeRotatedBox(signature, step.handle, {
    dx, dy, minWidth: edge ? 8 : 24, minHeight: edge ? 8 : 16, free: step.free,
  }, signature.rotation);
  if (Math.abs(box.x - signature.x) < 1e-9 && Math.abs(box.y - signature.y) < 1e-9 &&
      Math.abs(box.width - signature.width) < 1e-9 && Math.abs(box.height - signature.height) < 1e-9) return signature;
  return { ...signature, ...box };
}

export function rotateSignatureByStep(signature: VisualSignature, degrees: number): VisualSignature {
  const updated = rotateSignature(signature, signature.rotation + degrees);
  return updated.rotation === signature.rotation ? signature : updated;
}
