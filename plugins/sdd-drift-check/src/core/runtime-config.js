const outputMode = String(process.env.SDD_DRIFT_OUTPUT || "").toLowerCase()
const openCodeStopMode = String(process.env.SDD_DRIFT_OPENCODE_STOP_MODE || "").toLowerCase()

const config = {
  SHOW_WARNINGS: process.env.SDD_DRIFT_SHOW_WARNINGS === "1",
  STRICT_BLOCK: process.env.SDD_DRIFT_STRICT === "1",
  DEBUG: process.env.SDD_DRIFT_DEBUG === "1",
  OUTPUT_MODE: outputMode,
  OPENCODE_STOP_MODE: openCodeStopMode,
  OPENCODE_STOP_REPORT_ONLY:
    openCodeStopMode === "report-only" ||
    openCodeStopMode === "off" ||
    process.env.SDD_DRIFT_OPENCODE_STOP_INJECT === "0",
  STOP_MAX_BLOCKS: Number.parseInt(process.env.SDD_DRIFT_STOP_MAX_BLOCKS || "2", 10),
  CODE_REVIEW_STOP_MAX_BLOCKS: Number.parseInt(
    process.env.SDD_DRIFT_CODE_REVIEW_STOP_MAX_BLOCKS || "1",
    10
  ),
  CODE_REVIEW_TOOL_MAX_REMINDERS: Number.parseInt(
    process.env.SDD_DRIFT_CODE_REVIEW_TOOL_MAX_REMINDERS || "1",
    10
  ),
  CODE_REVIEW_TOOL_SESSION_MAX_REMINDERS: Number.parseInt(
    process.env.SDD_DRIFT_CODE_REVIEW_TOOL_SESSION_MAX_REMINDERS || "1",
    10
  ),
  DIAGNOSTIC_LOG: process.env.SDD_DRIFT_LOG !== "0",
  DIAGNOSTIC_LOG_MAX_BYTES: Number.parseInt(
    process.env.SDD_DRIFT_LOG_MAX_BYTES || String(2 * 1024 * 1024),
    10
  ),
  DIAGNOSTIC_LOG_RETENTION_DAYS: Number.parseFloat(
    process.env.SDD_DRIFT_LOG_RETENTION_DAYS || "3"
  ),
  DIAGNOSTIC_SUMMARY_WINDOW_MS: Number.parseInt(
    process.env.SDD_DRIFT_LOG_SUMMARY_WINDOW_MS || String(60 * 1000),
    10
  ),
  DTS_CONTEXT_SKIP: process.env.SDD_DRIFT_DTS_SKIP !== "0",
  DTS_CONTEXT_OVERRIDE: String(process.env.SDD_DRIFT_DTS_CONTEXT || "").toLowerCase(),
  TOOL_EVENT_CAP: 200,
  TRANSCRIPT_EVENT_CAP: Number.parseInt(
    process.env.SDD_DRIFT_TRANSCRIPT_EVENT_CAP || "2000",
    10
  ),
  CODE_REVIEW_CONFIRMATION_CAP: 50,
  DTS_CONTEXT_TEXT_MAX_BYTES: 512 * 1024,
  CHECKPOINT_OUTPUT_TEXT_MAX_BYTES: 64 * 1024,
  CHECKPOINT_MTIME_SCAN: process.env.SDD_DRIFT_CHECKPOINT_MTIME_SCAN !== "0",
  CHECKPOINT_MTIME_WINDOW_MS: Number.parseInt(
    process.env.SDD_DRIFT_CHECKPOINT_MTIME_WINDOW_MS || String(10 * 60 * 1000),
    10
  ),
  CHECKPOINT_MTIME_SCAN_MAX_FILES: Number.parseInt(
    process.env.SDD_DRIFT_CHECKPOINT_MTIME_SCAN_MAX_FILES || "50",
    10
  ),
  CHECKPOINT_MTIME_SCAN_MAX_VISITS: Number.parseInt(
    process.env.SDD_DRIFT_CHECKPOINT_MTIME_SCAN_MAX_VISITS || "2000",
    10
  ),
  DEFAULT_LOCK_STALE_MS: 5 * 60 * 1000,
  STATE_LOCK_STALE_MS: 30 * 1000,
  STATE_LOCK_WAIT_MS: 5 * 1000,
  STATE_LOCK_RETRY_MS: 20,
  STATE_RETENTION_MS: 7 * 24 * 60 * 60 * 1000,
  SESSION_FILES_MAX: Number.parseInt(process.env.SDD_DRIFT_SESSION_FILES_MAX || "1000", 10),
  STDIN_TIMEOUT_MS: Number.parseInt(process.env.SDD_DRIFT_STDIN_TIMEOUT_MS || "5000", 10),
  PROJECT_LOCK_WAIT_MS: 2 * 1000,
  PROJECT_LINKED_CODE_CAP: Number.parseInt(
    process.env.SDD_DRIFT_PROJECT_LINKED_CODE_CAP || "200",
    10
  ),
  CIRCUIT_MAX_FAILURES: Number.parseInt(
    process.env.SDD_DRIFT_CIRCUIT_MAX_FAILURES || "5",
    10
  ),
  CIRCUIT_COOLDOWN_MS: Number.parseInt(
    process.env.SDD_DRIFT_CIRCUIT_COOLDOWN_MS || String(60 * 1000),
    10
  ),
  ACTIVE_CHANGE_DIR_TTL_MS: Number.parseInt(
    process.env.SDD_DRIFT_ACTIVE_TTL_MS || String(7 * 24 * 60 * 60 * 1000),
    10
  ),
}

module.exports = config
