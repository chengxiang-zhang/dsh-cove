import { DatabaseSync } from 'node:sqlite'
import { registerHooks, stripTypeScriptTypes } from 'node:module'
import { readFileSync } from 'node:fs'
// Public source dependency closure only. Node's fixed transform handles parameter
// properties; no compiler package, subprocess, network or configurable code input.
const sourceRoot = new URL('../../../src/host/services/superagent/', import.meta.url).href
const deniedTransport = 'data:text/javascript,export default class DeniedTransport { constructor() { throw Error("FIXTURE_NETWORK_FORBIDDEN") } }'
// Only unused WebSocket construction is denied; this fixture does not qualify HTTP transport.
registerHooks({ resolve(specifier, context, next) {
  if (specifier === 'ws' && context.parentURL === sourceRoot + 'executors/transport/http.ts') return {shortCircuit:true,url:deniedTransport}
  return next(specifier, context)
}, load(url, context, next) {
  if (url.startsWith(sourceRoot) && url.endsWith('.ts')) return { format: 'module', shortCircuit: true, source: stripTypeScriptTypes(readFileSync(new URL(url), 'utf8'), { mode: 'transform' }) }
  return next(url, context)
} })
const { migrate, selfCheck } = await import('../../../src/host/services/superagent/protocol/db.ts')
const { createLedger } = await import('../../../src/host/services/superagent/kernel/ledger.ts')
const { createExecutors } = await import('../../../src/host/services/superagent/executors/attempts.ts')
// Historical deployed DDL only; never copies personal rows, messages or tokens.
const historicalAttempt = "CREATE TABLE sa_attempt (\n  \"attempt_id\" TEXT NOT NULL,\n  \"commitment_id\" TEXT NOT NULL,\n  \"n\" INTEGER NOT NULL CHECK (\"n\" BETWEEN 1 AND 3),\n  \"executor\" TEXT NOT NULL,\n  \"provider\" TEXT,\n  \"model\" TEXT,\n  \"effort\" TEXT,\n  \"reason\" TEXT NOT NULL CHECK (length(trim(\"reason\")) > 0),\n  \"lifetime\" TEXT NOT NULL CHECK (\"lifetime\" IN ('oneshot', 'durable')),\n  \"session_id\" TEXT,\n  \"cwd\" TEXT,\n  \"branch\" TEXT,\n  \"state\" TEXT NOT NULL CHECK (\"state\" IN ('pending', 'running', 'ended')),\n  \"turn_open\" INTEGER NOT NULL DEFAULT 0 CHECK (\"turn_open\" IN (0, 1)),\n  \"turns\" INTEGER NOT NULL DEFAULT 0,\n  \"tool_calls\" INTEGER NOT NULL DEFAULT 0,\n  \"last_tool_at\" INTEGER,\n  \"repeat_sig\" TEXT,\n  \"repeat_count\" INTEGER NOT NULL DEFAULT 0,\n  \"end_reason\" TEXT CHECK (\"end_reason\" IN ('completed', 'aborted', 'blocked', 'error', 'max-tokens', 'interrupted', 'forked', 'orphaned', 'dispatch_failed', 'unknown')),\n  \"cancel_origin\" TEXT CHECK (\"cancel_origin\" IN ('release', 'budget', 'deadline', 'stall', 'loop', 'dispatch', 'reconcile')),\n  \"started_at\" INTEGER,\n  \"ended_at\" INTEGER,\n  \"created_at\" INTEGER NOT NULL,\n  \"updated_at\" INTEGER, \"host\" TEXT,\n  PRIMARY KEY (\"attempt_id\")\n)"
const insert = (db, table, row) => db.prepare(`INSERT INTO ${table} (${Object.keys(row).map(k=>`"${k}"`).join(',')}) VALUES (${Object.keys(row).map(()=>'?').join(',')})`).run(...Object.values(row))
const snapshot = db => JSON.stringify({schema:db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name").all(),attempts:db.prepare('SELECT * FROM sa_attempt ORDER BY attempt_id').all()})
const canonicalRows = rows => JSON.stringify(rows.map(row=>Object.fromEntries(Object.keys(row).sort().map(key=>[key,row[key]]))))
// Fixture qualification controls: column order is irrelevant; values and row count are not.
if (canonicalRows([{a:1,b:2}]) !== canonicalRows([{b:2,a:1}]) || canonicalRows([{a:1}]) === canonicalRows([{a:2}]) || canonicalRows([{a:1}]) === canonicalRows([])) throw Error('FIXTURE_ROW_COMPARISON_FAILED')
const attemptObjects = db => db.prepare("SELECT type,name,sql FROM sqlite_master WHERE tbl_name='sa_attempt' AND type IN ('index','trigger') ORDER BY type,name").all()
export function probe(options = {}) {
  if (Object.keys(options).some(k=>!['legacy','rollback','origin'].includes(k)) || (options.legacy!==undefined&&typeof options.legacy!=='boolean') || (options.rollback!==undefined&&typeof options.rollback!=='boolean') || (options.origin!==undefined&&typeof options.origin!=='string')) throw Error('PROBE_OPTIONS_INVALID')
  const db = new DatabaseSync(':memory:')
  try {
    db.exec("CREATE TABLE inbox_events(event_id TEXT PRIMARY KEY, file TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending',attempts INTEGER NOT NULL DEFAULT 0,received_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,payload TEXT NOT NULL,message_id TEXT NOT NULL DEFAULT '')")
    migrate(db)
    const objects=attemptObjects(db).filter(o=>o.sql)
    if (options.legacy !== false) { db.exec('DROP TABLE sa_attempt');db.exec(historicalAttempt);for(const object of objects)db.exec(object.sql) }
    db.exec("CREATE INDEX fixture_attempt_reason ON sa_attempt(reason); CREATE TRIGGER fixture_attempt_guard BEFORE UPDATE OF reason ON sa_attempt WHEN NEW.reason='forbidden-fixture' BEGIN SELECT RAISE(ABORT,'FIXTURE_GUARD'); END")
    insert(db,'sa_commitment',{commitment_id:'C-1',n:1,kind:'deliver',debtor:'me',creditor:'fixture-owner',ball:'me',thread_key:'fixture-thread',origin_kind:'event',origin_ref:'fixture-event',what:'fixture work',intent:'fixture',check_kind:'command',done_when:'fixture',state:'open',next_look_at:10,budget_wall_ms:60000,budget_turns:5,created_at:1})
    for (const [id,n,state,origin] of [['old',1,'ended','budget'],['active',2,'running',null]]) insert(db,'sa_attempt',{attempt_id:id,commitment_id:'C-1',n,executor:'fixture',reason:'synthetic public fixture',lifetime:'oneshot',session_id:'session-'+id,state,cancel_origin:origin,turn_open:state==='running'?1:0,created_at:1,updated_at:2})
    const beforeRows=canonicalRows(db.prepare('SELECT * FROM sa_attempt ORDER BY attempt_id').all()),beforeObjects=JSON.stringify(attemptObjects(db)),before=snapshot(db)
    let migrationError=null
    const migrationDb=options.rollback?{prepare:db.prepare.bind(db),exec(sql){if(sql.includes('CREATE TRIGGER IF NOT EXISTS sa_inbox_owner_cas'))throw Error('INJECTED_LATE_MIGRATION_FAILURE');return db.exec(sql)}}:db
    try{migrate(migrationDb)}catch(e){migrationError=options.rollback&&e.message==='INJECTED_LATE_MIGRATION_FAILURE'?'injected':e.code??e.name}
    const rowsPreserved=beforeRows===canonicalRows(db.prepare('SELECT * FROM sa_attempt ORDER BY attempt_id').all()),objectsPreserved=beforeObjects===JSON.stringify(attemptObjects(db)),rollbackUnchanged=options.rollback?before===snapshot(db):null
    let idempotent=null
    if(!migrationError){const first=snapshot(db);const repeat=migrate(db);idempotent=first===snapshot(db)&&repeat.added.length===0}
    const rejected=(sql)=>{db.exec('SAVEPOINT probe');let no=false;try{db.exec(sql)}catch{no=true}finally{db.exec('ROLLBACK TO probe; RELEASE probe')}return no}
    const rejectedInvalidOrigin=rejected("UPDATE sa_attempt SET cancel_origin='not-an-origin' WHERE attempt_id='active'")
    const rejectedInvalidState=rejected("UPDATE sa_attempt SET state='not-a-state' WHERE attempt_id='active'")
    const rejectedInvalidNumber=rejected("UPDATE sa_attempt SET n=4 WHERE attempt_id='active'")
    const rejectedEmptyReason=rejected("UPDATE sa_attempt SET reason='' WHERE attempt_id='active'")
    const customTriggerWorks=rejected("UPDATE sa_attempt SET reason='forbidden-fixture' WHERE attempt_id='active'")
    const uniqueIndexWorks=rejected("UPDATE sa_attempt SET session_id='session-old' WHERE attempt_id='active'")
    const endedTriggerWorks=rejected("UPDATE sa_attempt SET state='pending' WHERE attempt_id='old'")
    let originWriteError=null
    try{db.prepare("UPDATE sa_attempt SET cancel_origin=? WHERE attempt_id='active'").run(options.origin??'external')}catch(e){originWriteError=e.code??e.name}
    const writtenOrigin=db.prepare("SELECT cancel_origin FROM sa_attempt WHERE attempt_id='active'").get().cancel_origin
    db.exec("UPDATE sa_attempt SET cancel_origin=NULL WHERE attempt_id='active'")
    const ledger=createLedger(db,{now:()=>20}),unavailable=()=>{throw Error('FIXTURE_DISPATCH_FORBIDDEN')}
    const executors=createExecutors({ledger,controller:unavailable,world:{place:unavailable,registerWorkspace:unavailable},profiles:{get:unavailable},clock:{now:()=>20},log:{info(){},warn(){},error(){}},seatRoot:process.cwd()})
    let eventError=null
    try{executors.onSessionEvent('session-active',{type:'turn/end',seq:1,data:{turn:1,reason:{kind:'aborted'}}})}catch(e){eventError=e.code??e.name}
    const active=db.prepare("SELECT state,cancel_origin,turn_open FROM sa_attempt WHERE attempt_id='active'").get()
    return {migrationError,rowsPreserved,objectsPreserved,idempotent,rollbackUnchanged,rejectedInvalidOrigin,rejectedInvalidState,rejectedInvalidNumber,rejectedEmptyReason,customTriggerWorks,uniqueIndexWorks,endedTriggerWorks,originWriteError,writtenOrigin,eventError,active:{...active},commitmentState:db.prepare("SELECT state FROM sa_commitment WHERE commitment_id='C-1'").get().state,selfCheck:selfCheck(db).ok}
  } finally { db.close() }
}

export async function transportDenialProbe() { const {default:Transport}=await import(deniedTransport);try {new Transport();return {denied:false}} catch(error) {return {denied:error.message==='FIXTURE_NETWORK_FORBIDDEN'}} }
