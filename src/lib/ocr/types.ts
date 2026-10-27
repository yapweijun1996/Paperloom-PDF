export type { OcrWord, OcrAdapter } from './adapter';
export {
  StubOcrAdapter,
  TesseractOcrAdapter,
  createDefaultOcrAdapter,
  canvasToImageData,
  mapOcrWordsToPdf,
} from './adapter';
