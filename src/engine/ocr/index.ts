/**
 * OCR preprocessing — projection profiles, layout detection, deskew.
 */

export {
  computeHorizontalProjection,
  computeVerticalProjection,
  detectLayoutRegions,
  detectDeskewAngle,
  analyzePageLayout,
  resetRegionIdCounter,
} from './projection-profiles';

export type {
  GrayscaleImage,
  ProjectionProfile,
  LayoutRegion,
  PageLayout,
  DeskewResult,
  ProjectionOptions,
  DeskewOptions,
} from './types';

export { DEFAULT_PROJECTION_OPTIONS, DEFAULT_DESKEW_OPTIONS } from './types';
