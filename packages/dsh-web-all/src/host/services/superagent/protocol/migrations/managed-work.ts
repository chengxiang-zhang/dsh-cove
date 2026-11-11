import type { DatabaseSync } from 'node:sqlite'
import { validateManagedObject, type ManagedObject } from '../managed-work.ts'
export interface MigrationReport { fromVersion: number; toVersion: 2; imported: number; legacyFrozen: boolean }
export function managedGeneration(db: DatabaseSync): number | undefined {
 if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='sa_managed_meta'").get()) return undefined
 return Number(db.prepare('SELECT generation FROM sa_managed_meta WHERE singleton=1').get()?.generation)
}
/** Explicit offline migration. BEGIN IMMEDIATE serializes against every existing writer.
 * The caller must reconcile remote in-flight effects before attesting writersStopped.
 * Original tables remain immutable evidence, never a second writable Task queue.
 */
export function migrateManagedWork(db: DatabaseSync, fromVersion: number, options?: { writersStopped: boolean }): MigrationReport {
 db.exec('BEGIN IMMEDIATE')
 try {
  const generation = managedGeneration(db)
  if (generation !== undefined) {
   if (generation !== 2 || ![1,2].includes(fromVersion)) throw new Error('PROTOCOL_GENERATION')
   db.exec('COMMIT'); return { fromVersion, toVersion: 2, imported: 0, legacyFrozen: true }
  }
  if (![0,1].includes(fromVersion)) throw new Error('PROTOCOL_GENERATION')
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND (name LIKE 'sa_%' OR name='inbox_events')").all() as { name: string }[]
  if (tables.length && !options?.writersStopped) throw new Error('WRITERS_NOT_RECONCILED')
  db.exec(`CREATE TABLE sa_managed_meta(singleton INTEGER PRIMARY KEY CHECK(singleton=1), generation INTEGER NOT NULL CHECK(generation=2), sequence INTEGER NOT NULL); INSERT INTO sa_managed_meta VALUES(1,2,0);
  CREATE TABLE sa_managed_object(id TEXT PRIMARY KEY, kind TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>=1), body_json TEXT NOT NULL CHECK(json_valid(body_json)), legacy INTEGER NOT NULL CHECK(legacy IN(0,1)),
   CHECK(json_extract(body_json,'$.id')=id AND json_extract(body_json,'$.kind')=kind AND json_extract(body_json,'$.revision')=revision),
   CHECK(legacy=1 OR kind<>'commitment' OR (json_extract(body_json,'$.data.state') IN ('proposed','ready','working','verifying','delivering','fulfilled','waiting','at_risk','released','withdrawn','broken') AND json_extract(body_json,'$.data.control_state') IN ('autonomous','paused','human_controlled'))));
  CREATE INDEX sa_managed_kind ON sa_managed_object(kind);
  CREATE TABLE sa_managed_event(sequence INTEGER PRIMARY KEY, body_json TEXT NOT NULL CHECK(json_valid(body_json)));
  CREATE TRIGGER sa_managed_event_update BEFORE UPDATE ON sa_managed_event BEGIN SELECT RAISE(ABORT,'APPEND_ONLY'); END;
  CREATE TRIGGER sa_managed_event_delete BEFORE DELETE ON sa_managed_event BEGIN SELECT RAISE(ABORT,'APPEND_ONLY'); END;
  CREATE TRIGGER sa_managed_legacy_update BEFORE UPDATE ON sa_managed_object WHEN OLD.legacy=1 BEGIN SELECT RAISE(ABORT,'LEGACY_READ_ONLY'); END;
  CREATE TRIGGER sa_managed_terminal_update BEFORE UPDATE ON sa_managed_object WHEN OLD.kind='commitment' AND json_extract(OLD.body_json,'$.data.state') IN ('fulfilled','released','withdrawn','broken') BEGIN SELECT RAISE(ABORT,'TERMINAL'); END;
  CREATE TRIGGER sa_managed_no_replace BEFORE INSERT ON sa_managed_object WHEN EXISTS(SELECT 1 FROM sa_managed_object WHERE id=NEW.id) BEGIN SELECT RAISE(ABORT,'OBJECT_EXISTS'); END;
  CREATE TRIGGER sa_managed_event_replace BEFORE INSERT ON sa_managed_event WHEN EXISTS(SELECT 1 FROM sa_managed_event WHERE sequence=NEW.sequence) BEGIN SELECT RAISE(ABORT,'APPEND_ONLY'); END;
  CREATE TRIGGER sa_managed_object_delete BEFORE DELETE ON sa_managed_object BEGIN SELECT RAISE(ABORT,'APPEND_ONLY'); END;`)
  let imported = 0
  const mapping: Record<string,string> = { sa_commitment: 'commitment', sa_attempt: 'legacy_record', sa_party: 'legacy_record' }
  for (const table of tables) {
   const kind = mapping[table.name]
   if (kind) {
    const rows = db.prepare(`SELECT * FROM "${table.name.replaceAll('"','""')}"`).all()
    for (const row of rows) {
     const id = `${table.name}:legacy:${String(row.attempt_id ?? row.party_id ?? row.commitment_id)}`
     const state = row.state === 'unverified' || row.state === 'orphaned' ? 'waiting' : row.state === 'open' ? 'ready' : typeof row.state === 'string' ? row.state : null
     const o: ManagedObject = { id, kind, revision: 1, scope_revision_refs: [], extensions: {}, data: { legacy_source_table: table.name, legacy_source: JSON.parse(JSON.stringify(row)), state, control_state: 'paused', pause_reason: 'ownership_unconfirmed', previous_control_state: 'unknown', diagnostic: 'Legacy evidence retained; current ownership, bindings, contracts and evidence require recheck', read_only: true } }
     validateManagedObject(o, true)
     db.prepare('INSERT INTO sa_managed_object VALUES(?,?,?,?,1)').run(id, kind, 1, JSON.stringify(o)); imported++
    }
   }
   // Shared transport admission/claim storage stays live; only legacy business writers freeze.
   if (table.name === 'inbox_events') continue
   const quoted = `"${table.name.replaceAll('"','""')}"`
   for (const op of ['INSERT','UPDATE','DELETE']) db.exec(`CREATE TRIGGER "managed_freeze_${table.name}_${op}" BEFORE ${op} ON ${quoted} BEGIN SELECT RAISE(ABORT,'LEGACY_FROZEN'); END`)
  }
  db.exec('COMMIT'); return { fromVersion, toVersion: 2, imported, legacyFrozen: true }
 } catch (e) { db.exec('ROLLBACK'); throw e }
}
