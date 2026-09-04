/**
 * Re-exports of domain types the collectors need, so collector modules import from one
 * place rather than reaching across the tree.
 */

export type { Evidence, FindingDraft, Uuid, Timestamp } from '../types/index';
export type { Place } from '../resolve/types';
