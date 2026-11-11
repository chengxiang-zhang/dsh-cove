import { expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { migrateManagedWork } from '../src/host/services/superagent/protocol/migrations/managed-work.ts'
import { migrate } from '../src/host/services/superagent/protocol/db.ts'
it('imports legacy evidence once, freezes old writers and refuses old protocol', () => {
 const db = new DatabaseSync(':memory:')
 db.exec(`CREATE TABLE sa_commitment(commitment_id TEXT PRIMARY KEY, state TEXT, thread_key TEXT); INSERT INTO sa_commitment VALUES('C-1','unverified','t'),('C-2','orphaned','t'),('C-3','fulfilled','t'); CREATE TABLE sa_journal(body TEXT); INSERT INTO sa_journal VALUES('original'); CREATE TABLE inbox_events(id TEXT); INSERT INTO inbox_events VALUES('before')`)
 expect(() => migrateManagedWork(db, 1)).toThrow('WRITERS_NOT_RECONCILED')
 expect(migrateManagedWork(db, 1, { writersStopped: true }).imported).toBe(3)
 expect(migrateManagedWork(db, 2).imported).toBe(0)
 const rows = db.prepare('SELECT body_json FROM sa_managed_object ORDER BY id').all() as { body_json: string }[]
 expect(JSON.parse(rows[0]!.body_json).data.state).toBe('waiting')
 expect(JSON.parse(rows[2]!.body_json).data.state).toBe('fulfilled')
 expect(db.prepare('SELECT body FROM sa_journal').get()?.body).toBe('original')
 expect(() => db.exec("INSERT INTO sa_commitment VALUES('C-4','open','t')")).toThrow('LEGACY_FROZEN')
 db.exec("INSERT INTO inbox_events VALUES('after')"); expect(db.prepare('SELECT count(*) AS n FROM inbox_events').get()?.n).toBe(2)
 expect(() => migrate(db)).toThrow('PROTOCOL_GENERATION'); db.close()
})
it('rolls back a migration crash and then retries without duplicate evidence', () => {
 const db = new DatabaseSync(':memory:')
 db.exec(`CREATE TABLE sa_commitment(commitment_id TEXT,state TEXT); INSERT INTO sa_commitment VALUES('x','orphaned'); CREATE TRIGGER managed_freeze_sa_commitment_INSERT BEFORE INSERT ON sa_commitment BEGIN SELECT 1; END;`)
 expect(() => migrateManagedWork(db, 1, { writersStopped: true })).toThrow()
 expect(db.prepare("SELECT name FROM sqlite_master WHERE name='sa_managed_meta'").get()).toBeUndefined()
 db.exec('DROP TRIGGER managed_freeze_sa_commitment_INSERT')
 expect(migrateManagedWork(db, 1, { writersStopped: true }).imported).toBe(1)
 expect(migrateManagedWork(db, 1, { writersStopped: true }).imported).toBe(0)
 expect(db.prepare('SELECT count(*) AS n FROM sa_managed_object').get()?.n).toBe(1); db.close()
})
it('retains ambiguous identities and attempts as legacy records without inventing Workers or bindings', () => {
 const db = new DatabaseSync(':memory:')
 db.exec("CREATE TABLE sa_party(party_id TEXT,kind TEXT); INSERT INTO sa_party VALUES('p','person'); CREATE TABLE sa_attempt(attempt_id TEXT,commitment_id TEXT,provider TEXT); INSERT INTO sa_attempt VALUES('a','c','ambiguous')")
 expect(migrateManagedWork(db, 1, { writersStopped: true }).imported).toBe(2)
 const rows = db.prepare('SELECT kind, body_json FROM sa_managed_object').all()
 expect(rows.every(r => r.kind === 'legacy_record')).toBe(true)
 expect(rows.some(r => JSON.parse(String(r.body_json)).data.legacy_source.provider === 'ambiguous')).toBe(true); db.close()
})
it('fences a legacy connection already open before migration while keeping admission writable', async () => {
 const { mkdtempSync, rmSync } = await import('node:fs')
 const { tmpdir } = await import('node:os')
 const { join } = await import('node:path')
 const dir = mkdtempSync(join(tmpdir(), 'migration-')); const path = join(dir, 'db')
 const old = new DatabaseSync(path); const next = new DatabaseSync(path)
 try {
  old.exec("CREATE TABLE sa_commitment(commitment_id TEXT,state TEXT); INSERT INTO sa_commitment VALUES('c','open'); CREATE TABLE inbox_events(id TEXT)")
  const insert = old.prepare("INSERT INTO sa_commitment VALUES('late','open')")
  migrateManagedWork(next, 1, { writersStopped: true })
  expect(() => insert.run()).toThrow('LEGACY_FROZEN')
  old.exec("INSERT INTO inbox_events VALUES('admitted')")
  expect(next.prepare('SELECT id FROM inbox_events').get()?.id).toBe('admitted')
 } finally { old.close(); next.close(); rmSync(dir, { recursive: true, force: true }) }
})
