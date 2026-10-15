/**
 * Papierkorb / Trash — soft-delete with restore capability.
 */
import { getDb } from './db.js';
import { randomBytes } from 'crypto';

export interface TrashItem {
  trash_id: string;
  entity_type: string;
  entity_id: string;
  entity_data: any;
  deleted_at: string;
  deleted_by: string;
  note: string | null;
}

function trashId(): string {
  return 'TRASH-' + randomBytes(8).toString('hex');
}

/** Move an entity to trash — stores a JSON snapshot for later restore */
export function moveToTrash(entityType: string, entityId: string, entityData: any, note?: string): string {
  const db = getDb();
  const id = trashId();
  db.prepare(`
    INSERT INTO trash (trash_id, entity_type, entity_id, entity_data, deleted_at, deleted_by, note)
    VALUES (?, ?, ?, ?, datetime('now'), 'user', ?)
  `).run(id, entityType, entityId, JSON.stringify(entityData), note ?? null);
  return id;
}

/** List trash items, optionally filtered by type */
export function listTrash(entityType?: string): TrashItem[] {
  const db = getDb();
  let rows;
  if (entityType) {
    rows = db.prepare('SELECT * FROM trash WHERE entity_type = ? ORDER BY deleted_at DESC').all(entityType) as any[];
  } else {
    rows = db.prepare('SELECT * FROM trash ORDER BY deleted_at DESC').all() as any[];
  }
  return rows.map(r => ({
    ...r,
    entity_data: JSON.parse(r.entity_data),
  }));
}

/** Get a single trash item */
export function getTrashItem(trashId: string): TrashItem | null {
  const row = getDb().prepare('SELECT * FROM trash WHERE trash_id = ?').get(trashId) as any;
  if (!row) return null;
  return { ...row, entity_data: JSON.parse(row.entity_data) };
}

/** Permanently delete from trash */
export function deleteFromTrash(trashId: string): boolean {
  return getDb().prepare('DELETE FROM trash WHERE trash_id = ?').run(trashId).changes > 0;
}

/** Empty entire trash or by type */
export function emptyTrash(entityType?: string): number {
  const db = getDb();
  if (entityType) {
    return db.prepare('DELETE FROM trash WHERE entity_type = ?').run(entityType).changes;
  }
  return db.prepare('DELETE FROM trash').run().changes;
}

/** Restore from trash — returns the entity data (caller must re-insert into the right table) */
export function restoreFromTrash(trashId: string): TrashItem | null {
  const item = getTrashItem(trashId);
  if (!item) return null;
  deleteFromTrash(trashId);
  return item;
}
