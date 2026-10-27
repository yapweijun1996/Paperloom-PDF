/**
 * Tagged PDF accessibility — structure tree, role mapping, reading order.
 */

export {
  DEFAULT_ROLE_MAP,
  mapStructureRole,
  parseStructureTree,
  walkStructureTree,
  enrichReadingOrderWithMcidText,
  resetReadingOrderIdCounter,
} from './structure-walker';

export type {
  StandardStructureRole,
  MappedHtmlRole,
  StructureNode,
  StructureTree,
  ReadingOrderItem,
  WalkStructureOptions,
  RoleMappingTable,
} from './types';

export { DEFAULT_WALK_OPTIONS } from './types';
