"use strict"

// The minimal ledger (极简账本): a plain JSON map  path -> record  (detailed-design §5.1).
// This module is pure shape + (de)serialization. No locks, no IO orchestration —
// that lives in the pipeline. Corruption self-heals to an empty ledger (§5.1).

const LEDGER_VERSION = 1

const emptyLedger = () => ({ version: LEDGER_VERSION, records: {} })

// Parse text → ledger. Anything malformed (bad JSON, wrong shape) → empty ledger.
// This is the "delete & rebuild" self-heal: worst case we re-judge one round.
const parseLedger = (text) => {
  if (typeof text !== "string" || text.trim() === "") return emptyLedger()
  let data
  try {
    data = JSON.parse(text)
  } catch {
    return emptyLedger()
  }
  if (!data || typeof data !== "object" || typeof data.records !== "object" || data.records === null) {
    return emptyLedger()
  }
  return { version: LEDGER_VERSION, records: { ...data.records } }
}

const serializeLedger = (ledger) =>
  JSON.stringify({ version: LEDGER_VERSION, records: ledger.records || {} }, null, 2)

// Immutable upsert of a record (coding-style: never mutate input).
const withRecord = (ledger, key, record) => ({
  version: LEDGER_VERSION,
  records: { ...ledger.records, [key]: record },
})

const getRecord = (ledger, key) => (ledger.records ? ledger.records[key] : undefined)

// trackCodePath: ensure a code path is tracked, WITHOUT clobbering an existing
// reviewedHash (capture path, §七). First sighting → reviewedHash:null.
const trackCodePath = (ledger, key, meta = {}) => {
  if (getRecord(ledger, key)) return ledger // already tracked; capture never overwrites
  return withRecord(ledger, key, {
    kind: "code",
    reviewedHash: null,
    verdict: null,
    rationale: "",
    reviewedAt: null,
    by: null,
    ...meta,
  })
}

module.exports = {
  LEDGER_VERSION,
  emptyLedger,
  parseLedger,
  serializeLedger,
  withRecord,
  getRecord,
  trackCodePath,
}
