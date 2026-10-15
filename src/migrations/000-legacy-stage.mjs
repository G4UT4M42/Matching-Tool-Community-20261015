/** Versioned legacy offline migration adapter. No activation. */
export const migrationId = 'legacy-v2-offline-stage-000';
export const fromVersion = 'legacy-v2';
export const toVersion = 'community-pending-verification';
export { stageLegacyV2 } from '../migration/offline-v2.mjs';
