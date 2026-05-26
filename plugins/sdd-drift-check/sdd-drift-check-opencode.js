var __getOwnPropNames = Object.getOwnPropertyNames;
var __commonJS = (cb, mod) => function __require() {
  return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
};

// src/actions.js
var require_actions = __commonJS({
  "src/actions.js"(exports2, module2) {
    var ACTION_ORDER = ["log", "save_project", "save_session", "refresh_report", "emit_message"];
    var Actions = {
      log: (event) => ({ type: "log", event }),
      saveProject: () => ({ type: "save_project" }),
      saveSession: () => ({ type: "save_session" }),
      refreshReport: () => ({ type: "refresh_report" }),
      emitMessage: (payload) => ({ type: "emit_message", payload })
    };
    var runOneAction = async (action, ctx) => {
      if (!action || !action.type) return;
      switch (action.type) {
        case "log":
          await ctx.log?.(action.event);
          break;
        case "save_project":
          await ctx.saveProject?.();
          break;
        case "save_session":
          await ctx.saveSession?.();
          break;
        case "refresh_report":
          await ctx.refreshReport?.();
          break;
        case "emit_message":
          await ctx.emitMessage?.(action.payload);
          break;
        default:
          await ctx.unsupportedAction?.(action);
          break;
      }
    };
    var runActions = async (actions, ctx) => {
      const buckets = Object.fromEntries(ACTION_ORDER.map((type) => [type, []]));
      for (const action of actions || []) {
        if (!action || !buckets[action.type]) continue;
        buckets[action.type].push(action);
      }
      for (const type of ACTION_ORDER) {
        for (const action of buckets[type]) {
          await runOneAction(action, ctx);
        }
      }
    };
    module2.exports = {
      ACTION_ORDER,
      Actions,
      runActions
    };
  }
});

// src/handlers/pre-compact.js
var require_pre_compact = __commonJS({
  "src/handlers/pre-compact.js"(exports2, module2) {
    var handlePreCompact = (input, ctx) => {
      const { state, project } = ctx;
      if (project) ctx.applySessionToProject(ctx.cwd, project, state, ctx.sessionID);
      const summary = ctx.buildPreCompactSummary(ctx.cwd, state, project);
      ctx.persist();
      ctx.writeDiagnosticLog(ctx.cwd, {
        event: summary ? "precompact_summary_emit" : "precompact_no_pending",
        input: ctx.summarizeInput(input),
        messagePreview: summary ? ctx.limitString(summary, 800) : null
      });
      if (summary) ctx.writeStdout(ctx.buildClaudeCodeOutput("PreCompact", summary));
    };
    module2.exports = { handlePreCompact };
  }
});

// src/handlers/pre-tool-use.js
var require_pre_tool_use = __commonJS({
  "src/handlers/pre-tool-use.js"(exports2, module2) {
    var handlePreToolUse = (input, ctx) => {
      const tool = String(input.tool_name || "").toLowerCase();
      const toolInput = input.tool_input || {};
      const fp = ctx.getToolFilePath(toolInput);
      if (fp && typeof fp === "string") {
        ctx.persistAndReport();
        ctx.writeDiagnosticLog(ctx.cwd, {
          event: "ignored_pretooluse_file_path",
          input: ctx.summarizeInput(input),
          tool,
          file: fp
        });
        return;
      }
      const questionCheckpoint = ctx.isQuestionCheckpointTool(tool);
      if (questionCheckpoint && !ctx.markToolEvent(ctx.state, ctx.getToolEventKey(input))) {
        ctx.persistAndReport();
        ctx.writeDiagnosticLog(ctx.cwd, {
          event: "ignored_duplicate_checkpoint_event",
          input: ctx.summarizeInput(input),
          tool,
          subagentCheckpoint: false,
          questionCheckpoint
        });
        return;
      }
      const pending = questionCheckpoint ? ctx.buildQuestionCheckpointEnforcement(ctx.cwd, ctx.state, ctx.project) : null;
      ctx.clearSubagentCheckpointNoticeIfResolved(ctx.state, pending);
      if (pending && ctx.shouldEmitSubagentCheckpointNotice(ctx.state, pending)) {
        ctx.markSubagentCheckpointNoticeEmitted(ctx.state, pending, tool);
        ctx.persistAndReport();
        ctx.writeDiagnosticLog(ctx.cwd, {
          event: "emit_question_checkpoint_enforcement",
          input: ctx.summarizeInput(input),
          tool,
          subagentCheckpoint: false,
          questionCheckpoint,
          hydratedFromCheckpointOutput: false,
          pendingType: pending.type,
          pendingSignature: pending.signature,
          messagePreview: ctx.limitString(pending.message, 800)
        });
        ctx.emitEnforcement(input, pending.message);
        return;
      }
      ctx.persistAndReport();
      ctx.writeDiagnosticLog(ctx.cwd, {
        event: "ignored_no_file_path",
        input: ctx.summarizeInput(input),
        tool,
        subagentCheckpoint: false,
        questionCheckpoint,
        hydratedFromCheckpointOutput: false,
        pendingCheckpoint: Boolean(pending)
      });
    };
    module2.exports = { handlePreToolUse };
  }
});

// src/handlers/post-tool-use-checkpoint.js
var require_post_tool_use_checkpoint = __commonJS({
  "src/handlers/post-tool-use-checkpoint.js"(exports2, module2) {
    var handlePostToolUseCheckpoint = (input, ctx, details) => {
      const { tool, toolInput } = details;
      const { cwd, state, project } = ctx;
      const subagentCheckpoint = ctx.isSubagentCheckpointTool(tool, toolInput);
      const questionCheckpoint = ctx.isQuestionCheckpointTool(tool);
      const checkpoint = subagentCheckpoint || questionCheckpoint;
      if (checkpoint && !ctx.markToolEvent(state, ctx.getToolEventKey(input))) {
        ctx.persistAndReport();
        ctx.writeDiagnosticLog(cwd, {
          event: "ignored_duplicate_checkpoint_event",
          input: ctx.summarizeInput(input),
          tool,
          subagentCheckpoint,
          questionCheckpoint
        });
        return;
      }
      const hydratedFromCheckpointOutput = subagentCheckpoint ? ctx.hydrateStateFromCheckpointOutput(cwd, state, input) : false;
      if (project) ctx.applySessionToProject(cwd, project, state, ctx.sessionID);
      const pending = subagentCheckpoint ? ctx.buildSubagentCheckpointEnforcement(cwd, state, project) : questionCheckpoint ? ctx.buildQuestionCheckpointEnforcement(cwd, state, project) : null;
      ctx.clearSubagentCheckpointNoticeIfResolved(state, pending);
      if (pending && ctx.shouldEmitSubagentCheckpointNotice(state, pending)) {
        ctx.markSubagentCheckpointNoticeEmitted(state, pending, tool);
        ctx.persistAndReport();
        ctx.writeDiagnosticLog(cwd, {
          event: questionCheckpoint ? "emit_question_checkpoint_enforcement" : "emit_subagent_checkpoint_enforcement",
          input: ctx.summarizeInput(input),
          tool,
          subagentCheckpoint,
          questionCheckpoint,
          hydratedFromCheckpointOutput,
          pendingType: pending.type,
          pendingSignature: pending.signature,
          messagePreview: ctx.limitString(pending.message, 800)
        });
        ctx.emitEnforcement(input, pending.message);
        return;
      }
      const carryOverFallback = state.noEditSession && !ctx.isDtsContextActive(state) && ctx.shouldEmitCarryOverNotice(state, project) ? ctx.formatCarryOverReminder(project, { prefix: "[Carry-over] " }) : "";
      if (carryOverFallback) {
        if (!state.firstEventAt) state.firstEventAt = (/* @__PURE__ */ new Date()).toISOString();
        ctx.markCarryOverNoticeEmitted(state, project, "PostToolUse");
        ctx.persistAndReport();
        ctx.writeDiagnosticLog(cwd, {
          event: "emit_carry_over_fallback",
          input: ctx.summarizeInput(input),
          tool,
          subagentCheckpoint,
          questionCheckpoint,
          hydratedFromCheckpointOutput,
          messagePreview: ctx.limitString(carryOverFallback, 800)
        });
        ctx.emitEnforcement(input, carryOverFallback);
        return;
      }
      ctx.persistAndReport();
      ctx.writeDiagnosticLog(cwd, {
        event: "ignored_no_file_path",
        input: ctx.summarizeInput(input),
        tool,
        subagentCheckpoint,
        questionCheckpoint,
        hydratedFromCheckpointOutput,
        pendingCheckpoint: Boolean(pending)
      });
    };
    module2.exports = { handlePostToolUseCheckpoint };
  }
});

// src/handlers/post-tool-use.js
var require_post_tool_use = __commonJS({
  "src/handlers/post-tool-use.js"(exports2, module2) {
    var { handlePostToolUseCheckpoint } = require_post_tool_use_checkpoint();
    var handlePostToolUse = (input, ctx) => {
      const { cwd, state, project } = ctx;
      const tool = String(input.tool_name || "").toLowerCase();
      const toolInput = input.tool_input || {};
      const fp = ctx.getToolFilePath(toolInput);
      if (!fp || typeof fp !== "string") {
        handlePostToolUseCheckpoint(input, ctx, { tool, toolInput });
        return;
      }
      const abs = ctx.resolveFile(cwd, fp);
      const isEdit = tool === "edit" || tool === "write" || tool === "multiedit";
      if (!ctx.markToolEvent(state, ctx.getToolEventKey(input))) {
        ctx.persistAndReport();
        ctx.writeDiagnosticLog(cwd, {
          event: "ignored_duplicate_tool_event",
          input: ctx.summarizeInput(input),
          file: ctx.rel(cwd, abs)
        });
        return;
      }
      if (!ctx.applyToolRecord(cwd, state, tool, toolInput)) {
        ctx.persistAndReport();
        ctx.writeDiagnosticLog(cwd, {
          event: "ignored_unsupported_tool_record",
          input: ctx.summarizeInput(input),
          file: ctx.rel(cwd, abs)
        });
        return;
      }
      if (project) ctx.applySessionToProject(cwd, project, state, ctx.sessionID);
      const codeToolReminderEnabled = ctx.codeReviewToolMaxReminders() > 0 && ctx.codeReviewToolSessionMaxReminders() > 0 && ctx.codeDriftToolSessionEmissionCount(state) < ctx.codeReviewToolSessionMaxReminders();
      const attributionReviewPrompts = codeToolReminderEnabled ? ctx.takeAttributionReviewPrompts(state) : [];
      const warnings = isEdit ? ctx.drift(cwd, abs, state) : [];
      const peerGaps = ctx.collectCombinedPeerGaps(cwd, state, project);
      const hardPeerGaps = ctx.collectCombinedPeerGaps(cwd, state, project, { includeStageOnly: false });
      const stagePeerGaps = ctx.collectCombinedPeerGaps(cwd, state, project, { includeHard: false });
      let codeGaps = ctx.collectCombinedCodeGaps(cwd, state, project);
      const codeReviewNoEditConfirmed = !hardPeerGaps.length && ctx.markCodeReviewNoEditConfirmation(state, codeGaps);
      if (codeReviewNoEditConfirmed) {
        codeGaps = ctx.collectCombinedCodeGaps(cwd, state, project);
      }
      const noticePeerGaps = hardPeerGaps.length ? hardPeerGaps : stagePeerGaps;
      ctx.clearPeerDriftNoticeIfResolved(state, noticePeerGaps);
      ctx.clearCodeDriftNoticeIfResolved(state, codeGaps);
      ctx.clearSubagentCheckpointNoticeIfResolved(
        state,
        ctx.buildSubagentCheckpointEnforcement(cwd, state, project)
      );
      const emitAttributionReview = attributionReviewPrompts.length > 0;
      const emitCodeGap = !hardPeerGaps.length && codeToolReminderEnabled && (emitAttributionReview || ctx.shouldEmitCodeDriftNotice(state, codeGaps));
      const suppressCodeGap = !hardPeerGaps.length && !emitCodeGap && ctx.isCodeDriftNoticeSuppressed(state, codeGaps);
      const deferredCodeGap = !hardPeerGaps.length && !emitCodeGap && codeGaps.some((gap) => !gap.reviewReady) && !codeToolReminderEnabled;
      const emitStagePeerGap = !hardPeerGaps.length && !emitCodeGap && stagePeerGaps.length > 0;
      const emitPeerGaps = hardPeerGaps.length ? hardPeerGaps : emitStagePeerGap ? stagePeerGaps : [];
      const peerSignature = emitPeerGaps.length ? ctx.peerDriftSignature(emitPeerGaps) : null;
      const compactPeerGap = emitPeerGaps.length > 0 && Boolean(state.peerDriftNotice?.active) && state.peerDriftNotice.signature === peerSignature;
      const compactCodeGap = emitCodeGap && Boolean(state.codeDriftNotice?.active);
      const carryOverFallback = !emitPeerGaps.length && !emitCodeGap && state.noEditSession && !ctx.isDtsContextActive(state) && ctx.shouldEmitCarryOverNotice(state, project) ? ctx.formatCarryOverReminder(project, { prefix: "[Carry-over] " }) : "";
      if (emitPeerGaps.length) {
        ctx.markPeerDriftNoticeEmitted(state, emitPeerGaps);
      }
      if (emitCodeGap) {
        ctx.markCodeDriftNoticeEmitted(cwd, state, codeGaps);
      }
      if (carryOverFallback) {
        if (!state.firstEventAt) state.firstEventAt = (/* @__PURE__ */ new Date()).toISOString();
        ctx.markCarryOverNoticeEmitted(state, project, "PostToolUse");
      }
      ctx.persistAndReport();
      if (emitPeerGaps.length) {
        ctx.writeDiagnosticLog(cwd, {
          event: emitPeerGaps.every((gap) => gap.stageOnly) ? "emit_peer_stage_reminder" : "emit_peer_enforcement",
          input: ctx.summarizeInput(input),
          file: ctx.rel(cwd, abs),
          tool,
          isEdit,
          ...ctx.summarizeGaps(cwd, peerGaps, codeGaps)
        });
        ctx.emitEnforcement(input, ctx.buildToolEnforcement(emitPeerGaps, { compact: compactPeerGap }));
      } else if (emitCodeGap) {
        ctx.writeDiagnosticLog(cwd, {
          event: emitAttributionReview ? "emit_attribution_review" : compactCodeGap ? "emit_code_reminder_compact" : "emit_code_tool_reminder",
          input: ctx.summarizeInput(input),
          file: ctx.rel(cwd, abs),
          tool,
          isEdit,
          attributionReviewSignatures: attributionReviewPrompts.map((item) => item.signature),
          ...ctx.summarizeGaps(cwd, peerGaps, codeGaps)
        });
        ctx.emitEnforcement(
          input,
          [
            ...attributionReviewPrompts.map((item) => item.prompt),
            ctx.buildCodeToolReminder(cwd, codeGaps, { compact: compactCodeGap })
          ].filter(Boolean).join("\n\n")
        );
      } else if (ctx.SHOW_WARNINGS && warnings.length) {
        ctx.writeDiagnosticLog(cwd, {
          event: "emit_warning",
          input: ctx.summarizeInput(input),
          file: ctx.rel(cwd, abs),
          tool,
          warnings,
          ...ctx.summarizeGaps(cwd, peerGaps, codeGaps)
        });
        ctx.emitEnforcement(input, warnings.join("\n"));
      } else if (carryOverFallback) {
        ctx.writeDiagnosticLog(cwd, {
          event: "emit_carry_over_fallback",
          input: ctx.summarizeInput(input),
          file: ctx.rel(cwd, abs),
          tool,
          isEdit,
          messagePreview: ctx.limitString(carryOverFallback, 800),
          ...ctx.summarizeGaps(cwd, peerGaps, codeGaps)
        });
        ctx.emitEnforcement(input, carryOverFallback);
      } else {
        ctx.writeDiagnosticLog(cwd, {
          event: codeReviewNoEditConfirmed ? "posttooluse_code_review_no_edit_confirmed" : deferredCodeGap ? "posttooluse_code_review_deferred_to_checkpoint" : suppressCodeGap ? "posttooluse_code_review_reminder_suppressed" : "posttooluse_no_output",
          input: ctx.summarizeInput(input),
          file: ctx.rel(cwd, abs),
          tool,
          isEdit,
          ...suppressCodeGap ? {
            codeReviewToolReminderCount: ctx.codeDriftNoticeEmissionCount(state),
            codeReviewToolMaxReminders: ctx.codeReviewToolMaxReminders()
          } : {},
          ...deferredCodeGap ? {
            codeReviewToolMaxReminders: ctx.codeReviewToolMaxReminders()
          } : {},
          ...ctx.summarizeGaps(cwd, peerGaps, codeGaps)
        });
      }
    };
    module2.exports = { handlePostToolUse };
  }
});

// src/handlers/stop.js
var require_stop = __commonJS({
  "src/handlers/stop.js"(exports2, module2) {
    var handleStop = (input, ctx) => {
      const { cwd, state, project } = ctx;
      const transcriptPath = ctx.transcriptPathForContext;
      const hydrated = ctx.hydrateStateFromTranscript(cwd, state, transcriptPath);
      if (project) ctx.applySessionToProject(cwd, project, state, ctx.sessionID);
      let pending = ctx.buildPendingEnforcement(cwd, state, { includeStageOnly: false, project });
      if (ctx.markImplementationFlowConfirmation(cwd, state, pending, project)) {
        ctx.refreshAlignedBaseline(cwd, project, state);
        pending = ctx.buildPendingEnforcement(cwd, state, { includeStageOnly: false, project });
      }
      if (!pending) {
        const attributionReadOnlyResolved = ctx.resolveReadOnlyAttributionReviews(state);
        state.stopBlocks = {};
        ctx.clearPeerSyncs(state);
        ctx.clearStageOnlyRequirements(state);
        ctx.refreshAlignedBaseline(cwd, project, state);
        ctx.persistAndReport();
        ctx.writeDiagnosticLog(cwd, {
          event: "stop_allow_no_pending",
          input: ctx.summarizeInput(input),
          transcriptPath: transcriptPath ? ctx.limitString(transcriptPath) : null,
          hydrated,
          attributionReadOnlyResolved
        });
        return;
      }
      const reviewConfirmationReady = pending.type === "code" && (pending.gaps || []).length > 0 && (pending.gaps || []).every((gap) => gap.needsConfirmation && gap.reviewReady);
      if (ctx.markStopCodeReviewConfirmation(state, pending)) {
        const attributionReadOnlyResolved = ctx.resolveReadOnlyAttributionReviews(state);
        state.stopBlocks = {};
        ctx.clearPeerSyncs(state);
        ctx.refreshAlignedBaseline(cwd, project, state);
        ctx.persistAndReport();
        ctx.writeDiagnosticLog(cwd, {
          event: "stop_allow_review_confirmed",
          input: ctx.summarizeInput(input),
          pendingType: pending.type,
          pendingSignature: pending.signature,
          transcriptPath: transcriptPath ? ctx.limitString(transcriptPath) : null,
          hydrated,
          attributionReadOnlyResolved
        });
        return;
      }
      ctx.refreshReport(cwd, state, project);
      if (ctx.isOpenCodeHookInput(input) && ctx.OPENCODE_STOP_REPORT_ONLY) {
        ctx.persistAndReport();
        ctx.writeDiagnosticLog(cwd, {
          event: "stop_opencode_report_only",
          input: ctx.summarizeInput(input),
          pendingType: pending.type,
          pendingSignature: pending.signature,
          transcriptPath: transcriptPath ? ctx.limitString(transcriptPath) : null,
          hydrated,
          messagePreview: ctx.limitString(pending.message, 800)
        });
        return;
      }
      const configuredMaxBlocks = pending.type === "code" ? ctx.CODE_REVIEW_STOP_MAX_BLOCKS : ctx.STOP_MAX_BLOCKS;
      const maxBlocks = Number.isFinite(configuredMaxBlocks) ? Math.max(0, configuredMaxBlocks) : pending.type === "code" ? 1 : 2;
      const blockCount = state.stopBlocks[pending.signature] || 0;
      if (blockCount >= maxBlocks) {
        const attributionUnrelatedAccepted = ctx.acceptUnresolvedAttributionReviews(state);
        ctx.persist();
        if (attributionUnrelatedAccepted) {
          ctx.writeDiagnosticLog(cwd, {
            event: "attribution_unrelated_accepted",
            input: ctx.summarizeInput(input),
            pendingType: pending.type,
            pendingSignature: pending.signature,
            blockCount,
            maxBlocks
          });
        }
        ctx.writeDiagnosticLog(cwd, {
          event: "stop_allow_max_blocks",
          input: ctx.summarizeInput(input),
          pendingType: pending.type,
          pendingSignature: pending.signature,
          blockCount,
          maxBlocks,
          attributionUnrelatedAccepted
        });
        return;
      }
      state.stopBlocks[pending.signature] = blockCount + 1;
      ctx.persist();
      ctx.writeDiagnosticLog(cwd, {
        event: reviewConfirmationReady ? "stop_review_confirmation_requested" : "stop_block_emit",
        input: ctx.summarizeInput(input),
        pendingType: pending.type,
        pendingSignature: pending.signature,
        blockCount: blockCount + 1,
        maxBlocks,
        messagePreview: ctx.limitString(pending.message, 800)
      });
      ctx.emitStopEnforcement(input, ctx.buildStopEnforcement(pending.message));
    };
    module2.exports = { handleStop };
  }
});

// src/handlers/user-prompt-submit.js
var require_user_prompt_submit = __commonJS({
  "src/handlers/user-prompt-submit.js"(exports2, module2) {
    var handleUserPromptSubmit = (input, ctx) => {
      const { state, project } = ctx;
      const isFirstEvent = !state.firstEventAt;
      if (isFirstEvent) state.firstEventAt = (/* @__PURE__ */ new Date()).toISOString();
      if (project) ctx.applySessionToProject(ctx.cwd, project, state, ctx.sessionID);
      const reminder = isFirstEvent && !ctx.isDtsContextActive(state) && ctx.shouldEmitCarryOverNotice(state, project) ? ctx.formatCarryOverReminder(project) : "";
      if (reminder) ctx.markCarryOverNoticeEmitted(state, project, input.hook_event_name);
      ctx.persist();
      ctx.writeDiagnosticLog(ctx.cwd, {
        event: reminder ? "carry_over_emitted" : "user_prompt_context_captured",
        input: ctx.summarizeInput(input),
        firstEvent: isFirstEvent,
        messagePreview: reminder ? ctx.limitString(reminder, 800) : null
      });
      if (reminder && input.hook_event_name === "UserPromptSubmit") {
        ctx.writeStdout(ctx.buildClaudeCodeOutput("UserPromptSubmit", reminder));
      }
    };
    module2.exports = { handleUserPromptSubmit };
  }
});

// src/dispatcher.js
var require_dispatcher = __commonJS({
  "src/dispatcher.js"(exports2, module2) {
    var { handlePreCompact } = require_pre_compact();
    var { handlePreToolUse } = require_pre_tool_use();
    var { handlePostToolUse } = require_post_tool_use();
    var { handleStop } = require_stop();
    var { handleUserPromptSubmit } = require_user_prompt_submit();
    var makeHandlerSpec = (requiresSession, requiresProject, lockPolicy, handle) => ({
      requiresSession,
      requiresProject,
      lockPolicy,
      handle
    });
    var createHookHandlers = (handlers = {}) => ({
      PreToolUse: makeHandlerSpec(
        "write",
        "read",
        { sessionWait: 1e3, projectWait: 500 },
        handlers.PreToolUse
      ),
      PostToolUse: makeHandlerSpec(
        "write",
        "write",
        { sessionWait: 5e3, projectWait: 2e3 },
        handlers.PostToolUse
      ),
      Stop: makeHandlerSpec(
        "write",
        "write",
        { sessionWait: 5e3, projectWait: 2e3 },
        handlers.Stop
      ),
      UserPromptSubmit: makeHandlerSpec(
        "write",
        "read",
        { sessionWait: 1e3, projectWait: 500 },
        handlers.UserPromptSubmit
      ),
      PreCompact: makeHandlerSpec(
        "read",
        "read",
        { sessionWait: 500, projectWait: 500 },
        handlers.PreCompact
      )
    });
    var HookHandlers = createHookHandlers({
      PreCompact: handlePreCompact,
      PostToolUse: handlePostToolUse,
      PreToolUse: handlePreToolUse,
      Stop: handleStop,
      UserPromptSubmit: handleUserPromptSubmit
    });
    module2.exports = {
      HookHandlers,
      createHookHandlers
    };
  }
});

// src/stdin.js
var require_stdin = __commonJS({
  "src/stdin.js"(exports2, module2) {
    var readStdin = (timeoutMs) => new Promise((resolve, reject) => {
      let data = "";
      let settled = false;
      let timer = null;
      const finish = () => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        resolve(data);
      };
      const fail = (err) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        reject(err);
      };
      if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
        timer = setTimeout(finish, timeoutMs);
      }
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", (chunk) => {
        data += chunk;
      });
      process.stdin.on("end", finish);
      process.stdin.on("error", fail);
      if (process.stdin.isTTY) finish();
    });
    module2.exports = { readStdin };
  }
});

// src/core/tool-events.js
var require_tool_events = __commonJS({
  "src/core/tool-events.js"(exports2, module2) {
    var FILE_TOOL_NAMES = /* @__PURE__ */ new Set(["read", "edit", "write", "multiedit"]);
    var SUBAGENT_CHECKPOINT_TOOL_NAMES = /* @__PURE__ */ new Set([
      "background_output",
      "delegate_task",
      "task"
    ]);
    var QUESTION_CHECKPOINT_TOOL_NAMES2 = /* @__PURE__ */ new Set([
      "ask_user",
      "ask_user_question",
      "askuser",
      "askuserquestion",
      "confirm",
      "confirmation",
      "question"
    ]);
    var getToolFilePath = (args) => args?.file_path || args?.filePath || args?.path || args?.file;
    var normalizeToolName2 = (tool) => {
      const name = String(tool || "").trim().toLowerCase().replace(/[-\s.]+/g, "_");
      if (name === "multi_edit" || name === "multi-edit") return "multiedit";
      return name;
    };
    var isSubagentCheckpointTool = (tool) => {
      const normalized = normalizeToolName2(tool);
      if (normalized === "background_task") return false;
      return SUBAGENT_CHECKPOINT_TOOL_NAMES.has(normalized);
    };
    var isQuestionCheckpointTool = (tool) => QUESTION_CHECKPOINT_TOOL_NAMES2.has(normalizeToolName2(tool));
    var isSupportedOpenCodeToolEvent2 = (tool, args) => {
      const normalized = normalizeToolName2(tool);
      if (FILE_TOOL_NAMES.has(normalized) && getToolFilePath(args || {})) return true;
      if (normalized === "background_task") return false;
      if (isQuestionCheckpointTool(normalized)) return true;
      return isSubagentCheckpointTool(normalized);
    };
    var normalizeToolArgs2 = (args) => {
      const copy = { ...args || {} };
      const fp = getToolFilePath(copy);
      if (fp && !copy.file_path) copy.file_path = fp;
      return copy;
    };
    module2.exports = {
      FILE_TOOL_NAMES,
      SUBAGENT_CHECKPOINT_TOOL_NAMES,
      QUESTION_CHECKPOINT_TOOL_NAMES: QUESTION_CHECKPOINT_TOOL_NAMES2,
      getToolFilePath,
      isQuestionCheckpointTool,
      isSubagentCheckpointTool,
      isSupportedOpenCodeToolEvent: isSupportedOpenCodeToolEvent2,
      normalizeToolArgs: normalizeToolArgs2,
      normalizeToolName: normalizeToolName2
    };
  }
});

// src/core/paths.js
var require_paths = __commonJS({
  "src/core/paths.js"(exports2, module2) {
    var path2 = require("path");
    var toPosix = (fp) => String(fp || "").replace(/\\/g, "/");
    var isCaseInsensitiveFs = () => process.platform === "win32" || process.platform === "darwin";
    var normalizeKey = (fp) => {
      const normalized = toPosix(path2.resolve(fp));
      return isCaseInsensitiveFs() ? normalized.toLowerCase() : normalized;
    };
    var samePath = (left, right) => normalizeKey(left) === normalizeKey(right);
    var rel = (cwd, fp) => toPosix(path2.relative(cwd, fp));
    var resolveFile = (cwd, fp) => path2.isAbsolute(fp) ? path2.normalize(fp) : path2.resolve(cwd, fp);
    module2.exports = {
      isCaseInsensitiveFs,
      normalizeKey,
      rel,
      resolveFile,
      samePath,
      toPosix
    };
  }
});

// src/core/file-classifier.js
var require_file_classifier = __commonJS({
  "src/core/file-classifier.js"(exports2, module2) {
    var path2 = require("path");
    var { toPosix } = require_paths();
    var CODE_EXT = /\.(ts|tsx|js|jsx|mjs|cjs|html|css|vue|svelte|py|go|rs|java|kt|swift|cc|cpp|c|h|hpp|rb|php|cs|scss|sql)$/i;
    var isSddPath = (fp) => {
      const normalized = toPosix(path2.resolve(fp));
      return normalized.includes("/sdd/") || normalized.includes("/.sdd/");
    };
    var isSddChangePath = (fp) => {
      const normalized = toPosix(path2.resolve(fp));
      return normalized.includes("/sdd/changes/") || normalized.includes("/.sdd/changes/");
    };
    var isCodePath = (fp) => CODE_EXT.test(fp) && !isSddPath(fp);
    module2.exports = {
      CODE_EXT,
      isCodePath,
      isSddChangePath,
      isSddPath
    };
  }
});

// src/core/runtime-config.js
var require_runtime_config = __commonJS({
  "src/core/runtime-config.js"(exports2, module2) {
    var outputMode = String(process.env.SDD_DRIFT_OUTPUT || "").toLowerCase();
    var openCodeStopMode = String(process.env.SDD_DRIFT_OPENCODE_STOP_MODE || "").toLowerCase();
    var config = {
      SHOW_WARNINGS: process.env.SDD_DRIFT_SHOW_WARNINGS === "1",
      STRICT_BLOCK: process.env.SDD_DRIFT_STRICT === "1",
      DEBUG: process.env.SDD_DRIFT_DEBUG === "1",
      OUTPUT_MODE: outputMode,
      OPENCODE_STOP_MODE: openCodeStopMode,
      OPENCODE_STOP_REPORT_ONLY: openCodeStopMode === "report-only" || openCodeStopMode === "off" || process.env.SDD_DRIFT_OPENCODE_STOP_INJECT === "0",
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
        process.env.SDD_DRIFT_LOG_SUMMARY_WINDOW_MS || String(60 * 1e3),
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
        process.env.SDD_DRIFT_CHECKPOINT_MTIME_WINDOW_MS || String(10 * 60 * 1e3),
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
      DEFAULT_LOCK_STALE_MS: 5 * 60 * 1e3,
      STATE_LOCK_STALE_MS: 30 * 1e3,
      STATE_LOCK_WAIT_MS: 5 * 1e3,
      STATE_LOCK_RETRY_MS: 20,
      STATE_RETENTION_MS: 7 * 24 * 60 * 60 * 1e3,
      SESSION_FILES_MAX: Number.parseInt(process.env.SDD_DRIFT_SESSION_FILES_MAX || "1000", 10),
      STDIN_TIMEOUT_MS: Number.parseInt(process.env.SDD_DRIFT_STDIN_TIMEOUT_MS || "5000", 10),
      PROJECT_LOCK_WAIT_MS: 2 * 1e3,
      PROJECT_LINKED_CODE_CAP: Number.parseInt(
        process.env.SDD_DRIFT_PROJECT_LINKED_CODE_CAP || "200",
        10
      ),
      CIRCUIT_MAX_FAILURES: Number.parseInt(
        process.env.SDD_DRIFT_CIRCUIT_MAX_FAILURES || "5",
        10
      ),
      CIRCUIT_COOLDOWN_MS: Number.parseInt(
        process.env.SDD_DRIFT_CIRCUIT_COOLDOWN_MS || String(60 * 1e3),
        10
      ),
      ACTIVE_CHANGE_DIR_TTL_MS: Number.parseInt(
        process.env.SDD_DRIFT_ACTIVE_TTL_MS || String(7 * 24 * 60 * 60 * 1e3),
        10
      )
    };
    module2.exports = config;
  }
});

// src/core/sdd-rules.js
var require_sdd_rules = __commonJS({
  "src/core/sdd-rules.js"(exports2, module2) {
    var fs = require("fs");
    var path2 = require("path");
    var { toPosix } = require_paths();
    var STATE_DIR = ".sdd-drift-hook-state";
    var PROMPT_RULES_FILE = "sdd-drift-check-rules.md";
    var PEER_FILES = ["design.md", "tasks.md"];
    var PROPOSAL_FILE = "proposal.md";
    var DESIGN_FILE = "design.md";
    var TASKS_FILE = "tasks.md";
    var REVIEW_FILES = [DESIGN_FILE, TASKS_FILE];
    var ARCHIVED_CHANGE_DIR_NAMES = /* @__PURE__ */ new Set(["archive", "archives", "archived", ".archive", ".archived", "\u5DF2\u5F52\u6863"]);
    var ARCHIVE_MARKER_FILES = [".archived", ".archive", "ARCHIVED", "archived.md", "archive.md", "\u5DF2\u5F52\u6863.md"];
    var ARCHIVE_STATUS_FILES = ["status.md", "state.md", "metadata.md", ".status"];
    var CHANGE_DOC_REQUIREMENTS = {
      [PROPOSAL_FILE]: [DESIGN_FILE],
      [DESIGN_FILE]: [TASKS_FILE],
      [TASKS_FILE]: [DESIGN_FILE]
    };
    var DOCUMENT_SYNC_RULES = [
      "\u7F16\u8F91\u4EFB\u4F55 SDD \u6587\u6863\u524D\uFF0C\u5148\u8BFB\u53D6\u5F53\u524D\u6587\u4EF6\uFF0C\u5E76\u4FDD\u7559\u5B83\u5DF2\u6709\u7684 Markdown \u6A21\u677F\u3002",
      "\u4FDD\u6301\u6240\u6709\u5DF2\u6709\u6807\u9898\u884C\u4E0D\u53D8\uFF0C\u5305\u62EC # Design\u3001# Tasks \u8FD9\u7C7B\u9876\u5C42\u6807\u9898\uFF0C\u5E76\u4FDD\u6301\u539F\u6709\u6807\u9898\u987A\u5E8F\u3002",
      "\u4E0D\u8981\u628A\u6574\u7BC7\u6587\u6863\u66FF\u6362\u6210\u6458\u8981\u3001\u6807\u8BB0\u6216\u5355\u884C\u7ED3\u679C\u3002",
      "\u4E0D\u8981\u65B0\u589E\u7AE0\u8282\u3002",
      "\u4E0D\u8981\u91CD\u5199\u6587\u6863\u6A21\u677F\u3002",
      "\u627E\u5230\u6700\u5E94\u8BE5\u53D8\u66F4\u7684\u5DF2\u6709\u7AE0\u8282\uFF0C\u53EA\u4FEE\u6539\u8BE5\u4F4D\u7F6E\u3002",
      "\u4E0D\u8981\u4E3A\u4E86\u6EE1\u8DB3\u63D2\u4EF6\u63D0\u9192\u800C\u65B0\u589E\u7AE0\u8282\u6216\u91CD\u5199\u6A21\u677F\u3002",
      "\u540C\u6B65 drift \u65F6\uFF0C\u4E0D\u8981\u5220\u9664\u65E0\u5173\u7684\u5DF2\u6709\u6BB5\u843D\u3001\u6E05\u5355\u9879\u3001\u793A\u4F8B\u3001\u9700\u6C42\u6216\u5907\u6CE8\u3002",
      "\u5BF9\u5DF2\u6709 SDD \u6587\u6863\uFF0C\u4F18\u5148\u4F7F\u7528 Edit \u6216 MultiEdit\u3002\u5982\u679C\u5FC5\u987B\u4F7F\u7528 Write\uFF0C\u5148\u590D\u5236\u539F\u6587\u4EF6\u5185\u5BB9\uFF0C\u518D\u5199\u56DE\u5305\u542B\u5168\u90E8\u5DF2\u6709\u6807\u9898\u3001\u6A21\u677F\u6587\u672C\u3001\u6BB5\u843D\u548C\u6E05\u5355\u9879\u7684\u5B8C\u6574\u6587\u6863\u3002",
      "\u4E0D\u8981\u5728\u540C\u4E00\u6279\u5E76\u884C\u5DE5\u5177\u8C03\u7528\u91CC\u540C\u65F6\u7F16\u8F91 design.md \u548C tasks.md\uFF1B\u5148\u66F4\u65B0\u4E00\u4E2A SDD \u6587\u6863\uFF0C\u7B49\u5F85\u5DE5\u5177\u7ED3\u679C\u548C hook \u53CD\u9988\uFF0C\u518D\u66F4\u65B0\u9700\u8981\u540C\u6B65\u7684 peer \u6587\u6863\u3002",
      "\u627E\u5230\u6700\u5408\u9002\u7684\u5DF2\u6709\u6807\u9898\u3001\u6BB5\u843D\u3001\u5217\u8868\u9879\u6216\u4EFB\u52A1\u9879\uFF0C\u5728\u90A3\u91CC\u505A\u6700\u5C0F\u5FC5\u8981\u4FEE\u6539\u3002",
      "\u5BF9 tasks.md\uFF0C\u4FDD\u7559\u4EFB\u52A1\u6E05\u5355\u683C\u5F0F\uFF1B\u80FD\u66F4\u65B0\u76F8\u5173\u5DF2\u6709\u6E05\u5355\u9879\u65F6\uFF0C\u4F18\u5148\u66F4\u65B0\u5DF2\u6709\u9879\u3002"
    ];
    var ACTIVE_SDD_ALIGNMENT_RULES = [
      "\u53D8\u66F4\u76EE\u5F55\u5F52\u6863\u524D\uFF0C\u6D3B\u8DC3 SDD \u6587\u6863\u90FD\u662F\u5B9E\u65F6\u8BA1\u5212\u8BB0\u5F55\uFF1B\u6700\u7EC8\u56DE\u590D\u524D\uFF0C\u8981\u8BA9\u6D3B\u8DC3\u7684 design.md \u548C tasks.md \u4E0E\u5DF2\u5B9E\u73B0\u4EE3\u7801\u4FDD\u6301\u4E00\u81F4\u3002",
      "\u5982\u679C\u4F18\u5316\u6216\u91CD\u6784\u6539\u53D8\u4E86\u884C\u4E3A\u3001API \u6216\u5951\u7EA6\u3001\u7B97\u6CD5\u3001\u72B6\u6001\u6216\u6570\u636E\u6D41\u3001\u6570\u636E\u7ED3\u6784\u3001\u6027\u80FD\u7B56\u7565\u3001\u9519\u8BEF\u5904\u7406\u3001\u5B89\u5168\u8FB9\u754C\u3001\u7528\u6237\u53EF\u89C1\u7ED3\u679C\u6216\u5B9E\u73B0\u7EA6\u675F\uFF0C\u4E0D\u8981\u628A\u5B83\u5F53\u6210\u201C\u65E0\u9700\u66F4\u65B0\u6587\u6863\u201D\uFF1B\u8FD9\u4E9B\u4EE3\u7801\u4E8B\u5B9E\u53D8\u5316\u901A\u5E38\u9700\u8981\u66F4\u65B0 design.md\u3002",
      "\u4E0D\u8981\u53EA\u6DFB\u52A0\u6807\u8BB0\u3001\u5B8C\u6210\u8BF4\u660E\u6216\u6CDB\u6CDB\u6458\u8981\u6765\u6EE1\u8DB3 SDD \u5BF9\u9F50\uFF1B\u5E94\u66FF\u6362\u5177\u4F53\u8FC7\u671F\u7684\u53E5\u5B50\u3001\u6BB5\u843D\u6216\u6E05\u5355\u9879\uFF0C\u8BA9\u6587\u6863\u63CF\u8FF0\u771F\u5B9E\u5B9E\u73B0\u7684\u884C\u4E3A\u3001API\u3001\u9519\u8BEF\u5904\u7406\u3001\u6027\u80FD\u7B56\u7565\u6216\u4EFB\u52A1\u72B6\u6001\u3002",
      "\u5F53\u4EE3\u7801\u65B0\u589E\u6216\u4FEE\u6539\u5BFC\u51FA\u540D\u79F0\u3001\u516C\u5171\u51FD\u6570\u7B7E\u540D\u3001\u5B57\u9762\u91CF\u8FD4\u56DE\u503C\u3001\u914D\u7F6E\u9ED8\u8BA4\u503C\u3001\u7528\u6237\u53EF\u89C1\u6587\u6848\u6216\u9A8C\u6536\u76F8\u5173\u5E38\u91CF\u65F6\uFF0C\u628A\u8FD9\u4E9B\u5177\u4F53\u4E8B\u5B9E\u540C\u6B65\u5230\u5408\u9002\u7684 design.md/tasks.md \u73B0\u6709\u6587\u5B57\u91CC\uFF0C\u4E0D\u8981\u53EA\u505A\u6A21\u7CCA\u603B\u7ED3\u3002",
      "\u7F16\u8F91 design.md \u540E\uFF0C\u91CD\u65B0\u68C0\u67E5\u521A\u6539\u8FC7\u7684\u53E5\u5B50\uFF0C\u786E\u4FDD\u6CA1\u6709\u65E7\u8868\u8FF0\u4ECD\u7136\u4E0E\u5F53\u524D\u4EE3\u7801\u77DB\u76FE\u3002",
      "\u5F53\u4EE3\u7801\u5B8C\u6210\u3001\u53D8\u66F4\u3001\u53D6\u6D88\u3001\u62C6\u5206\u6216\u4F7F\u67D0\u4E2A\u5B9E\u73B0\u4EFB\u52A1\u3001\u6E05\u5355\u9879\u3001\u8BA1\u5212\u6B65\u9AA4\u3001\u9A8C\u6536\u6761\u4EF6\u5931\u6548\u65F6\uFF0C\u66F4\u65B0 tasks.md\u3002",
      "\u53EA\u6709\u7EAF\u673A\u68B0\u6539\u52A8\u624D\u9002\u5408\u8D70\u201C\u65E0\u9700\u6539\u6587\u6863\u201D\u8DEF\u5F84\uFF0C\u4F8B\u5982\u4EC5\u683C\u5F0F\u5316\u3001\u4EC5\u6CE8\u91CA\u3001\u4EC5\u6D4B\u8BD5\u811A\u624B\u67B6\uFF0C\u6216\u4E0D\u6539\u53D8\u6D3B\u8DC3 SDD \u8BA1\u5212\u7684\u4F9D\u8D56/\u914D\u7F6E\u53D8\u66F4\u3002",
      "\u5982\u679C\u5224\u65AD\u65E0\u9700\u4FEE\u6539 SDD\uFF0C\u660E\u786E\u8BF4\u660E\u5DF2\u8BC4\u5BA1\u54EA\u4E9B\u6D3B\u8DC3 design.md/tasks.md\uFF0C\u4EE5\u53CA\u4E3A\u4EC0\u4E48\u672C\u6B21\u4EE3\u7801\u53D8\u66F4\u6CA1\u6709\u8BBE\u8BA1\u6216\u4EFB\u52A1\u5F71\u54CD\u3002",
      "\u53EA\u4FEE\u6539\u4E0E\u5F53\u524D\u4EE3\u7801\u6279\u6B21\u76F8\u5173\u7684\u5185\u5BB9\uFF1B\u4E0D\u8981\u53D1\u660E\u672A\u6765\u9700\u6C42\uFF0C\u4E5F\u4E0D\u8981\u6269\u5927\u8303\u56F4\u3002"
    ];
    var ATTRIBUTION_REVIEW_RULES = [
      "\u7EAF\u673A\u68B0\u6539\u52A8\uFF08\u683C\u5F0F\u5316\u3001\u4EC5\u6CE8\u91CA\u3001\u6D4B\u8BD5\u811A\u624B\u67B6\u3001\u4F9D\u8D56\u5347\u7EA7\u3001lint \u4FEE\u590D\uFF09\u4E0D\u9700\u8981\u66F4\u65B0 SDD \u6587\u6863\u3002\u8BF7\u5728\u56DE\u590D\u91CC\u660E\u786E\u8BF4\u660E\u8FD9\u4E2A\u7ED3\u8BBA\uFF0C\u7136\u540E\u7EE7\u7EED\u539F\u4EFB\u52A1\u3002",
      "\u5982\u679C\u4EE3\u7801\u53D8\u66F4\u5B9E\u73B0\u7684\u884C\u4E3A\u5DF2\u7ECF\u88AB\u67D0\u4E2A\u5019\u9009 change-dir \u7684 design.md \u63CF\u8FF0\uFF0C\u5E76\u4E14\u8BE5 change-dir \u7684 tasks.md \u4E5F\u5DF2\u53CD\u6620\u5B9E\u73B0\u72B6\u6001\uFF0C\u5219\u65E0\u9700 SDD \u52A8\u4F5C\u3002",
      "\u5982\u679C\u4EE3\u7801\u53D8\u66F4\u65B0\u589E\u3001\u4FEE\u6539\u6216\u79FB\u9664\u4E86\u4EFB\u4F55\u5019\u9009 change-dir \u7684 design.md \u90FD\u6CA1\u6709\u63CF\u8FF0\u7684\u884C\u4E3A\uFF0C\u5E94\u66F4\u65B0\u6700\u76F8\u5173 change-dir \u7684 design.md\uFF0C\u5199\u6E05\u5B9E\u9645\u5B9E\u73B0\u884C\u4E3A\u3002\u5982\u679C\u67D0\u4E2A\u8DDF\u8E2A\u4EFB\u52A1\u5DF2\u5B8C\u6210\u6216\u5931\u6548\uFF0C\u4E5F\u8981\u66F4\u65B0 tasks.md\u3002",
      "\u5982\u679C\u4EE3\u7801\u53D8\u66F4\u786E\u5B9E\u4E0E\u4EFB\u4F55\u6D3B\u8DC3 change-dir \u90FD\u65E0\u5173\uFF0C\u8BF7\u5728\u56DE\u590D\u4E2D\u8BF4\u660E\u5B83\u4E0D\u5C5E\u4E8E\u5F53\u524D SDD \u8303\u56F4\uFF1B\u5982\u679C\u5DE5\u4F5C\u5DF2\u8FBE\u5230\u529F\u80FD\u7EA7\u522B\u5E76\u503C\u5F97\u8DDF\u8E2A\uFF0C\u53EF\u4EE5\u521B\u5EFA\u65B0\u7684 sdd/changes/<id>/ \u76EE\u5F55\u3002",
      "\u5982\u679C\u591A\u4E2A\u5019\u9009 change-dir \u90FD\u53EF\u80FD\u76F8\u5173\uFF0C\u6839\u636E design.md \u5185\u5BB9\u9009\u62E9\u6700\u5177\u4F53\u7684\u5339\u914D\u9879\uFF0C\u5E76\u5728\u56DE\u590D\u4E2D\u7B80\u8981\u8BF4\u660E\u7406\u7531\u3002\u4E0D\u8981\u7F16\u8F91\u65E0\u5173 change-dir\u3002"
    ];
    var SUBAGENT_REVIEW_RULE = "\u5982\u679C\u5F53\u524D\u73AF\u5883\u652F\u6301 subagent\uFF0C\u5E76\u4E14\u5141\u8BB8\u53EA\u8BFB\u8BC4\u5BA1 subagent\uFF0C\u53EF\u4EE5\u59D4\u6258\u5B83\u505A SDD \u8BC4\u5BA1\uFF1B\u5426\u5219\u7531\u4E3B agent \u4F7F\u7528 read \u5DE5\u5177\u81EA\u884C\u8BC4\u5BA1\u3002\u6700\u7EC8\u7F16\u8F91\u8D23\u4EFB\u4ECD\u7531\u4E3B agent \u627F\u62C5\u3002";
    var RESUME_ORIGINAL_TASK_RULES = [
      "SDD \u8BC4\u5BA1\u662F\u5F53\u524D\u4EFB\u52A1\u4E2D\u7684\u68C0\u67E5\u70B9\uFF0C\u4E0D\u662F\u6700\u7EC8\u4EFB\u52A1\u672C\u8EAB\u3002",
      "\u628A SDD \u8BC4\u5BA1/\u540C\u6B65\u89C6\u4E3A\u5F53\u524D\u7528\u6237\u4EFB\u52A1\u4E2D\u7684\u68C0\u67E5\u70B9\uFF0C\u4E0D\u8981\u628A\u5B83\u5F53\u6210\u5168\u90E8\u4EFB\u52A1\u3002",
      "SDD \u8BC4\u5BA1\u6216\u540C\u6B65\u5B8C\u6210\u540E\uFF0C\u56DE\u5230\u539F\u59CB\u7528\u6237\u4EFB\u52A1\u3002",
      "\u5FC5\u8981\u7684 SDD \u5DE5\u4F5C\u5B8C\u6210\u540E\uFF0C\u5982\u679C\u8FD8\u6709\u5B9E\u73B0\u3001\u9A8C\u8BC1\u3001\u6E05\u7406\u6216\u56DE\u590D\u5DE5\u4F5C\u672A\u5B8C\u6210\uFF0C\u4ECE\u6682\u505C\u5904\u7EE7\u7EED\u539F\u59CB\u7528\u6237\u8BF7\u6C42\u3002",
      "\u53EA\u6709\u539F\u59CB\u7528\u6237\u4EFB\u52A1\u548C\u5FC5\u8981\u7684 SDD \u8BC4\u5BA1/\u540C\u6B65\u90FD\u5B8C\u6210\u540E\uFF0C\u624D\u7ED9\u51FA\u6700\u7EC8\u56DE\u590D\u3002"
    ];
    var formatAttributionReviewRules = (rules = ATTRIBUTION_REVIEW_RULES) => [
      "\u5224\u65AD SDD \u6587\u6863\u662F\u5426\u9700\u8981\u4FEE\u6539\u65F6\uFF0C\u6309\u987A\u5E8F\u5E94\u7528\u8FD9\u4E9B\u5F52\u5C5E\u8BC4\u5BA1\u89C4\u5219\uFF1A",
      ...rules.map((rule, index) => `${index + 1}. ${rule}`)
    ];
    var clonePromptRules = () => ({
      DOCUMENT_SYNC_RULES: [...DOCUMENT_SYNC_RULES],
      ACTIVE_SDD_ALIGNMENT_RULES: [...ACTIVE_SDD_ALIGNMENT_RULES],
      ATTRIBUTION_REVIEW_RULES: [...ATTRIBUTION_REVIEW_RULES],
      SUBAGENT_REVIEW_RULE,
      RESUME_ORIGINAL_TASK_RULES: [...RESUME_ORIGINAL_TASK_RULES]
    });
    var SECTION_ALIASES = /* @__PURE__ */ new Map([
      ["SDD EDIT RULES", "DOCUMENT_SYNC_RULES"],
      ["DOCUMENT SYNC RULES", "DOCUMENT_SYNC_RULES"],
      ["SDD \u7F16\u8F91\u89C4\u5219", "DOCUMENT_SYNC_RULES"],
      ["SDD \u7DE8\u8F2F\u898F\u5247", "DOCUMENT_SYNC_RULES"],
      ["\u6587\u6863\u540C\u6B65\u89C4\u5219", "DOCUMENT_SYNC_RULES"],
      ["\u6587\u6A94\u540C\u6B65\u898F\u5247", "DOCUMENT_SYNC_RULES"],
      ["ACTIVE SDD ALIGNMENT RULES", "ACTIVE_SDD_ALIGNMENT_RULES"],
      ["ALIGNMENT RULES", "ACTIVE_SDD_ALIGNMENT_RULES"],
      ["\u6D3B\u8DC3 SDD \u5BF9\u9F50\u89C4\u5219", "ACTIVE_SDD_ALIGNMENT_RULES"],
      ["\u6D3B\u8E8D SDD \u5C0D\u9F4A\u898F\u5247", "ACTIVE_SDD_ALIGNMENT_RULES"],
      ["SDD \u5BF9\u9F50\u89C4\u5219", "ACTIVE_SDD_ALIGNMENT_RULES"],
      ["SDD \u5C0D\u9F4A\u898F\u5247", "ACTIVE_SDD_ALIGNMENT_RULES"],
      ["\u5BF9\u9F50\u89C4\u5219", "ACTIVE_SDD_ALIGNMENT_RULES"],
      ["\u5C0D\u9F4A\u898F\u5247", "ACTIVE_SDD_ALIGNMENT_RULES"],
      ["ATTRIBUTION REVIEW RULES", "ATTRIBUTION_REVIEW_RULES"],
      ["\u5F52\u5C5E\u8BC4\u5BA1\u89C4\u5219", "ATTRIBUTION_REVIEW_RULES"],
      ["\u6B78\u5C6C\u8A55\u5BE9\u898F\u5247", "ATTRIBUTION_REVIEW_RULES"],
      ["\u5F52\u5C5E\u5224\u65AD\u89C4\u5219", "ATTRIBUTION_REVIEW_RULES"],
      ["\u6B78\u5C6C\u5224\u65B7\u898F\u5247", "ATTRIBUTION_REVIEW_RULES"],
      ["SUBAGENT REVIEW RULE", "SUBAGENT_REVIEW_RULE"],
      ["SUBAGENT REVIEW RULES", "SUBAGENT_REVIEW_RULE"],
      ["\u5B50\u4EE3\u7406\u8BC4\u5BA1\u89C4\u5219", "SUBAGENT_REVIEW_RULE"],
      ["\u5B50\u4EE3\u7406\u8A55\u5BE9\u898F\u5247", "SUBAGENT_REVIEW_RULE"],
      ["EXIT CRITERIA", "RESUME_ORIGINAL_TASK_RULES"],
      ["RESUME ORIGINAL TASK RULES", "RESUME_ORIGINAL_TASK_RULES"],
      ["\u9000\u51FA\u6807\u51C6", "RESUME_ORIGINAL_TASK_RULES"],
      ["\u9000\u51FA\u6A19\u6E96", "RESUME_ORIGINAL_TASK_RULES"],
      ["\u5B8C\u6210\u6807\u51C6", "RESUME_ORIGINAL_TASK_RULES"],
      ["\u5B8C\u6210\u6A19\u6E96", "RESUME_ORIGINAL_TASK_RULES"]
    ]);
    var normalizeSectionTitle = (title) => String(title || "").replace(/`/g, "").replace(/\s+/g, " ").trim().toUpperCase();
    var normalizeRuleLine = (line) => {
      const text = String(line || "").trim();
      if (!text || text.startsWith("<!--")) return "";
      return text.replace(/^[-*+]\s+/, "").replace(/^\d+[.)]\s+/, "").trim();
    };
    var parsePromptRulesMarkdown = (text) => {
      const parsed = {};
      let current = null;
      for (const line of String(text || "").split(/\r?\n/)) {
        const heading = line.match(/^#{2,6}\s+(.+?)\s*#*\s*$/);
        if (heading) {
          current = SECTION_ALIASES.get(normalizeSectionTitle(heading[1])) || null;
          continue;
        }
        if (!current) continue;
        const rule = normalizeRuleLine(line);
        if (!rule) continue;
        if (!parsed[current]) parsed[current] = [];
        parsed[current].push(rule);
      }
      return parsed;
    };
    var unique = (items) => {
      const seen = /* @__PURE__ */ new Set();
      return items.filter((item) => {
        if (!item || seen.has(item)) return false;
        seen.add(item);
        return true;
      });
    };
    var promptRulePathCandidates = () => {
      const configured = process.env.SDD_DRIFT_RULES_FILE;
      const moduleDir = path2.resolve(__dirname);
      const sourcePluginRoot = path2.basename(moduleDir) === "core" && path2.basename(path2.dirname(moduleDir)) === "src" ? path2.resolve(moduleDir, "..", "..") : "";
      return unique([
        configured ? path2.resolve(configured) : "",
        path2.join(moduleDir, PROMPT_RULES_FILE),
        sourcePluginRoot ? path2.join(sourcePluginRoot, PROMPT_RULES_FILE) : ""
      ]);
    };
    var resolvePromptRulesPath = () => promptRulePathCandidates().find((candidate) => {
      try {
        return fs.statSync(candidate).isFile();
      } catch {
        return false;
      }
    });
    var getPromptRules = () => {
      const defaults = clonePromptRules();
      const rulesPath = resolvePromptRulesPath();
      if (!rulesPath) return defaults;
      let parsed;
      try {
        parsed = parsePromptRulesMarkdown(fs.readFileSync(rulesPath, "utf8"));
      } catch {
        return defaults;
      }
      return {
        DOCUMENT_SYNC_RULES: parsed.DOCUMENT_SYNC_RULES?.length ? parsed.DOCUMENT_SYNC_RULES : defaults.DOCUMENT_SYNC_RULES,
        ACTIVE_SDD_ALIGNMENT_RULES: parsed.ACTIVE_SDD_ALIGNMENT_RULES?.length ? parsed.ACTIVE_SDD_ALIGNMENT_RULES : defaults.ACTIVE_SDD_ALIGNMENT_RULES,
        ATTRIBUTION_REVIEW_RULES: parsed.ATTRIBUTION_REVIEW_RULES?.length ? parsed.ATTRIBUTION_REVIEW_RULES : defaults.ATTRIBUTION_REVIEW_RULES,
        SUBAGENT_REVIEW_RULE: parsed.SUBAGENT_REVIEW_RULE?.length ? parsed.SUBAGENT_REVIEW_RULE.join(" ") : defaults.SUBAGENT_REVIEW_RULE,
        RESUME_ORIGINAL_TASK_RULES: parsed.RESUME_ORIGINAL_TASK_RULES?.length ? parsed.RESUME_ORIGINAL_TASK_RULES : defaults.RESUME_ORIGINAL_TASK_RULES
      };
    };
    var findSdd = (fp) => {
      const parts = toPosix(path2.resolve(fp)).split("/");
      for (let index = parts.length - 1; index >= 0; index -= 1) {
        const part = parts[index];
        if (part !== "sdd" && part !== ".sdd") continue;
        const rel = parts.slice(index + 1).join("/");
        if (rel === "" || rel.startsWith("changes/") || rel.startsWith("specs/")) {
          return path2.normalize(parts.slice(0, index + 1).join("/"));
        }
      }
      return null;
    };
    var getChangeDoc = (fp) => {
      const root = findSdd(fp);
      const rawRel = root ? path2.relative(root, fp) : "";
      if (!root || rawRel.startsWith("..")) return null;
      const rel = toPosix(rawRel);
      const match = rel.match(/^changes\/([^/]+)\/([^/]+\.md)$/);
      if (!match) return { root, rel };
      const [, id, file] = match;
      return {
        root,
        rel,
        id,
        file,
        dir: path2.join(root, "changes", id)
      };
    };
    var isArchivedChangeDirName = (dir) => {
      const name = path2.basename(path2.normalize(dir)).toLowerCase();
      return ARCHIVED_CHANGE_DIR_NAMES.has(name) || /(^|[-_.])(archived|已归档)($|[-_.])/.test(name);
    };
    var isArchiveStatusText = (text) => /^\s*(status|state)\s*[:：]\s*(archived|archive|closed)\s*$/im.test(text || "") || /^\s*(状态|阶段)\s*[:：]\s*(已归档|归档)\s*$/im.test(text || "");
    var readSmallText = (fp) => {
      try {
        return fs.readFileSync(fp, "utf8").slice(0, 4096);
      } catch {
        return "";
      }
    };
    var isArchivedChangeDir = (dir) => {
      if (!dir || isArchivedChangeDirName(dir)) return true;
      for (const marker of ARCHIVE_MARKER_FILES) {
        if (fs.existsSync(path2.join(dir, marker))) return true;
      }
      for (const statusFile of ARCHIVE_STATUS_FILES) {
        const text = readSmallText(path2.join(dir, statusFile));
        if (text && isArchiveStatusText(text)) return true;
      }
      return false;
    };
    var hasSddWorkspace = (cwd) => {
      for (const name of ["sdd", ".sdd"]) {
        try {
          if (fs.statSync(path2.join(cwd, name)).isDirectory()) return true;
        } catch {
        }
      }
      return false;
    };
    module2.exports = {
      ACTIVE_SDD_ALIGNMENT_RULES,
      ARCHIVED_CHANGE_DIR_NAMES,
      ARCHIVE_MARKER_FILES,
      ARCHIVE_STATUS_FILES,
      ATTRIBUTION_REVIEW_RULES,
      CHANGE_DOC_REQUIREMENTS,
      DESIGN_FILE,
      DOCUMENT_SYNC_RULES,
      PEER_FILES,
      PROPOSAL_FILE,
      PROMPT_RULES_FILE,
      RESUME_ORIGINAL_TASK_RULES,
      REVIEW_FILES,
      STATE_DIR,
      SUBAGENT_REVIEW_RULE,
      TASKS_FILE,
      getPromptRules,
      formatAttributionReviewRules,
      findSdd,
      getChangeDoc,
      hasSddWorkspace,
      isArchiveStatusText,
      isArchivedChangeDir,
      isArchivedChangeDirName,
      parsePromptRulesMarkdown,
      resolvePromptRulesPath
    };
  }
});

// src/core/state-storage.js
var require_state_storage = __commonJS({
  "src/core/state-storage.js"(exports2, module2) {
    var crypto = require("crypto");
    var fs = require("fs");
    var os = require("os");
    var path2 = require("path");
    var { normalizeKey } = require_paths();
    var { STATE_RETENTION_MS } = require_runtime_config();
    var { STATE_DIR } = require_sdd_rules();
    var sanitize = (value) => String(value || "default").replace(/[^a-zA-Z0-9_.-]/g, "_");
    var hash = (value) => crypto.createHash("sha1").update(String(value)).digest("hex").slice(0, 12);
    var stateDirCache = /* @__PURE__ */ new Map();
    var findNearestGitDir = (cwd) => {
      let dir = path2.resolve(cwd);
      while (dir !== path2.dirname(dir)) {
        const gitPath = path2.join(dir, ".git");
        try {
          const stat = fs.statSync(gitPath);
          if (stat.isDirectory()) return gitPath;
          if (stat.isFile()) {
            const content = fs.readFileSync(gitPath, "utf8").trim();
            const match = content.match(/^gitdir:\s*(.+)$/i);
            if (match) return path2.resolve(dir, match[1].trim());
          }
        } catch {
        }
        dir = path2.dirname(dir);
      }
      return null;
    };
    var canUseStateDir = (dir) => {
      const probeBase = `.probe.${process.pid}.${Date.now()}`;
      const tmp = path2.join(dir, `${probeBase}.tmp`);
      const target = path2.join(dir, probeBase);
      try {
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(tmp, "");
        fs.renameSync(tmp, target);
        fs.unlinkSync(target);
        return true;
      } catch {
        try {
          fs.unlinkSync(tmp);
        } catch {
        }
        try {
          fs.unlinkSync(target);
        } catch {
        }
        return false;
      }
    };
    var stateDir = (cwd) => {
      const cacheKey = normalizeKey(cwd);
      const cached = stateDirCache.get(cacheKey);
      if (cached) return cached;
      const gitDir = findNearestGitDir(cwd);
      if (gitDir) {
        const gitStateDir = path2.join(gitDir, "sdd-drift-hook-state");
        if (canUseStateDir(gitStateDir)) {
          stateDirCache.set(cacheKey, gitStateDir);
          return gitStateDir;
        }
      }
      const localStateDir = path2.join(cwd, STATE_DIR);
      if (canUseStateDir(localStateDir)) {
        stateDirCache.set(cacheKey, localStateDir);
        return localStateDir;
      }
      const tempStateDir = path2.join(os.tmpdir(), "sdd-drift-check", hash(path2.resolve(cwd)));
      stateDirCache.set(cacheKey, tempStateDir);
      return tempStateDir;
    };
    var statePath = (cwd, sessionID) => path2.join(stateDir(cwd), `${hash(path2.resolve(cwd))}-${sanitize(sessionID)}.json`);
    var projectStatePath = (cwd) => path2.join(stateDir(cwd), "project.json");
    var diagnosticLogPath = (cwd) => process.env.SDD_DRIFT_LOG_PATH || path2.join(stateDir(cwd), "sdd-drift-check.log.jsonl");
    var writeTextAtomic = (target, text) => {
      fs.mkdirSync(path2.dirname(target), { recursive: true });
      const tmp = path2.join(path2.dirname(target), `.${path2.basename(target)}.${process.pid}.${Date.now()}.tmp`);
      fs.writeFileSync(tmp, text);
      try {
        fs.renameSync(tmp, target);
      } catch (err) {
        try {
          fs.writeFileSync(target, text);
        } catch {
          try {
            fs.unlinkSync(tmp);
          } catch {
          }
          throw err;
        }
        try {
          fs.unlinkSync(tmp);
        } catch {
        }
      }
    };
    var cleanupOldState = (cwd) => {
      const dir = stateDir(cwd);
      try {
        const now = Date.now();
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
          const fp = path2.join(dir, entry.name);
          const stat = fs.statSync(fp);
          if (now - stat.mtimeMs > STATE_RETENTION_MS) fs.unlinkSync(fp);
        }
      } catch {
      }
    };
    module2.exports = {
      canUseStateDir,
      cleanupOldState,
      diagnosticLogPath,
      findNearestGitDir,
      hash,
      projectStatePath,
      sanitize,
      stateDir,
      statePath,
      writeTextAtomic
    };
  }
});

// src/core/session-state.js
var require_session_state = __commonJS({
  "src/core/session-state.js"(exports2, module2) {
    var fs = require("fs");
    var path2 = require("path");
    var { getToolFilePath } = require_tool_events();
    var { isCodePath, isSddChangePath } = require_file_classifier();
    var { normalizeKey, resolveFile, samePath } = require_paths();
    var {
      CHANGE_DOC_REQUIREMENTS,
      DESIGN_FILE,
      PEER_FILES,
      PROPOSAL_FILE,
      TASKS_FILE,
      getChangeDoc
    } = require_sdd_rules();
    var { SESSION_FILES_MAX, TOOL_EVENT_CAP, TRANSCRIPT_EVENT_CAP } = require_runtime_config();
    var { cleanupOldState, statePath, writeTextAtomic } = require_state_storage();
    var emptyState = () => ({
      version: 3,
      createdAt: (/* @__PURE__ */ new Date()).toISOString(),
      clock: 0,
      touched: [],
      edited: [],
      changeDirs: [],
      files: {},
      requirements: {},
      stopBlocks: {},
      toolEvents: {},
      peerSyncs: {},
      codeDriftNotice: null,
      codeDriftToolNotice: null,
      peerDriftNotice: null,
      subagentCheckpointNotice: null,
      codeReviewConfirmations: {},
      transcriptEvents: {},
      transcriptCursor: null,
      dtsContext: null,
      firstEventAt: null,
      projectStateSeenAt: null,
      carryOverNotice: null,
      attributionReviews: {},
      noEditSession: true,
      circuitBreaker: {}
    });
    var addPath = (items, item) => {
      if (!items.some((existing) => samePath(existing, item))) items.push(path2.normalize(item));
    };
    var sessionFilesMax = () => Number.isFinite(SESSION_FILES_MAX) ? Math.max(100, SESSION_FILES_MAX) : 1e3;
    var fileRecordOrder = (record) => Math.max(
      Number(record?.editedSeq || 0),
      Number(record?.touchedSeq || 0),
      Number(record?.firstEditedSeq || 0)
    );
    var pruneStateFiles = (state) => {
      const maxFiles = sessionFilesMax();
      const entries = Object.entries(state.files || {});
      if (entries.length <= maxFiles) return false;
      const keep = new Set(
        entries.sort((left, right) => fileRecordOrder(right[1]) - fileRecordOrder(left[1])).slice(0, maxFiles).map(([key]) => key)
      );
      state.files = Object.fromEntries(entries.filter(([key]) => keep.has(key)));
      state.touched = (state.touched || []).filter((file) => keep.has(normalizeKey(file)));
      state.edited = (state.edited || []).filter((file) => keep.has(normalizeKey(file)));
      return true;
    };
    var normalizeState = (parsed) => {
      const state = emptyState();
      if (!parsed || typeof parsed !== "object") return state;
      state.version = 3;
      state.createdAt = typeof parsed.createdAt === "string" && parsed.createdAt ? parsed.createdAt : (/* @__PURE__ */ new Date()).toISOString();
      state.clock = Number.isFinite(parsed.clock) ? parsed.clock : 0;
      state.touched = Array.isArray(parsed.touched) ? parsed.touched.map((fp) => path2.normalize(fp)) : [];
      state.edited = Array.isArray(parsed.edited) ? parsed.edited.map((fp) => path2.normalize(fp)) : [];
      state.changeDirs = Array.isArray(parsed.changeDirs) ? parsed.changeDirs.map((fp) => path2.normalize(fp)) : [];
      state.files = parsed.files && typeof parsed.files === "object" ? parsed.files : {};
      state.requirements = parsed.requirements && typeof parsed.requirements === "object" ? parsed.requirements : {};
      state.stopBlocks = parsed.stopBlocks && typeof parsed.stopBlocks === "object" ? parsed.stopBlocks : {};
      state.toolEvents = parsed.toolEvents && typeof parsed.toolEvents === "object" ? parsed.toolEvents : {};
      state.peerSyncs = parsed.peerSyncs && typeof parsed.peerSyncs === "object" ? parsed.peerSyncs : {};
      state.codeDriftNotice = parsed.codeDriftNotice && typeof parsed.codeDriftNotice === "object" ? parsed.codeDriftNotice : null;
      state.codeDriftToolNotice = parsed.codeDriftToolNotice && typeof parsed.codeDriftToolNotice === "object" ? parsed.codeDriftToolNotice : null;
      state.peerDriftNotice = parsed.peerDriftNotice && typeof parsed.peerDriftNotice === "object" ? parsed.peerDriftNotice : null;
      state.subagentCheckpointNotice = parsed.subagentCheckpointNotice && typeof parsed.subagentCheckpointNotice === "object" ? parsed.subagentCheckpointNotice : null;
      state.codeReviewConfirmations = parsed.codeReviewConfirmations && typeof parsed.codeReviewConfirmations === "object" ? parsed.codeReviewConfirmations : {};
      state.transcriptEvents = parsed.transcriptEvents && typeof parsed.transcriptEvents === "object" ? parsed.transcriptEvents : {};
      state.transcriptCursor = parsed.transcriptCursor && typeof parsed.transcriptCursor === "object" ? {
        path: typeof parsed.transcriptCursor.path === "string" ? path2.resolve(parsed.transcriptCursor.path) : null,
        offset: Number.isFinite(parsed.transcriptCursor.offset) ? Math.max(0, Number(parsed.transcriptCursor.offset)) : 0,
        lineIndex: Number.isFinite(parsed.transcriptCursor.lineIndex) ? Math.max(0, Number(parsed.transcriptCursor.lineIndex)) : 0
      } : null;
      state.dtsContext = parsed.dtsContext && typeof parsed.dtsContext === "object" ? parsed.dtsContext : null;
      state.firstEventAt = typeof parsed.firstEventAt === "string" && parsed.firstEventAt ? parsed.firstEventAt : null;
      state.projectStateSeenAt = typeof parsed.projectStateSeenAt === "string" && parsed.projectStateSeenAt ? parsed.projectStateSeenAt : null;
      state.carryOverNotice = parsed.carryOverNotice && typeof parsed.carryOverNotice === "object" ? parsed.carryOverNotice : null;
      state.attributionReviews = parsed.attributionReviews && typeof parsed.attributionReviews === "object" ? parsed.attributionReviews : {};
      state.noEditSession = typeof parsed.noEditSession === "boolean" ? parsed.noEditSession : state.edited.length === 0;
      state.circuitBreaker = parsed.circuitBreaker && typeof parsed.circuitBreaker === "object" ? parsed.circuitBreaker : {};
      for (const fp of state.touched) {
        const key = normalizeKey(fp);
        state.files[key] = {
          ...state.files[key] || {},
          path: path2.normalize(fp),
          touchedSeq: state.files[key]?.touchedSeq || 1
        };
      }
      for (const fp of state.edited) {
        const key = normalizeKey(fp);
        state.files[key] = {
          ...state.files[key] || {},
          path: path2.normalize(fp),
          touchedSeq: state.files[key]?.touchedSeq || 1,
          editedSeq: state.files[key]?.editedSeq || 1,
          firstEditedSeq: state.files[key]?.firstEditedSeq || state.files[key]?.editedSeq || 1
        };
      }
      pruneStateFiles(state);
      return state;
    };
    var loadState = (cwd, sessionID) => {
      try {
        return normalizeState(JSON.parse(fs.readFileSync(statePath(cwd, sessionID), "utf8")));
      } catch {
        return emptyState();
      }
    };
    var saveState = (cwd, sessionID, state) => {
      cleanupOldState(cwd);
      writeTextAtomic(statePath(cwd, sessionID), JSON.stringify(state, null, 2));
    };
    var touchedSeq = (state, fp) => state.files[normalizeKey(fp)]?.touchedSeq || 0;
    var editedSeq = (state, fp) => state.files[normalizeKey(fp)]?.editedSeq || 0;
    var firstEditedSeq = (state, fp) => state.files[normalizeKey(fp)]?.firstEditedSeq || 0;
    var latestEditedCodeSeq = (state) => Object.values(state.files || {}).reduce((latest, file) => {
      if (!file.editedSeq || !isCodePath(file.path || "")) return latest;
      return Math.max(latest, file.editedSeq || 0);
    }, 0);
    var editedSddSeqAfter = (state, files, seq) => files.some((file) => editedSeq(state, file) > seq);
    var markToolEvent = (state, eventKey) => {
      if (!eventKey) return true;
      if (state.toolEvents[eventKey]) return false;
      state.toolEvents[eventKey] = Date.now();
      const entries = Object.entries(state.toolEvents);
      if (entries.length > TOOL_EVENT_CAP) {
        entries.sort((left, right) => Number(left[1] || 0) - Number(right[1] || 0)).slice(0, entries.length - TOOL_EVENT_CAP).forEach(([key]) => {
          delete state.toolEvents[key];
        });
      }
      return true;
    };
    var markTranscriptEvent = (state, eventKey) => {
      if (!eventKey) return true;
      if (state.transcriptEvents[eventKey]) return false;
      state.transcriptEvents[eventKey] = Date.now();
      const entries = Object.entries(state.transcriptEvents);
      if (entries.length > TRANSCRIPT_EVENT_CAP) {
        entries.sort((left, right) => Number(left[1] || 0) - Number(right[1] || 0)).slice(0, entries.length - TRANSCRIPT_EVENT_CAP).forEach(([key]) => {
          delete state.transcriptEvents[key];
        });
      }
      return true;
    };
    var fileMtimeMs = (fp) => {
      try {
        return fs.statSync(fp).mtimeMs;
      } catch {
        return 0;
      }
    };
    var latestStateEventMs = (state) => Object.values(state.files || {}).reduce(
      (latest, file) => Math.max(latest, Number(file?.touchedAtMs || 0), Number(file?.editedAtMs || 0)),
      0
    );
    var recordFile = (state, fp, edited) => {
      const abs = path2.normalize(path2.resolve(fp));
      const key = normalizeKey(abs);
      const existing = state.files[key] || {};
      const mtimeMs = fileMtimeMs(abs);
      state.clock += 1;
      const eventMs = Math.max(Date.now() * 1e3, latestStateEventMs(state), Math.round(mtimeMs * 1e3)) + 1;
      state.files[key] = {
        ...existing,
        path: abs,
        ...mtimeMs ? { mtimeMs } : {},
        touchedAtMs: eventMs,
        touchedSeq: state.clock,
        ...edited ? { editedSeq: state.clock, editedAtMs: eventMs } : {},
        ...edited ? { firstEditedSeq: existing.firstEditedSeq || existing.editedSeq || state.clock } : {}
      };
      addPath(state.touched, abs);
      if (edited) {
        addPath(state.edited, abs);
        state.noEditSession = false;
      }
      pruneStateFiles(state);
      return state.clock;
    };
    var addChangeDir = (state, dir) => addPath(state.changeDirs, dir);
    var getRequirementBucket = (state, dir, create) => {
      const key = normalizeKey(dir);
      if (!state.requirements[key] && create) {
        state.requirements[key] = { dir: path2.normalize(dir), files: {} };
      }
      return state.requirements[key];
    };
    var cleanupRequirementBucket = (state, dir) => {
      const key = normalizeKey(dir);
      const bucket = state.requirements[key];
      if (bucket && Object.keys(bucket.files || {}).length === 0) delete state.requirements[key];
    };
    var getPeerSyncBucket = (state, dir, create) => {
      const key = normalizeKey(dir);
      if (!state.peerSyncs[key] && create) {
        state.peerSyncs[key] = { dir: path2.normalize(dir), files: {} };
      }
      return state.peerSyncs[key];
    };
    var cleanupPeerSyncBucket = (state, dir) => {
      const key = normalizeKey(dir);
      const bucket = state.peerSyncs[key];
      if (bucket && Object.keys(bucket.files || {}).length === 0) delete state.peerSyncs[key];
    };
    var markPeerSyncResponse = (state, dir, file, sourceFile, sourceSeq, targetSeq) => {
      if (!sourceFile) return;
      const bucket = getPeerSyncBucket(state, dir, true);
      bucket.files[file] = { sourceFile, sourceSeq, targetSeq };
    };
    var isPeerSyncContinuation = (state, dir, file, seq) => {
      const bucket = getPeerSyncBucket(state, dir, false);
      const sync = bucket?.files?.[file];
      if (!sync?.sourceFile) return false;
      const sourceSeq = editedSeq(state, path2.join(dir, sync.sourceFile));
      if (sourceSeq > sync.sourceSeq) {
        delete bucket.files[file];
        cleanupPeerSyncBucket(state, dir);
        return false;
      }
      if (seq > sync.targetSeq) sync.targetSeq = seq;
      return true;
    };
    var clearPeerSyncsForSourceEdit = (state, dir, sourceFile, seq) => {
      const bucket = getPeerSyncBucket(state, dir, false);
      if (!bucket) return;
      for (const [file, sync] of Object.entries(bucket.files || {})) {
        if (sync?.sourceFile === sourceFile && seq > sync.sourceSeq) delete bucket.files[file];
      }
      cleanupPeerSyncBucket(state, dir);
    };
    var clearPeerSyncs = (state) => {
      state.peerSyncs = {};
    };
    var clearStageOnlyRequirements = (state) => {
      for (const [key, bucket] of Object.entries(state.requirements || {})) {
        for (const [file, requirement] of Object.entries(bucket.files || {})) {
          if (requirement?.stageOnly || requirement?.sourceFile === PROPOSAL_FILE) delete bucket.files[file];
        }
        if (Object.keys(bucket.files || {}).length === 0) delete state.requirements[key];
      }
    };
    var isInitialTasksPlanEdit = (state, dir, seq) => {
      const tasksPath = path2.join(dir, TASKS_FILE);
      const designPath = path2.join(dir, DESIGN_FILE);
      const designSourceSeq = Math.max(touchedSeq(state, designPath), editedSeq(state, designPath));
      return firstEditedSeq(state, tasksPath) === seq && designSourceSeq > 0 && fs.existsSync(designPath);
    };
    var updateRequirementsForEdit = (state, dir, file, seq) => {
      const bucket = getRequirementBucket(state, dir, false);
      const pending = bucket?.files?.[file];
      let satisfiedStageOnly = false;
      if (pending && seq > pending.afterSeq) {
        satisfiedStageOnly = Boolean(pending.stageOnly || pending.sourceFile === PROPOSAL_FILE);
        if (!satisfiedStageOnly) {
          markPeerSyncResponse(state, dir, file, pending.sourceFile, pending.afterSeq, seq);
        }
        delete bucket.files[file];
        cleanupRequirementBucket(state, dir);
        if (!satisfiedStageOnly) return;
      }
      if (!satisfiedStageOnly && isPeerSyncContinuation(state, dir, file, seq)) return;
      if (file === TASKS_FILE && isInitialTasksPlanEdit(state, dir, seq)) {
        const designPath = path2.join(dir, DESIGN_FILE);
        markPeerSyncResponse(
          state,
          dir,
          TASKS_FILE,
          DESIGN_FILE,
          Math.max(touchedSeq(state, designPath), editedSeq(state, designPath)),
          seq
        );
        return;
      }
      clearPeerSyncsForSourceEdit(state, dir, file, seq);
      const stageOnly = file === PROPOSAL_FILE;
      let requiredPeers = CHANGE_DOC_REQUIREMENTS[file] || [];
      if (file === TASKS_FILE) {
        const latestCodeSeq = latestEditedCodeSeq(state);
        const designReviewedAfterCode = touchedSeq(state, path2.join(dir, DESIGN_FILE)) > latestCodeSeq;
        const tasksEditedAfterCode = seq > latestCodeSeq;
        if (latestCodeSeq > 0 && designReviewedAfterCode && tasksEditedAfterCode) {
          requiredPeers = [];
        }
      }
      if (requiredPeers.length === 0) return;
      const target = getRequirementBucket(state, dir, true);
      for (const peer of requiredPeers) {
        const peerPath = path2.join(dir, peer);
        if (!fs.existsSync(peerPath)) continue;
        if (editedSeq(state, peerPath) > seq) continue;
        const existing = target.files[peer];
        if (existing && !existing.stageOnly && stageOnly) continue;
        target.files[peer] = {
          sourceFile: file,
          afterSeq: seq,
          stageOnly
        };
      }
      cleanupRequirementBucket(state, dir);
    };
    var applyToolRecord = (cwd, state, toolName, toolInput) => {
      const fp = getToolFilePath(toolInput || {});
      if (!fp || typeof fp !== "string") return false;
      const tool = String(toolName || "").toLowerCase();
      const isEdit = tool === "edit" || tool === "write" || tool === "multiedit";
      if (!isEdit && tool !== "read") return false;
      const abs = resolveFile(cwd, fp);
      const seq = recordFile(state, abs, isEdit);
      if (isEdit) {
        const doc = getChangeDoc(abs);
        if (doc?.dir && doc.file) {
          addChangeDir(state, doc.dir);
          updateRequirementsForEdit(state, doc.dir, doc.file, seq);
        }
      }
      return true;
    };
    var hasEditedSddChange = (state) => Object.values(state.files).some((file) => file.editedSeq && isSddChangePath(file.path || ""));
    module2.exports = {
      addChangeDir,
      addPath,
      applyToolRecord,
      clearPeerSyncs,
      clearStageOnlyRequirements,
      cleanupPeerSyncBucket,
      cleanupRequirementBucket,
      editedSddSeqAfter,
      editedSeq,
      emptyState,
      fileMtimeMs,
      fileRecordOrder,
      firstEditedSeq,
      getPeerSyncBucket,
      getRequirementBucket,
      hasEditedSddChange,
      isInitialTasksPlanEdit,
      isPeerSyncContinuation,
      latestEditedCodeSeq,
      latestStateEventMs,
      loadState,
      markPeerSyncResponse,
      markToolEvent,
      markTranscriptEvent,
      normalizeState,
      pruneStateFiles,
      recordFile,
      saveState,
      sessionFilesMax,
      touchedSeq,
      updateRequirementsForEdit
    };
  }
});

// src/core/hydration.js
var require_hydration = __commonJS({
  "src/core/hydration.js"(exports2, module2) {
    var fs = require("fs");
    var os = require("os");
    var path2 = require("path");
    var { isCodePath } = require_file_classifier();
    var { normalizeKey, rel, resolveFile, samePath } = require_paths();
    var {
      CHECKPOINT_MTIME_SCAN,
      CHECKPOINT_MTIME_SCAN_MAX_FILES,
      CHECKPOINT_MTIME_SCAN_MAX_VISITS,
      CHECKPOINT_MTIME_WINDOW_MS,
      CHECKPOINT_OUTPUT_TEXT_MAX_BYTES,
      DTS_CONTEXT_SKIP
    } = require_runtime_config();
    var { hasSddWorkspace } = require_sdd_rules();
    var { applyToolRecord, fileMtimeMs, markTranscriptEvent, recordFile } = require_session_state();
    var { hash } = require_state_storage();
    var { isSubagentCheckpointTool } = require_tool_events();
    var CHECKPOINT_OUTPUT_KEYS = [
      "tool_output",
      "tool_result",
      "tool_response",
      "result",
      "output",
      "response"
    ];
    var CHECKPOINT_EDIT_LINE_RE = /\b(changed|modified|edited|updated|created|wrote|written|implemented|generated|patched|touched|saved|added|deleted|removed|renamed|refactored)\b|已修改|已更新|已创建|已写入|已实现|已生成|写入|修改|更新|创建|实现|变更/i;
    var CHECKPOINT_EDIT_HEADER_RE = /\b(files?\s+(changed|modified|edited|updated|created|written)|changed\s+files?|modified\s+files?|updated\s+files?|created\s+files?|implementation\s+changes?)\b|变更文件|修改文件|更新文件|创建文件|已修改文件|已更新文件/i;
    var CHECKPOINT_COMPLETION_RE = /\b(implemented|fixed|updated|created|modified|changed|wrote|patched|refactored|built|generated|saved|completed implementation|implementation complete|feature complete)\b|已完成|完成实现|实现完成|已实现|已修复|已更新|已修改|已创建|已写入|完成修改|修复完成|更新完成|修改完成/i;
    var CHECKPOINT_PATH_RE = /(?:[A-Za-z]:)?(?:[A-Za-z0-9_. -]+[\\/])*(?:[A-Za-z0-9_. -]+\.(?:ts|tsx|js|jsx|mjs|cjs|html|css|vue|svelte|py|go|rs|java|kt|swift|cc|cpp|c|h|hpp|rb|php|cs|scss|sql)|(?:proposal|design|tasks)\.md)/gi;
    var CHECKPOINT_PATH_IGNORE_RE = /^(?:node_modules|\.git|\.opencode|\.claude|\.sdd-drift-hook-state|\.real-workspaces)(?:\/|$)/;
    var limitString = (value, max = 500) => {
      const text = String(value || "");
      return text.length > max ? `${text.slice(0, max)}...` : text;
    };
    var isDtsContextActive = (state) => DTS_CONTEXT_SKIP && Boolean(state.dtsContext?.active);
    var resolveTranscriptPath = (input) => {
      const explicit = input?.transcript_path;
      if (explicit && typeof explicit === "string" && fs.existsSync(explicit)) {
        return explicit;
      }
      const sessionID = input?.session_id;
      if (!sessionID || typeof sessionID !== "string") return explicit;
      const candidates = [];
      const todoPath = input?.todo_path;
      if (todoPath && typeof todoPath === "string") {
        const claudeDir = path2.dirname(path2.dirname(todoPath));
        candidates.push(path2.join(claudeDir, "transcripts", `${sessionID}.jsonl`));
      }
      const homes = [process.env.HOME, process.env.USERPROFILE, os.homedir()].filter(Boolean);
      for (const home of homes) {
        candidates.push(path2.join(home, ".claude", "transcripts", `${sessionID}.jsonl`));
      }
      return candidates.find((candidate) => fs.existsSync(candidate)) || explicit;
    };
    var transcriptContentBlocks = (entry) => {
      const content = entry?.message?.content;
      if (Array.isArray(content)) return content;
      return [];
    };
    var transcriptToolUseRecord = (block) => {
      const name = block?.name || block?.tool || block?.tool_name;
      const input = block?.input || block?.tool_input || block?.state?.input;
      if (!name || !input || typeof input !== "object") return null;
      return {
        id: block.id || block.tool_use_id || block.callID || block.call_id || null,
        name,
        input,
        source: "tool_use",
        completed: block?.state?.status === "completed"
      };
    };
    var transcriptToolResultRecord = (entry, block) => {
      const result = entry?.tool_use_result || block?.tool_use_result;
      const id = block?.tool_use_id || entry?.parent_tool_use_id || entry?.tool_use_id || null;
      const failed = Boolean(entry?.is_error || block?.is_error || result?.is_error || result?.error);
      const fp = result?.filePath || result?.file_path;
      if (!fp || typeof fp !== "string") {
        return id ? { id, source: "tool_result", failed } : null;
      }
      const type = String(result?.type || "").toLowerCase();
      const name = type === "text" && !result?.oldString && !result?.newString && !result?.structuredPatch ? "Read" : "Edit";
      return {
        id,
        name,
        input: { file_path: fp },
        source: "tool_result",
        failed
      };
    };
    var transcriptLegacyToolResultRecord = (entry) => {
      const name = entry?.tool_name;
      const input = entry?.tool_input;
      if (!name || !input || typeof input !== "object") return null;
      return {
        id: entry.tool_use_id || null,
        name,
        input,
        source: "tool_result",
        failed: Boolean(entry?.is_error || entry?.error)
      };
    };
    var transcriptToolRecords = (entry) => {
      const records = [];
      const blocks = transcriptContentBlocks(entry);
      const add = (record) => {
        if (record) records.push(record);
      };
      add(transcriptToolUseRecord(entry));
      if (entry?.part?.type === "tool") add(transcriptToolUseRecord(entry.part));
      if (entry?.type === "tool_result") {
        add(transcriptLegacyToolResultRecord(entry));
      }
      for (const block of blocks) {
        if (block?.type === "tool_use") add(transcriptToolUseRecord(block));
        if (block?.type === "tool_result") add(transcriptToolResultRecord(entry, block));
      }
      if (entry?.type === "user" && !blocks.some((block) => block?.type === "tool_result")) {
        add(transcriptToolResultRecord(entry, null));
      }
      return records;
    };
    var transcriptToolEventKey = (record, lineIndex, recordIndex) => {
      if (record?.id) return `id:${record.id}`;
      return `pos:${lineIndex}:${recordIndex}:${hash(
        JSON.stringify({
          name: String(record?.name || "").toLowerCase(),
          input: record?.input || {}
        })
      )}`;
    };
    var countTranscriptLines = (text) => {
      if (!text) return 0;
      const newlines = (text.match(/\n/g) || []).length;
      return text.endsWith("\n") ? newlines : newlines + 1;
    };
    var readTranscriptChunk = (state, transcriptPath) => {
      const abs = path2.resolve(transcriptPath);
      const stat = fs.statSync(abs);
      const sameCursor = state.transcriptCursor?.path === abs;
      let offset = sameCursor ? Number(state.transcriptCursor?.offset || 0) : 0;
      let lineIndex = sameCursor ? Number(state.transcriptCursor?.lineIndex || 0) : 0;
      if (!Number.isFinite(offset) || offset < 0 || offset > stat.size) {
        offset = 0;
        lineIndex = 0;
      }
      const buffer = fs.readFileSync(abs).subarray(offset);
      if (!buffer.length) {
        state.transcriptCursor = { path: abs, offset, lineIndex };
        return { content: "", lineIndexBase: lineIndex };
      }
      let processLength = buffer.length;
      const lastNewline = buffer.lastIndexOf(10);
      if (lastNewline >= 0) {
        const tail = buffer.subarray(lastNewline + 1).toString("utf8").trim();
        processLength = tail && !(tail.startsWith("{") && tail.endsWith("}")) ? lastNewline + 1 : buffer.length;
      } else if (offset > 0) {
        const tail = buffer.toString("utf8").trim();
        processLength = tail.startsWith("{") && tail.endsWith("}") ? buffer.length : 0;
      }
      const processBuffer = buffer.subarray(0, processLength);
      const content = processBuffer.toString("utf8");
      const nextOffset = offset + processLength;
      const nextLineIndex = lineIndex + countTranscriptLines(content);
      state.transcriptCursor = { path: abs, offset: nextOffset, lineIndex: nextLineIndex };
      return { content, lineIndexBase: lineIndex };
    };
    var hydrateStateFromTranscript = (cwd, state, transcriptPath) => {
      if (!transcriptPath || typeof transcriptPath !== "string") return false;
      let changed = false;
      let content = "";
      let lineIndexBase = 0;
      const seen = /* @__PURE__ */ new Set();
      const pendingToolUses = /* @__PURE__ */ new Map();
      try {
        const chunk = readTranscriptChunk(state, transcriptPath);
        content = chunk.content;
        lineIndexBase = chunk.lineIndexBase;
      } catch {
        return false;
      }
      if (!content) return false;
      const lines = content.split(/\r?\n/);
      for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
        const line = lines[lineIndex];
        if (!line.trim()) continue;
        let entry;
        try {
          entry = JSON.parse(line);
        } catch {
          continue;
        }
        const records = transcriptToolRecords(entry);
        for (let recordIndex = 0; recordIndex < records.length; recordIndex += 1) {
          const record = records[recordIndex];
          if (record.source === "tool_use" && record.id && !record.completed) {
            pendingToolUses.set(record.id, record);
            continue;
          }
          let finalRecord = record;
          if (record.source === "tool_result" && record.id && pendingToolUses.has(record.id)) {
            finalRecord = {
              ...pendingToolUses.get(record.id),
              source: "tool_result",
              failed: record.failed
            };
          }
          if (finalRecord.failed) continue;
          if (finalRecord.source === "tool_use" && !finalRecord.completed) continue;
          const key = transcriptToolEventKey(finalRecord, lineIndexBase + lineIndex, recordIndex);
          if (seen.has(key)) continue;
          seen.add(key);
          if (!markTranscriptEvent(state, key)) continue;
          if (recordToolFromHydration(cwd, state, finalRecord.name, finalRecord.input)) changed = true;
        }
      }
      return changed;
    };
    var recordToolFromHydration = (cwd, state, toolName, toolInput) => {
      return applyToolRecord(cwd, state, toolName, toolInput);
    };
    var collectCheckpointStrings = (value, depth = 0, seen = /* @__PURE__ */ new Set()) => {
      if (value == null || depth > 4) return [];
      if (typeof value === "string") return [limitString(value, CHECKPOINT_OUTPUT_TEXT_MAX_BYTES)];
      if (typeof value !== "object") return [];
      if (seen.has(value)) return [];
      seen.add(value);
      if (Array.isArray(value)) {
        return value.flatMap((item) => collectCheckpointStrings(item, depth + 1, seen));
      }
      const texts = [];
      for (const key of [
        "output",
        "content",
        "text",
        "message",
        "summary",
        "result",
        "stdout",
        "value"
      ]) {
        if (Object.prototype.hasOwnProperty.call(value, key)) {
          texts.push(...collectCheckpointStrings(value[key], depth + 1, seen));
        }
      }
      return texts;
    };
    var collectCheckpointOutputText = (input) => {
      const texts = [];
      for (const key of CHECKPOINT_OUTPUT_KEYS) {
        if (Object.prototype.hasOwnProperty.call(input || {}, key)) {
          texts.push(...collectCheckpointStrings(input[key]));
        }
      }
      return limitString(texts.filter(Boolean).join("\n"), CHECKPOINT_OUTPUT_TEXT_MAX_BYTES);
    };
    var stripCheckpointPathToken = (token) => String(token || "").replace(/^[\s"'`(<\[\-*]+/, "").replace(/^\d+[.)]\s*/, "").replace(/[\s"'`)>.,;:\]]+$/, "");
    var isInsideWorkspace = (cwd, fp) => {
      const relative = path2.relative(path2.resolve(cwd), path2.resolve(fp));
      return Boolean(relative) && !relative.startsWith("..") && !path2.isAbsolute(relative);
    };
    var isIgnoredCheckpointPath = (cwd, fp) => {
      const relative = rel(cwd, fp);
      return CHECKPOINT_PATH_IGNORE_RE.test(relative);
    };
    var checkpointLineMayDescribeEdit = (line, priorHeaderLines) => CHECKPOINT_EDIT_LINE_RE.test(line) || priorHeaderLines > 0;
    var extractCheckpointEditedPaths = (cwd, text) => {
      const paths = [];
      let headerCarry = 0;
      for (const rawLine of String(text || "").split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line) {
          headerCarry = 0;
          continue;
        }
        if (CHECKPOINT_EDIT_HEADER_RE.test(line)) {
          headerCarry = 4;
        }
        const mayDescribeEdit = checkpointLineMayDescribeEdit(line, headerCarry);
        if (headerCarry > 0) headerCarry -= 1;
        if (!mayDescribeEdit) continue;
        for (const match of line.matchAll(CHECKPOINT_PATH_RE)) {
          const token = stripCheckpointPathToken(match[0]);
          if (!token) continue;
          const abs = path2.isAbsolute(token) ? path2.resolve(token) : resolveFile(cwd, token);
          if (!isInsideWorkspace(cwd, abs)) continue;
          if (isIgnoredCheckpointPath(cwd, abs)) continue;
          if (!fs.existsSync(abs)) continue;
          if (!isCodePath(abs)) continue;
          if (!paths.some((existing) => samePath(existing, abs))) paths.push(path2.normalize(abs));
        }
      }
      return paths;
    };
    var checkpointOutputSuggestsCodeEdit = (text) => CHECKPOINT_EDIT_LINE_RE.test(text || "") || CHECKPOINT_COMPLETION_RE.test(text || "");
    var checkpointMtimeWindowMs = () => {
      if (!Number.isFinite(CHECKPOINT_MTIME_WINDOW_MS)) return 10 * 60 * 1e3;
      return Math.max(0, CHECKPOINT_MTIME_WINDOW_MS);
    };
    var checkpointMtimeScanMaxFiles = () => {
      if (!Number.isFinite(CHECKPOINT_MTIME_SCAN_MAX_FILES)) return 50;
      return Math.max(1, CHECKPOINT_MTIME_SCAN_MAX_FILES);
    };
    var checkpointMtimeScanMaxVisits = () => {
      if (!Number.isFinite(CHECKPOINT_MTIME_SCAN_MAX_VISITS)) return 2e3;
      return Math.max(100, CHECKPOINT_MTIME_SCAN_MAX_VISITS);
    };
    var shouldRecordCheckpointMtimePath = (state, fp, cutoffMs) => {
      const mtimeMs = fileMtimeMs(fp);
      if (!mtimeMs || mtimeMs < cutoffMs) return false;
      const existing = state.files[normalizeKey(fp)];
      if (existing?.editedSeq && existing?.mtimeMs && mtimeMs <= Number(existing.mtimeMs) + 1) {
        return false;
      }
      return true;
    };
    var scanRecentCheckpointCodePaths = (cwd, state, cutoffMs) => {
      const found = [];
      const stack = [path2.resolve(cwd)];
      let visited = 0;
      const maxFiles = checkpointMtimeScanMaxFiles();
      const maxVisits = checkpointMtimeScanMaxVisits();
      while (stack.length && visited < maxVisits && found.length < maxFiles) {
        const dir = stack.pop();
        let entries = [];
        try {
          entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
          continue;
        }
        for (const entry of entries) {
          if (visited >= maxVisits || found.length >= maxFiles) break;
          const fp = path2.join(dir, entry.name);
          if (!isInsideWorkspace(cwd, fp) && !samePath(cwd, fp)) continue;
          if (isIgnoredCheckpointPath(cwd, fp)) continue;
          visited += 1;
          if (entry.isDirectory()) {
            stack.push(fp);
            continue;
          }
          if (!entry.isFile()) continue;
          if (!isCodePath(fp)) continue;
          if (!shouldRecordCheckpointMtimePath(state, fp, cutoffMs)) continue;
          found.push(path2.normalize(fp));
        }
      }
      return found;
    };
    var hydrateStateFromCheckpointMtime = (cwd, state, input, text = collectCheckpointOutputText(input)) => {
      const tool = String(input?.tool_name || "").toLowerCase();
      if (!CHECKPOINT_MTIME_SCAN) return false;
      if (!hasSddWorkspace(cwd) || isDtsContextActive(state)) return false;
      if (!isSubagentCheckpointTool(tool, input?.tool_input || {})) return false;
      const hasText = Boolean(String(text || "").trim());
      if (hasText && !checkpointOutputSuggestsCodeEdit(text)) return false;
      const now = Date.now();
      const createdAt = Date.parse(state.createdAt || "") || now;
      const cutoffMs = Math.max(createdAt, now - checkpointMtimeWindowMs());
      let changed = false;
      for (const fp of scanRecentCheckpointCodePaths(cwd, state, cutoffMs)) {
        recordFile(state, fp, true);
        changed = true;
      }
      return changed;
    };
    var hydrateStateFromCheckpointOutput = (cwd, state, input) => {
      const tool = String(input?.tool_name || "").toLowerCase();
      if (!isSubagentCheckpointTool(tool, input?.tool_input || {})) return false;
      const text = collectCheckpointOutputText(input);
      if (!text) return hydrateStateFromCheckpointMtime(cwd, state, input, "");
      let changed = false;
      for (const fp of extractCheckpointEditedPaths(cwd, text)) {
        recordFile(state, fp, true);
        changed = true;
      }
      return changed || hydrateStateFromCheckpointMtime(cwd, state, input, text);
    };
    module2.exports = {
      CHECKPOINT_COMPLETION_RE,
      CHECKPOINT_EDIT_HEADER_RE,
      CHECKPOINT_EDIT_LINE_RE,
      CHECKPOINT_OUTPUT_KEYS,
      CHECKPOINT_PATH_IGNORE_RE,
      CHECKPOINT_PATH_RE,
      checkpointLineMayDescribeEdit,
      checkpointMtimeScanMaxFiles,
      checkpointMtimeScanMaxVisits,
      checkpointMtimeWindowMs,
      checkpointOutputSuggestsCodeEdit,
      collectCheckpointOutputText,
      collectCheckpointStrings,
      countTranscriptLines,
      extractCheckpointEditedPaths,
      hydrateStateFromCheckpointMtime,
      hydrateStateFromCheckpointOutput,
      hydrateStateFromTranscript,
      isIgnoredCheckpointPath,
      isInsideWorkspace,
      readTranscriptChunk,
      recordToolFromHydration,
      resolveTranscriptPath,
      scanRecentCheckpointCodePaths,
      shouldRecordCheckpointMtimePath,
      stripCheckpointPathToken,
      transcriptToolEventKey,
      transcriptToolRecords
    };
  }
});

// src/core/attribution.js
var require_attribution = __commonJS({
  "src/core/attribution.js"(exports2, module2) {
    var { toPosix } = require_paths();
    var splitPath = (fp) => toPosix(fp).split("/").filter(Boolean);
    var sharedPrefixDepth = (left, right) => {
      const leftParts = splitPath(left);
      const rightParts = splitPath(right);
      let depth = 0;
      while (depth < leftParts.length && depth < rightParts.length && leftParts[depth] === rightParts[depth]) {
        depth += 1;
      }
      return depth;
    };
    var relFromCwd = (cwd, fp) => {
      const normalizedCwd = toPosix(cwd).replace(/\/+$/, "");
      const normalizedFile = toPosix(fp);
      return normalizedFile.startsWith(`${normalizedCwd}/`) ? normalizedFile.slice(normalizedCwd.length + 1) : normalizedFile;
    };
    var pathInChangeDir = (cwd, fp, relDir) => {
      const relFile = relFromCwd(cwd, fp);
      const normalizedDir = toPosix(relDir).replace(/\/+$/, "");
      return relFile === normalizedDir || relFile.startsWith(`${normalizedDir}/`);
    };
    var pathSimilar = (cwd, codeFile, linkedCode = []) => {
      const relCodeFile = relFromCwd(cwd, codeFile);
      return linkedCode.some((item) => {
        const linkedPath = toPosix(item?.path || "");
        if (!linkedPath) return false;
        return linkedPath === relCodeFile || sharedPrefixDepth(relCodeFile, linkedPath) >= 2;
      });
    };
    var decide = ({ cwd, session, project, codeFile, now = Date.now() }) => {
      const candidates = Object.values(project?.changeDirs || {}).filter((dir) => !dir.archived);
      if (candidates.length === 0) return { kind: "no-attribution" };
      if (candidates.length === 1) return { kind: "single", target: candidates[0] };
      const sessionTouched = candidates.filter(
        (dir) => (session?.edited || []).some((file) => pathInChangeDir(cwd, file, dir.relDir))
      );
      if (sessionTouched.length === 1) return { kind: "session-touched", target: sessionTouched[0] };
      if (project?.activeChangeDir && now < Number(project.activeUntilMs || 0)) {
        const active = candidates.find((dir) => dir.relDir === project.activeChangeDir);
        if (active && pathSimilar(cwd, codeFile, active.linkedCode)) {
          return { kind: "active-ttl", target: active };
        }
      }
      return { kind: "needs-review", candidates };
    };
    var targetsForDecision = (decision) => {
      if (decision?.target) return [decision.target];
      return decision?.candidates || [];
    };
    var Attribution = {
      decide,
      pathInChangeDir,
      pathSimilar,
      relFromCwd,
      sharedPrefixDepth,
      targetsForDecision
    };
    module2.exports = { Attribution };
  }
});

// src/core/locks.js
var require_locks = __commonJS({
  "src/core/locks.js"(exports2, module2) {
    var fs = require("fs");
    var path2 = require("path");
    var { DEFAULT_LOCK_STALE_MS } = require_runtime_config();
    var sleepSync = (ms) => {
      if (ms <= 0) return;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
    };
    var acquireFileLock = (target, options = {}) => {
      const staleMs = options.staleMs || DEFAULT_LOCK_STALE_MS;
      const waitMs = options.waitMs || 0;
      const retryMs = options.retryMs || 25;
      const lockPath = `${target}.lock`;
      const openLock = () => {
        fs.mkdirSync(path2.dirname(lockPath), { recursive: true });
        const fd = fs.openSync(lockPath, "wx");
        fs.writeFileSync(fd, `${process.pid}
${(/* @__PURE__ */ new Date()).toISOString()}
`);
        return { fd, lockPath };
      };
      const deadline = Date.now() + waitMs;
      while (true) {
        try {
          return openLock();
        } catch (err) {
          if (err?.code !== "EEXIST") return null;
        }
        try {
          if (Date.now() - fs.statSync(lockPath).mtimeMs > staleMs) fs.unlinkSync(lockPath);
        } catch {
        }
        if (Date.now() >= deadline) return null;
        sleepSync(retryMs);
      }
    };
    var releaseFileLock = (lock) => {
      if (!lock) return;
      try {
        fs.closeSync(lock.fd);
      } catch {
      }
      try {
        fs.unlinkSync(lock.lockPath);
      } catch {
      }
    };
    module2.exports = {
      acquireFileLock,
      releaseFileLock,
      sleepSync
    };
  }
});

// src/core/diagnostics.js
var require_diagnostics = __commonJS({
  "src/core/diagnostics.js"(exports2, module2) {
    var fs = require("fs");
    var path2 = require("path");
    var { acquireFileLock, releaseFileLock } = require_locks();
    var {
      DIAGNOSTIC_LOG,
      DIAGNOSTIC_LOG_MAX_BYTES,
      DIAGNOSTIC_LOG_RETENTION_DAYS,
      DIAGNOSTIC_SUMMARY_WINDOW_MS
    } = require_runtime_config();
    var { diagnosticLogPath, writeTextAtomic } = require_state_storage();
    var DIAGNOSTIC_SUMMARY_EVENTS = /* @__PURE__ */ new Set([
      "handler_exception",
      "hook_exception",
      "circuit_open",
      "circuit_open_skip"
    ]);
    var diagnosticSummaryState = {
      windowStartMs: 0,
      counts: {}
    };
    var escapeRegExp = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    var diagnosticSummaryWindowMs = (value = DIAGNOSTIC_SUMMARY_WINDOW_MS) => Number.isFinite(value) && value > 0 ? value : 60 * 1e3;
    var diagnosticSummaryLine = (state, windowMs) => ({
      event: "diagnostic_summary",
      windowStart: new Date(state.windowStartMs).toISOString(),
      windowEnd: new Date(state.windowStartMs + windowMs).toISOString(),
      counts: { ...state.counts || {} }
    });
    var recordDiagnosticSummaryEvent = (state, eventName, nowMs = Date.now(), windowMsValue = DIAGNOSTIC_SUMMARY_WINDOW_MS, trackedEvents = DIAGNOSTIC_SUMMARY_EVENTS) => {
      if (!trackedEvents.has(eventName)) return [];
      const windowMs = diagnosticSummaryWindowMs(windowMsValue);
      const summaries = [];
      if (!state.windowStartMs) {
        state.windowStartMs = nowMs;
        state.counts = {};
      } else if (nowMs >= state.windowStartMs + windowMs) {
        if (Object.keys(state.counts || {}).length > 0) {
          summaries.push(diagnosticSummaryLine(state, windowMs));
        }
        state.windowStartMs = nowMs;
        state.counts = {};
      }
      state.counts[eventName] = Number(state.counts[eventName] || 0) + 1;
      return summaries;
    };
    var rotateDiagnosticLog = (target) => {
      const maxBytes = Number.isFinite(DIAGNOSTIC_LOG_MAX_BYTES) ? Math.max(64 * 1024, DIAGNOSTIC_LOG_MAX_BYTES) : 2 * 1024 * 1024;
      try {
        if (!fs.existsSync(target)) return;
        if (fs.statSync(target).size < maxBytes) return;
        const rotated = `${target}.1`;
        try {
          fs.unlinkSync(rotated);
        } catch {
        }
        fs.renameSync(target, rotated);
      } catch {
      }
    };
    var diagnosticLogRetentionMs = () => {
      if (!Number.isFinite(DIAGNOSTIC_LOG_RETENTION_DAYS)) return 3 * 24 * 60 * 60 * 1e3;
      if (DIAGNOSTIC_LOG_RETENTION_DAYS <= 0) return null;
      return DIAGNOSTIC_LOG_RETENTION_DAYS * 24 * 60 * 60 * 1e3;
    };
    var parseDiagnosticLogTs = (line) => {
      try {
        const ts = Date.parse(JSON.parse(line)?.ts);
        return Number.isFinite(ts) ? ts : null;
      } catch {
        return null;
      }
    };
    var pruneDiagnosticLogFile = (target, cutoffMs) => {
      let text = "";
      try {
        text = fs.readFileSync(target, "utf8");
      } catch {
        return;
      }
      const lines = text.split(/\r?\n/).filter(Boolean);
      const kept = lines.filter((line) => {
        const ts = parseDiagnosticLogTs(line);
        return ts === null || ts >= cutoffMs;
      });
      if (kept.length === lines.length) return;
      if (!kept.length) {
        try {
          fs.unlinkSync(target);
        } catch {
        }
        return;
      }
      writeTextAtomic(target, `${kept.join("\n")}
`);
    };
    var cleanupDiagnosticLogs = (target, now = Date.now()) => {
      const retentionMs = diagnosticLogRetentionMs();
      if (retentionMs === null) return;
      const cutoffMs = now - retentionMs;
      const dir = path2.dirname(target);
      const base = path2.basename(target);
      const rotatedPattern = new RegExp(`^${escapeRegExp(base)}\\.\\d+$`);
      try {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          if (!entry.isFile()) continue;
          if (entry.name !== base && !rotatedPattern.test(entry.name)) continue;
          const fp = path2.join(dir, entry.name);
          const stat = fs.statSync(fp);
          if (stat.mtimeMs < cutoffMs) {
            try {
              fs.unlinkSync(fp);
            } catch {
            }
            continue;
          }
          pruneDiagnosticLogFile(fp, cutoffMs);
        }
      } catch {
      }
    };
    var writeDiagnosticLog = (cwd, event) => {
      if (!DIAGNOSTIC_LOG) return;
      let lock = null;
      try {
        const target = diagnosticLogPath(cwd || process.cwd());
        fs.mkdirSync(path2.dirname(target), { recursive: true });
        lock = acquireFileLock(target);
        if (!lock) return;
        cleanupDiagnosticLogs(target);
        rotateDiagnosticLog(target);
        const nowMs = Date.now();
        const lines = [
          ...recordDiagnosticSummaryEvent(diagnosticSummaryState, event?.event, nowMs),
          event
        ].map(
          (entry) => JSON.stringify({
            ts: new Date(nowMs).toISOString(),
            pid: process.pid,
            ...entry
          })
        );
        fs.appendFileSync(target, `${lines.join("\n")}
`);
      } catch {
      } finally {
        releaseFileLock(lock);
      }
    };
    module2.exports = {
      DIAGNOSTIC_SUMMARY_EVENTS,
      cleanupDiagnosticLogs,
      diagnosticLogRetentionMs,
      diagnosticSummaryLine,
      diagnosticSummaryState,
      diagnosticSummaryWindowMs,
      parseDiagnosticLogTs,
      pruneDiagnosticLogFile,
      recordDiagnosticSummaryEvent,
      rotateDiagnosticLog,
      writeDiagnosticLog
    };
  }
});

// src/core/project-state.js
var require_project_state = __commonJS({
  "src/core/project-state.js"(exports2, module2) {
    var fs = require("fs");
    var path2 = require("path");
    var { isCodePath } = require_file_classifier();
    var { normalizeKey, samePath, toPosix } = require_paths();
    var { editedSeq } = require_session_state();
    var {
      DESIGN_FILE,
      PROPOSAL_FILE,
      TASKS_FILE,
      isArchivedChangeDir
    } = require_sdd_rules();
    var { projectStatePath, writeTextAtomic } = require_state_storage();
    var discoverChangeDirs = (cwd) => {
      const roots = ["sdd", ".sdd"].map((dir) => path2.join(cwd, dir));
      const dirs = [];
      for (const root of roots) {
        const changesRoot = path2.join(root, "changes");
        try {
          for (const entry of fs.readdirSync(changesRoot, { withFileTypes: true })) {
            if (entry.isDirectory()) dirs.push(path2.join(changesRoot, entry.name));
          }
        } catch {
        }
      }
      return dirs;
    };
    var collectActiveChangeDirs = (cwd, state) => {
      const dirs = [...state.changeDirs || [], ...discoverChangeDirs(cwd)];
      const active = [];
      for (const dir of dirs) {
        const normalized = path2.normalize(dir);
        if (isArchivedChangeDir(normalized)) continue;
        if (!active.some((existing) => samePath(existing, normalized))) active.push(normalized);
      }
      return active;
    };
    var emptyProjectState = () => ({
      version: 1,
      lastUpdatedAt: (/* @__PURE__ */ new Date()).toISOString(),
      changeDirs: {},
      activeChangeDir: null,
      activeUntilMs: 0,
      activeLastEditedSession: null
    });
    var relDirForProject = (cwd, dir) => toPosix(path2.relative(cwd, dir));
    var docKeyForFile = (file) => {
      if (file === PROPOSAL_FILE) return "proposal";
      if (file === DESIGN_FILE) return "design";
      if (file === TASKS_FILE) return "tasks";
      return null;
    };
    var docFileForKey = (key) => {
      if (key === "proposal") return PROPOSAL_FILE;
      if (key === "design") return DESIGN_FILE;
      if (key === "tasks") return TASKS_FILE;
      return null;
    };
    var eventMsForFileRecord = (record, edited) => {
      const value = edited ? record?.editedAtMs : record?.touchedAtMs;
      if (Number.isFinite(value)) return value;
      if (Number.isFinite(record?.mtimeMs)) return Math.round(record.mtimeMs * 1e3);
      return Date.now() * 1e3;
    };
    var docRecordFromFs = (fp) => {
      try {
        const stat = fs.statSync(fp);
        if (!stat.isFile()) return { exists: false };
        const ms = Math.round(stat.mtimeMs * 1e3);
        return {
          exists: true,
          lastEditedMs: ms,
          lastReviewedMs: ms
        };
      } catch {
        return { exists: false };
      }
    };
    var createChangeDirFromFs = (cwd, dir) => {
      const normalized = path2.normalize(dir);
      const changeDir = {
        relDir: relDirForProject(cwd, normalized),
        archived: isArchivedChangeDir(normalized),
        docs: {
          proposal: docRecordFromFs(path2.join(normalized, PROPOSAL_FILE)),
          design: docRecordFromFs(path2.join(normalized, DESIGN_FILE)),
          tasks: docRecordFromFs(path2.join(normalized, TASKS_FILE))
        },
        linkedCode: [],
        alignedAt: null,
        alignedAtMs: 0,
        state: "ALIGNED",
        conditions: {
          proposalOnly: false,
          designAheadOfTasks: false,
          tasksAheadOfDesign: false,
          codeAheadOfDocs: false,
          codePendingDocs: []
        },
        docSyncs: {}
      };
      changeDir.conditions = computeProjectConditions(changeDir);
      changeDir.state = computeProjectState(changeDir.conditions, changeDir.archived);
      return changeDir;
    };
    var normalizeProjectDoc = (doc) => ({
      exists: Boolean(doc?.exists),
      ...Number.isFinite(doc?.lastEditedMs) ? { lastEditedMs: Number(doc.lastEditedMs) } : {},
      ...Number.isFinite(doc?.lastReviewedMs) ? { lastReviewedMs: Number(doc.lastReviewedMs) } : {},
      ...typeof doc?.lastEditedSession === "string" ? { lastEditedSession: doc.lastEditedSession } : {},
      ...typeof doc?.lastReviewedSession === "string" ? { lastReviewedSession: doc.lastReviewedSession } : {}
    });
    var normalizeProjectChangeDir = (cwd, relDirValue, value) => {
      const relDir = toPosix(value?.relDir || relDirValue || "");
      const absDir = path2.join(cwd, relDir);
      const fromFs = createChangeDirFromFs(cwd, absDir);
      const changeDir = {
        ...fromFs,
        ...value,
        relDir,
        archived: Boolean(value?.archived) || isArchivedChangeDir(absDir),
        docs: {
          proposal: normalizeProjectDoc(value?.docs?.proposal || fromFs.docs.proposal),
          design: normalizeProjectDoc(value?.docs?.design || fromFs.docs.design),
          tasks: normalizeProjectDoc(value?.docs?.tasks || fromFs.docs.tasks)
        },
        linkedCode: Array.isArray(value?.linkedCode) ? value.linkedCode.filter((item) => item?.path && Number.isFinite(item?.lastEditedMs)).map((item) => ({
          path: toPosix(item.path),
          lastEditedMs: Number(item.lastEditedMs),
          ...typeof item.lastEditedSession === "string" ? { lastEditedSession: item.lastEditedSession } : {},
          linkedAt: Number.isFinite(item.linkedAt) ? Number(item.linkedAt) : Number(item.lastEditedMs)
        })) : [],
        alignedAt: typeof value?.alignedAt === "string" ? value.alignedAt : null,
        alignedAtMs: Number.isFinite(value?.alignedAtMs) ? Number(value.alignedAtMs) : 0,
        docSyncs: value?.docSyncs && typeof value.docSyncs === "object" ? value.docSyncs : value?.peerSyncs && typeof value.peerSyncs === "object" ? value.peerSyncs : {}
      };
      delete changeDir.peerSyncs;
      changeDir.conditions = computeProjectConditions(changeDir);
      changeDir.state = computeProjectState(changeDir.conditions, changeDir.archived);
      return changeDir;
    };
    var computeProjectConditions = (dir) => {
      const design = dir.docs?.design || {};
      const tasks = dir.docs?.tasks || {};
      const proposal = dir.docs?.proposal || {};
      const designExists = design.exists === true;
      const tasksExists = tasks.exists === true;
      const designEditedKnown = typeof design.lastEditedSession === "string";
      const tasksEditedKnown = typeof tasks.lastEditedSession === "string";
      const designEdited = Number(design.lastEditedMs || 0);
      const tasksEdited = Number(tasks.lastEditedMs || 0);
      const designReviewed = Math.max(designEdited, Number(design.lastReviewedMs || 0));
      const tasksReviewed = Math.max(tasksEdited, Number(tasks.lastReviewedMs || 0));
      const latestCodeMs = Math.max(0, ...(dir.linkedCode || []).map((item) => Number(item.lastEditedMs || 0)));
      const docSyncs = dir.docSyncs || {};
      const tasksSyncedFromDesign = docSyncs.tasks?.sourceFile === DESIGN_FILE && Number(docSyncs.tasks.sourceEditedMs || 0) >= designEdited && Number(docSyncs.tasks.targetEditedMs || 0) >= Number(docSyncs.tasks.sourceEditedMs || 0);
      const designSyncedFromTasks = docSyncs.design?.sourceFile === TASKS_FILE && Number(docSyncs.design.sourceEditedMs || 0) >= tasksEdited && Number(docSyncs.design.targetEditedMs || 0) >= Number(docSyncs.design.sourceEditedMs || 0);
      const reviewTargets = [
        designExists ? [DESIGN_FILE, designReviewed] : null,
        tasksExists ? [TASKS_FILE, tasksReviewed] : null
      ].filter(Boolean);
      const codePendingDocs = reviewTargets.filter(([, reviewedAt]) => latestCodeMs > reviewedAt).map(([file]) => file);
      return {
        proposalOnly: proposal.exists === true && !designExists && !tasksExists,
        designAheadOfTasks: designExists && tasksExists && designEditedKnown && designEdited > tasksEdited && designEdited > 0 && !designSyncedFromTasks,
        tasksAheadOfDesign: designExists && tasksExists && tasksEditedKnown && tasksEdited > designEdited && tasksEdited > 0 && !tasksSyncedFromDesign,
        codeAheadOfDocs: latestCodeMs > Number(dir.alignedAtMs || 0) && codePendingDocs.length > 0,
        codePendingDocs
      };
    };
    var computeProjectState = (conditions, archived) => {
      if (archived) return "ARCHIVED";
      if (conditions.proposalOnly) return "PROPOSAL_STAGE";
      const flags = [
        conditions.designAheadOfTasks,
        conditions.tasksAheadOfDesign,
        conditions.codeAheadOfDocs
      ].filter(Boolean);
      if (flags.length === 0) return "ALIGNED";
      if (flags.length > 1) return "MULTI_DRIFT";
      if (conditions.designAheadOfTasks) return "DESIGN_PENDING_TASKS";
      if (conditions.tasksAheadOfDesign) return "TASKS_PENDING_DESIGN";
      return "CODE_PENDING_REVIEW";
    };
    var recomputeProjectState = (project, cwd) => {
      for (const [relDirValue, dir] of Object.entries(project.changeDirs || {})) {
        const absDir = path2.join(cwd, dir.relDir || relDirValue);
        dir.archived = Boolean(dir.archived) || isArchivedChangeDir(absDir);
        for (const key of ["proposal", "design", "tasks"]) {
          const file = docFileForKey(key);
          const fp = path2.join(absDir, file);
          const fsDoc = docRecordFromFs(fp);
          dir.docs[key] = {
            ...dir.docs?.[key] || {},
            exists: fsDoc.exists,
            ...fsDoc.exists && !Number.isFinite(dir.docs?.[key]?.lastEditedMs) ? { lastEditedMs: fsDoc.lastEditedMs } : {},
            ...fsDoc.exists && !Number.isFinite(dir.docs?.[key]?.lastReviewedMs) ? { lastReviewedMs: fsDoc.lastReviewedMs } : {}
          };
        }
        dir.conditions = computeProjectConditions(dir);
        dir.state = computeProjectState(dir.conditions, dir.archived);
      }
      project.lastUpdatedAt = (/* @__PURE__ */ new Date()).toISOString();
      return project;
    };
    var ensureProjectChangeDirs = (cwd, project) => {
      for (const dir of discoverChangeDirs(cwd)) {
        const relDirValue = relDirForProject(cwd, dir);
        if (!project.changeDirs[relDirValue]) {
          project.changeDirs[relDirValue] = createChangeDirFromFs(cwd, dir);
        }
      }
      return recomputeProjectState(project, cwd);
    };
    var normalizeProjectState = (cwd, parsed) => {
      const project = emptyProjectState();
      if (parsed && typeof parsed === "object") {
        project.version = 1;
        project.lastUpdatedAt = typeof parsed.lastUpdatedAt === "string" && parsed.lastUpdatedAt ? parsed.lastUpdatedAt : project.lastUpdatedAt;
        project.activeChangeDir = typeof parsed.activeChangeDir === "string" ? toPosix(parsed.activeChangeDir) : null;
        project.activeUntilMs = Number.isFinite(parsed.activeUntilMs) ? Number(parsed.activeUntilMs) : 0;
        project.activeLastEditedSession = typeof parsed.activeLastEditedSession === "string" ? parsed.activeLastEditedSession : null;
        project.changeDirs = {};
        for (const [relDirValue, value] of Object.entries(parsed.changeDirs || {})) {
          project.changeDirs[toPosix(relDirValue)] = normalizeProjectChangeDir(cwd, relDirValue, value);
        }
      }
      return ensureProjectChangeDirs(cwd, project);
    };
    var quarantineCorruptStateFile = (fp) => {
      try {
        if (!fs.existsSync(fp)) return;
        fs.renameSync(fp, `${fp}.corrupt-${Date.now()}`);
      } catch {
      }
    };
    var loadProjectState = (cwd) => {
      const fp = projectStatePath(cwd);
      try {
        return normalizeProjectState(cwd, JSON.parse(fs.readFileSync(fp, "utf8")));
      } catch (err) {
        if (err?.code !== "ENOENT") quarantineCorruptStateFile(fp);
        return normalizeProjectState(cwd, emptyProjectState());
      }
    };
    var saveProjectState = (cwd, project) => {
      recomputeProjectState(project, cwd);
      writeTextAtomic(projectStatePath(cwd), JSON.stringify(project, null, 2));
    };
    var collectCarryOverDrift = (project) => Object.values(project?.changeDirs || {}).filter((dir) => !dir.archived).filter((dir) => dir.state !== "ALIGNED" && dir.state !== "PROPOSAL_STAGE");
    var refreshAlignedBaseline = (cwd, project, state) => {
      if (!project) return false;
      const nowMs = Date.now() * 1e3;
      let changed = false;
      for (const dir of Object.values(project.changeDirs || {})) {
        if (dir.archived) continue;
        const linkedCodeRecords = (dir.linkedCode || []).map((item) => state.files?.[normalizeKey(path2.join(cwd, item.path))]).filter((record) => record?.editedSeq && isCodePath(record.path || ""));
        if (!linkedCodeRecords.length) continue;
        const latestCodeSeq = Math.max(0, ...linkedCodeRecords.map((record) => Number(record.editedSeq || 0)));
        if (!latestCodeSeq) continue;
        const docPaths = [DESIGN_FILE, TASKS_FILE].filter((file) => dir.docs?.[docKeyForFile(file)]?.exists).map((file) => path2.join(cwd, dir.relDir, file));
        if (!docPaths.length) continue;
        const docSeqs = docPaths.map((file) => editedSeq(state, file));
        const allDocsEditedBeforeCode = docSeqs.every((seq) => seq > 0 && seq < latestCodeSeq);
        if (!allDocsEditedBeforeCode) continue;
        const latestCodeMs = Math.max(0, ...linkedCodeRecords.map((record) => eventMsForFileRecord(record, true)));
        if (Number(dir.alignedAtMs || 0) >= latestCodeMs) continue;
        dir.alignedAtMs = Math.max(nowMs, latestCodeMs);
        dir.alignedAt = (/* @__PURE__ */ new Date()).toISOString();
        changed = true;
      }
      if (changed) recomputeProjectState(project, cwd);
      return changed;
    };
    module2.exports = {
      collectActiveChangeDirs,
      collectCarryOverDrift,
      computeProjectConditions,
      computeProjectState,
      createChangeDirFromFs,
      discoverChangeDirs,
      docFileForKey,
      docKeyForFile,
      docRecordFromFs,
      emptyProjectState,
      ensureProjectChangeDirs,
      eventMsForFileRecord,
      loadProjectState,
      normalizeProjectChangeDir,
      normalizeProjectDoc,
      normalizeProjectState,
      quarantineCorruptStateFile,
      recomputeProjectState,
      refreshAlignedBaseline,
      relDirForProject,
      saveProjectState
    };
  }
});

// src/core/drift-engine.js
var require_drift_engine = __commonJS({
  "src/core/drift-engine.js"(exports2, module2) {
    var fs = require("fs");
    var path2 = require("path");
    var { isCodePath } = require_file_classifier();
    var { rel, samePath, toPosix } = require_paths();
    var {
      collectActiveChangeDirs,
      computeProjectConditions,
      discoverChangeDirs,
      docKeyForFile
    } = require_project_state();
    var {
      editedSeq,
      editedSddSeqAfter,
      hasEditedSddChange,
      touchedSeq
    } = require_session_state();
    var { CODE_REVIEW_CONFIRMATION_CAP, DTS_CONTEXT_SKIP } = require_runtime_config();
    var {
      DESIGN_FILE,
      PEER_FILES,
      PROPOSAL_FILE,
      REVIEW_FILES,
      TASKS_FILE,
      getChangeDoc,
      hasSddWorkspace,
      isArchivedChangeDir
    } = require_sdd_rules();
    var { hash } = require_state_storage();
    var isDtsContextActive = (state) => DTS_CONTEXT_SKIP && Boolean(state.dtsContext?.active);
    var drift = (cwd, fp, state) => {
      const warn = [];
      const doc = getChangeDoc(fp);
      if (!hasSddWorkspace(cwd) || isDtsContextActive(state)) return warn;
      if (doc?.root) {
        if (doc.rel.startsWith("specs/")) {
          warn.push(
            `SDD DRIFT: ${doc.rel} was changed directly. SDD changes should normally go through sdd/changes/<id>/. If this bypass is intentional, mention it explicitly.`
          );
        }
        return warn;
      }
      if (isCodePath(fp) && !hasEditedSddChange(state)) {
        warn.push(
          `SDD DRIFT: code file ${path2.basename(fp)} was changed, but this session did not edit any sdd/changes/** file. SDD expects a change proposal first.`
        );
      }
      return warn;
    };
    var collectPeerGaps = (cwd, state, options = {}) => {
      const includeStageOnly = options.includeStageOnly !== false;
      const includeHard = options.includeHard !== false;
      const gaps = [];
      for (const bucket of Object.values(state.requirements || {})) {
        const dir = bucket.dir;
        if (isArchivedChangeDir(dir)) continue;
        const absent = [];
        const unsynced = [];
        const stale = [];
        const required = [];
        const pendingRequirements = [];
        for (const [file, requirement] of Object.entries(bucket.files || {})) {
          const requirementStageOnly = Boolean(requirement?.stageOnly || requirement?.sourceFile === PROPOSAL_FILE);
          if (requirementStageOnly ? !includeStageOnly : !includeHard) continue;
          const peerPath = path2.join(dir, file);
          const seq = editedSeq(state, peerPath);
          if (seq > requirement.afterSeq) continue;
          required.push(file);
          pendingRequirements.push({ file, ...requirement, stageOnly: requirementStageOnly });
          if (!fs.existsSync(peerPath)) {
            absent.push(file);
          } else if (seq === 0) {
            unsynced.push(file);
          } else {
            stale.push(file);
          }
        }
        if (!required.length) continue;
        const stageOnly = pendingRequirements.every((requirement) => requirement.stageOnly);
        if (stageOnly && !includeStageOnly) continue;
        const edited = [PROPOSAL_FILE, ...PEER_FILES].filter((file) => editedSeq(state, path2.join(dir, file)) > 0);
        const relDir = toPosix(path2.relative(cwd, dir));
        gaps.push({
          relDir,
          edited,
          sourceFiles: [...new Set(pendingRequirements.map((requirement) => requirement.sourceFile).filter(Boolean))],
          stageOnly,
          absent,
          missing: absent,
          unsynced,
          stale,
          required
        });
      }
      return gaps;
    };
    var collectProjectPeerGaps = (cwd, project, options = {}) => {
      const includeStageOnly = options.includeStageOnly !== false;
      const includeHard = options.includeHard !== false;
      const gaps = [];
      for (const dir of Object.values(project?.changeDirs || {})) {
        if (dir.archived) continue;
        const absDir = path2.join(cwd, dir.relDir);
        const conditions = computeProjectConditions(dir);
        const required = [];
        const sourceFiles = [];
        if (conditions.proposalOnly && includeStageOnly) continue;
        if (conditions.designAheadOfTasks && includeHard) {
          required.push(TASKS_FILE);
          sourceFiles.push(DESIGN_FILE);
        }
        if (conditions.tasksAheadOfDesign && includeHard) {
          required.push(DESIGN_FILE);
          sourceFiles.push(TASKS_FILE);
        }
        if (!required.length) continue;
        gaps.push({
          relDir: dir.relDir,
          edited: [PROPOSAL_FILE, DESIGN_FILE, TASKS_FILE].filter((file) => {
            const key = docKeyForFile(file);
            return Number(dir.docs?.[key]?.lastEditedMs || 0) > 0;
          }),
          sourceFiles,
          stageOnly: false,
          absent: required.filter((file) => !fs.existsSync(path2.join(absDir, file))),
          missing: required.filter((file) => !fs.existsSync(path2.join(absDir, file))),
          unsynced: required.filter((file) => fs.existsSync(path2.join(absDir, file))),
          stale: [],
          required,
          projectLevel: true
        });
      }
      return gaps;
    };
    var collectProjectCodeGaps = (cwd, project) => {
      if (!project || !hasSddWorkspace(cwd)) return [];
      const gaps = [];
      for (const dir of Object.values(project.changeDirs || {})) {
        if (dir.archived) continue;
        const conditions = computeProjectConditions(dir);
        if (!conditions.codeAheadOfDocs) continue;
        const codeFiles = (dir.linkedCode || []).map((item) => path2.join(cwd, item.path));
        const latestCodeMs = Math.max(0, ...(dir.linkedCode || []).map((item) => Number(item.lastEditedMs || 0)));
        const reviewTargets = conditions.codePendingDocs.map((file) => path2.join(cwd, dir.relDir, file));
        if (!reviewTargets.length || !codeFiles.length) continue;
        gaps.push({
          codeFiles,
          latestCodeSeq: latestCodeMs,
          latestCodeMs,
          reviewTargets,
          pendingReviewTargets: reviewTargets,
          reviewReady: false,
          needsConfirmation: false,
          projectLevel: true,
          relDir: dir.relDir,
          reviewSignature: hash(
            JSON.stringify({
              type: "project-code",
              relDir: dir.relDir,
              latestCodeMs,
              reviewTargets: reviewTargets.map((file) => rel(cwd, file)).sort()
            })
          )
        });
      }
      return gaps;
    };
    var codeReviewSignature = (cwd, gap) => hash(
      JSON.stringify({
        codeFiles: (gap.codeFiles || []).map((file) => rel(cwd, file)).sort(),
        latestCodeSeq: gap.latestCodeSeq || 0,
        reviewTargets: (gap.reviewTargets || []).map((file) => rel(cwd, file)).sort()
      })
    );
    var isCodeReviewConfirmed = (state, signature) => Boolean(signature && state.codeReviewConfirmations?.[signature]?.confirmed);
    var collectReviewTargets = (cwd, state) => {
      if (!hasSddWorkspace(cwd)) return [];
      const discoveredDirs = [...state.changeDirs || [], ...discoverChangeDirs(cwd)];
      const dirs = collectActiveChangeDirs(cwd, state);
      const targets = [];
      for (const dir of dirs) {
        for (const file of REVIEW_FILES) {
          const target = path2.join(dir, file);
          if (!fs.existsSync(target)) continue;
          if (!targets.some((existing) => samePath(existing, target))) {
            targets.push(path2.normalize(target));
          }
        }
      }
      if (targets.length || dirs.length || discoveredDirs.length) return targets;
      const fallbackRoot = fs.existsSync(path2.join(cwd, ".sdd")) ? ".sdd" : "sdd";
      return REVIEW_FILES.map((file) => path2.join(cwd, fallbackRoot, "changes", "<change-id>", file));
    };
    var collectCodeGaps = (cwd, state) => {
      if (!hasSddWorkspace(cwd) || isDtsContextActive(state)) return [];
      const codeFiles = Object.values(state.files || {}).filter((file) => file.editedSeq && isCodePath(file.path || "")).sort((left, right) => (right.editedSeq || 0) - (left.editedSeq || 0));
      if (!codeFiles.length) return [];
      const latestCodeSeq = codeFiles[0].editedSeq || 0;
      const reviewTargets = collectReviewTargets(cwd, state);
      const pendingReviewTargets = reviewTargets.filter((file) => touchedSeq(state, file) <= latestCodeSeq);
      const baseGap = {
        codeFiles: codeFiles.map((file) => file.path),
        latestCodeSeq,
        reviewTargets,
        pendingReviewTargets
      };
      const reviewSignature = codeReviewSignature(cwd, baseGap);
      if (state.codeReviewConfirmations?.[reviewSignature]?.implementationFlow) return [];
      const hasReviewEdit = editedSddSeqAfter(state, reviewTargets, latestCodeSeq);
      const reviewReady = pendingReviewTargets.length === 0;
      if (reviewReady && (hasReviewEdit || isCodeReviewConfirmed(state, reviewSignature))) return [];
      return [
        {
          ...baseGap,
          reviewSignature,
          reviewReady,
          needsConfirmation: reviewReady && !hasReviewEdit
        }
      ];
    };
    var collectCombinedPeerGaps = (cwd, state, project, options = {}) => {
      const combined = [
        ...collectPeerGaps(cwd, state, options),
        ...collectProjectPeerGaps(cwd, project, options)
      ];
      const seen = /* @__PURE__ */ new Set();
      return combined.filter((gap) => {
        const key = `${gap.relDir}:${gap.required.sort().join(",")}:${gap.sourceFiles.sort().join(",")}:${gap.stageOnly}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    };
    var collectCombinedCodeGaps = (cwd, state, project) => {
      const sessionGaps = collectCodeGaps(cwd, state);
      const rawProjectGaps = collectProjectCodeGaps(cwd, project);
      const projectGaps = rawProjectGaps.filter(
        (gap) => !state.codeReviewConfirmations?.[gap.reviewSignature]?.implementationFlow && !isCodeReviewConfirmed(state, gap.reviewSignature)
      );
      const codeFilesKey = (gap) => (gap.codeFiles || []).map((file) => rel(cwd, file)).sort().join("\0");
      const projectCodeKeys = new Set(rawProjectGaps.map(codeFilesKey));
      const projectLinkedCode = new Set(
        Object.values(project?.changeDirs || {}).flatMap(
          (dir) => (dir.linkedCode || []).map((item) => toPosix(item.path))
        )
      );
      const allCodeFilesTrackedByProject = (gap) => (gap.codeFiles || []).every((file) => projectLinkedCode.has(rel(cwd, file)));
      const combined = [
        ...sessionGaps.filter(
          (gap) => !projectCodeKeys.has(codeFilesKey(gap)) && !allCodeFilesTrackedByProject(gap)
        ),
        ...projectGaps
      ];
      const seen = /* @__PURE__ */ new Set();
      return combined.filter((gap) => {
        const key = JSON.stringify({
          codeFiles: (gap.codeFiles || []).map((file) => rel(cwd, file)).sort(),
          reviewTargets: (gap.reviewTargets || []).map((file) => rel(cwd, file)).sort()
        });
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    };
    var pruneCodeReviewConfirmations = (state) => {
      const entries = Object.entries(state.codeReviewConfirmations || {});
      if (entries.length <= CODE_REVIEW_CONFIRMATION_CAP) return;
      entries.sort((left, right) => {
        const leftAt = Date.parse(left[1]?.confirmedAt || left[1]?.requestedAt || 0) || 0;
        const rightAt = Date.parse(right[1]?.confirmedAt || right[1]?.requestedAt || 0) || 0;
        return leftAt - rightAt;
      }).slice(0, entries.length - CODE_REVIEW_CONFIRMATION_CAP).forEach(([key]) => {
        delete state.codeReviewConfirmations[key];
      });
    };
    var markCodeReviewNoEditConfirmation = (state, gaps) => {
      if (!gaps.length || !gaps.every((gap) => gap.needsConfirmation && gap.reviewReady)) return false;
      let confirmed = true;
      for (const gap of gaps) {
        const signature = gap.reviewSignature;
        if (!signature) {
          confirmed = false;
          continue;
        }
        const existing = state.codeReviewConfirmations[signature] || {};
        state.codeReviewConfirmations[signature] = {
          ...existing,
          requested: true,
          requestedAt: existing.requestedAt || (/* @__PURE__ */ new Date()).toISOString(),
          confirmed: true,
          confirmedAt: (/* @__PURE__ */ new Date()).toISOString(),
          codeSeq: gap.latestCodeSeq || 0,
          codeFiles: (gap.codeFiles || []).map((file) => file.path || file),
          reviewTargets: gap.reviewTargets || [],
          noSddEdit: true,
          userConfirmationRecommended: true
        };
      }
      pruneCodeReviewConfirmations(state);
      return confirmed;
    };
    module2.exports = {
      codeReviewSignature,
      collectCodeGaps,
      collectCombinedCodeGaps,
      collectCombinedPeerGaps,
      collectPeerGaps,
      collectProjectCodeGaps,
      collectProjectPeerGaps,
      collectReviewTargets,
      drift,
      isCodeReviewConfirmed,
      isDtsContextActive,
      markCodeReviewNoEditConfirmation,
      pruneCodeReviewConfirmations
    };
  }
});

// src/core/prompts.js
var require_prompts = __commonJS({
  "src/core/prompts.js"(exports2, module2) {
    var { collectCombinedCodeGaps, collectCombinedPeerGaps } = require_drift_engine();
    var { rel } = require_paths();
    var { collectCarryOverDrift } = require_project_state();
    var {
      formatAttributionReviewRules,
      getPromptRules
    } = require_sdd_rules();
    var { hash } = require_state_storage();
    var SYSTEM_DIRECTIVE_PREFIX = "SDD-DRIFT-CHECK";
    var section = (title, lines = []) => ["", title, ...lines.filter(Boolean)];
    var buildSystemReminder = (type, lines) => [
      "<system-reminder>",
      `[SYSTEM DIRECTIVE: ${SYSTEM_DIRECTIVE_PREFIX} - ${type}]`,
      ...lines.filter((line) => line !== null && line !== void 0),
      "</system-reminder>"
    ].join("\n");
    var stripSystemReminderWrapper = (message) => String(message || "").trim().replace(/^<system-reminder>\s*/i, "").replace(/\s*<\/system-reminder>\s*$/i, "").trim();
    var promptRules = () => getPromptRules();
    var documentSyncRules = () => promptRules().DOCUMENT_SYNC_RULES;
    var activeSddAlignmentRules = () => promptRules().ACTIVE_SDD_ALIGNMENT_RULES;
    var resumeOriginalTaskRules = () => promptRules().RESUME_ORIGINAL_TASK_RULES;
    var subagentReviewRule = () => promptRules().SUBAGENT_REVIEW_RULE;
    var attributionReviewRules = () => formatAttributionReviewRules(promptRules().ATTRIBUTION_REVIEW_RULES);
    var buildAttributionReviewPrompt = (cwd, { codeFiles = [], candidates = [] } = {}) => {
      const codeLines = codeFiles.length ? codeFiles.map((file) => `  - ${rel(cwd, file)}`) : ["  - unknown code file"];
      const candidateLines = candidates.length ? candidates.map((dir) => {
        const docs = dir.docs || {};
        const docState = [
          docs.design?.exists ? "design.md" : null,
          docs.tasks?.exists ? "tasks.md" : null
        ].filter(Boolean).join(", ");
        const suffix = docState ? `; docs: ${docState}` : "";
        return `  - ${dir.relDir}${dir.state ? ` (${dir.state}${suffix})` : suffix}`;
      }) : ["  - no active SDD change-dir candidates"];
      return buildSystemReminder("ATTRIBUTION REVIEW", [
        ...section("STATE", [
          "SDD attribution review needed.",
          "Recent code changes:",
          ...codeLines,
          "Candidate active SDD change directories:",
          ...candidateLines
        ]),
        ...section("REQUIRED ACTION", [
          "Read the relevant candidate design.md/tasks.md files, decide which change-dir owns the code change, then do exactly one of these:",
          "- edit the matching SDD document(s) if they are stale;",
          "- leave documents unchanged if the reviewed docs are already aligned;",
          "- create a new sdd/changes/<id>/ directory only if this work is feature-sized and not covered by any candidate;",
          "- state that the code change is unrelated to active SDD scope if none applies."
        ]),
        ...section("SDD EDIT RULES", [
          "Preserve existing SDD templates and headings when editing.",
          ...documentSyncRules()
        ]),
        ...section("ATTRIBUTION RULES", attributionReviewRules())
      ]);
    };
    var formatGap = (gap) => {
      const parts = [`required [${gap.required.join(", ")}]`];
      if (gap.stageOnly) parts.push("stage reminder");
      if (gap.absent?.length) parts.push(`absent [${gap.absent.join(", ")}]`);
      if (gap.unsynced?.length) parts.push(`unsynced in this session [${gap.unsynced.join(", ")}]`);
      if (gap.stale?.length) parts.push(`stale [${gap.stale.join(", ")}]`);
      return `${gap.relDir}: edited [${gap.edited.join(", ")}], ${parts.join(", ")}`;
    };
    var buildToolEnforcement = (gaps, options = {}) => {
      const compact = Boolean(options.compact);
      const stageOnly = gaps.length > 0 && gaps.every((gap) => gap.stageOnly);
      const detail = gaps.map(
        (gap) => `- ${formatGap(gap)}. Synchronize: ${gap.required.map((file) => `${gap.relDir}/${file}`).join(", ")}`
      ).join("\n");
      if (stageOnly) {
        return buildSystemReminder("PROPOSAL STAGE REMINDER", [
          ...section("STATE", [
            "SDD proposal stage reminder.",
            "The preceding tool changed proposal.md.",
            detail
          ]),
          ...section("REQUIRED ACTION", [
            "A proposal-only turn is valid; if the current user request only asked for proposal drafting or refinement, you may finish normally.",
            "If you continue this same request into design work, read the current design.md first and update the appropriate existing section without changing its template."
          ]),
          ...section("SDD EDIT RULES", [
            "Do not create or edit tasks.md directly from proposal.md. Let tasks.md follow only after design.md has been reviewed or updated."
          ])
        ]);
      }
      if (compact) {
        return buildSystemReminder("PEER SYNC REMINDER", [
          ...section("STATE", [
            "SDD drift reminder.",
            "Peer SDD document synchronization is still pending:",
            detail
          ]),
          ...section("REQUIRED ACTION", [
            "For listed peer files, read them first and edit/write only what is needed. If a listed file disappeared, do not recreate it unless the current user request explicitly needs that stage."
          ]),
          ...section("EXIT CRITERIA", resumeOriginalTaskRules())
        ]);
      }
      return buildSystemReminder("PEER SYNC CHECKPOINT", [
        ...section("STATE", [
          "SDD drift tool result enforcement.",
          "The preceding tool changed SDD change document(s), but peer document(s) are still unsynchronized:",
          detail
        ]),
        ...section("REQUIRED ACTION", [
          "This assistant turn is incomplete until the required peer document(s) are synchronized.",
          "Before any final answer, read each listed required peer file, then use edit or write to synchronize it with the edited SDD change document(s). If a listed file disappeared, do not recreate it unless the current user request explicitly needs that stage."
        ]),
        ...section("SDD EDIT RULES", documentSyncRules()),
        ...section("EXIT CRITERIA", [
          ...resumeOriginalTaskRules(),
          "Do not stop or summarize completion until the required peer document(s) are updated."
        ])
      ]);
    };
    var formatCodeReviewTargets = (cwd, files) => files.map((file) => rel(cwd, file)).join(", ");
    var buildCodeEnforcement = (cwd, gaps, options = {}) => {
      const compact = Boolean(options.compact);
      const detail = gaps.map((gap) => {
        const codeList = gap.codeFiles.map((file) => rel(cwd, file)).join(", ");
        const reviewList = formatCodeReviewTargets(cwd, gap.reviewTargets || []);
        const pendingTargets = gap.pendingReviewTargets || gap.reviewTargets || [];
        const pendingList = pendingTargets.length ? formatCodeReviewTargets(cwd, pendingTargets) : "none; final review confirmation marker is pending";
        return `- changed code file(s) [${codeList}]. Review SDD document(s): ${reviewList}. Still needs review: ${pendingList}`;
      }).join("\n");
      if (compact) {
        return buildSystemReminder("CODE REVIEW REMINDER", [
          ...section("STATE", [
            "SDD drift tool result enforcement.",
            "SDD drift reminder: implementation code still has pending SDD review for this code-change batch:",
            detail
          ]),
          ...section("REQUIRED ACTION", [
            "Before the final answer, read/review the listed design.md and tasks.md files, then update only the documents that actually need changes.",
            "If review shows no SDD document needs changes, leave the files unchanged; do not create a no-op edit just to satisfy this hook.",
            subagentReviewRule()
          ]),
          ...section("SDD EDIT RULES", [
            "If you edit an SDD document, preserve its existing Markdown headings and template; do not replace it with a summary or single-line marker.",
            ...documentSyncRules()
          ]),
          ...section("ALIGNMENT RULES", [
            ...activeSddAlignmentRules(),
            ...attributionReviewRules()
          ]),
          ...section("EXIT CRITERIA", [
            "After both documents have been reviewed, resume the original user task if anything remains; finish only if the original task is already complete.",
            ...resumeOriginalTaskRules()
          ])
        ]);
      }
      return buildSystemReminder("CODE REVIEW CHECKPOINT", [
        ...section("STATE", [
          "SDD drift tool result enforcement.",
          "The preceding tool changed implementation code. SDD reconciliation review is now pending for this code-change batch:",
          detail,
          "This is a deferred review checkpoint, not an instruction to stop coding immediately."
        ]),
        ...section("REQUIRED ACTION", [
          "Continue implementation work if more code changes are still required.",
          "When the implementation for this task is complete, and before any final answer, use the read tool to review the relevant design.md and tasks.md files.",
          "After review, update active SDD document(s) whenever they no longer match the implemented code. Optimization and refactor work can still require SDD updates.",
          "If no SDD document needs changes, do not create a no-op edit. In the final answer, say that SDD docs were reviewed and no document edit was needed, so the user can confirm that decision if they expected documentation changes.",
          "If the listed path contains <change-id>, choose or create the correct sdd/changes/<change-id>/ document path for this code change.",
          subagentReviewRule()
        ]),
        ...section("SDD EDIT RULES", [
          ...documentSyncRules(),
          "Do not create a no-op edit or add a new section just to satisfy this hook."
        ]),
        ...section("ALIGNMENT RULES", [
          ...activeSddAlignmentRules(),
          ...attributionReviewRules()
        ]),
        ...section("EXIT CRITERIA", [
          ...resumeOriginalTaskRules(),
          "Do not give the final answer while this code-change batch still has unreviewed SDD documents."
        ])
      ]);
    };
    var buildCodeToolReminder = (cwd, gaps) => {
      const detail = gaps.map((gap) => {
        const codeList = gap.codeFiles.map((file) => rel(cwd, file)).join(", ");
        const reviewList = formatCodeReviewTargets(cwd, gap.reviewTargets || []);
        return `- changed code file(s) [${codeList}]. Review before final answer: ${reviewList}`;
      }).join("\n");
      return buildSystemReminder("CODE REVIEW NOTICE", [
        ...section("STATE", [
          "SDD drift code review noted.",
          "Implementation code changed, so SDD review will be required before the final answer.",
          detail
        ]),
        ...section("REQUIRED ACTION", [
          "Do not stop coding just because this reminder appeared. If more implementation, verification, cleanup, or requested edits remain, continue the original task now.",
          "When the implementation batch is complete, and before final answer or before asking the user what to do next, read/review the listed active design.md and tasks.md files.",
          "Update only the SDD documents that are stale; if no document needs changes, leave them unchanged and say which files you reviewed.",
          subagentReviewRule()
        ]),
        ...section("EXIT CRITERIA", resumeOriginalTaskRules())
      ]);
    };
    var serializablePeerGap = (gap) => ({
      relDir: gap.relDir,
      edited: [...gap.edited || []].sort(),
      sourceFiles: [...gap.sourceFiles || []].sort(),
      stageOnly: Boolean(gap.stageOnly),
      absent: [...gap.absent || []].sort(),
      unsynced: [...gap.unsynced || []].sort(),
      stale: [...gap.stale || []].sort(),
      required: [...gap.required || []].sort()
    });
    var serializableCodeGap = (cwd, gap) => ({
      codeFiles: (gap.codeFiles || []).map((file) => rel(cwd, file)).sort(),
      latestCodeSeq: gap.latestCodeSeq || 0,
      reviewTargets: (gap.reviewTargets || []).map((file) => rel(cwd, file)).sort(),
      pendingReviewTargets: (gap.pendingReviewTargets || []).map((file) => rel(cwd, file)).sort(),
      reviewReady: Boolean(gap.reviewReady),
      needsConfirmation: Boolean(gap.needsConfirmation)
    });
    var peerDriftSignature = (peerGaps) => hash(JSON.stringify({ type: "peer", gaps: peerGaps.map(serializablePeerGap) }));
    var buildSubagentCheckpointEnforcement = (cwd, state, project = null) => {
      const hardPeerGaps = collectCombinedPeerGaps(cwd, state, project, { includeStageOnly: false });
      if (hardPeerGaps.length) {
        return {
          type: "peer",
          signature: hash(JSON.stringify({ type: "subagent-peer", gaps: hardPeerGaps.map(serializablePeerGap) })),
          message: buildToolEnforcement(hardPeerGaps, { compact: true })
        };
      }
      const pendingCodeGaps = collectCombinedCodeGaps(cwd, state, project).filter((gap) => !gap.reviewReady);
      if (pendingCodeGaps.length) {
        return {
          type: "code",
          signature: hash(
            JSON.stringify({
              type: "subagent-code",
              gaps: pendingCodeGaps.map((gap) => serializableCodeGap(cwd, gap))
            })
          ),
          message: buildCodeEnforcement(cwd, pendingCodeGaps, { compact: true })
        };
      }
      return null;
    };
    var buildQuestionCheckpointMessage = (message) => buildSystemReminder("QUESTION CHECKPOINT", [
      ...section("STATE", [
        "SDD drift question checkpoint.",
        "The assistant is about to ask the user a question or hand control back while SDD synchronization or review is still pending."
      ]),
      ...section("REQUIRED ACTION", [
        "Do not ask about commit, next action, or whether to continue before resolving the SDD reminder below.",
        "Continue the current turn now and handle the pending SDD work first.",
        "After the pending SDD work is resolved, return to the original user task from where you paused; do not treat this checkpoint itself as task completion."
      ]),
      ...section("EXIT CRITERIA", resumeOriginalTaskRules()),
      ...section("PENDING SDD REMINDER", [stripSystemReminderWrapper(message)])
    ]);
    var buildQuestionCheckpointEnforcement = (cwd, state, project = null) => {
      const hardPeerGaps = collectCombinedPeerGaps(cwd, state, project, { includeStageOnly: false });
      if (hardPeerGaps.length) {
        return {
          type: "peer",
          signature: hash(JSON.stringify({ type: "question-peer", gaps: hardPeerGaps.map(serializablePeerGap) })),
          message: buildQuestionCheckpointMessage(buildToolEnforcement(hardPeerGaps, { compact: true }))
        };
      }
      const pendingCodeGaps = collectCombinedCodeGaps(cwd, state, project).filter((gap) => !gap.reviewReady);
      if (pendingCodeGaps.length) {
        return {
          type: "code",
          signature: hash(
            JSON.stringify({
              type: "question-code",
              gaps: pendingCodeGaps.map((gap) => serializableCodeGap(cwd, gap))
            })
          ),
          message: buildQuestionCheckpointMessage(buildCodeEnforcement(cwd, pendingCodeGaps, { compact: true }))
        };
      }
      return null;
    };
    var buildPendingEnforcement = (cwd, state, options = {}) => {
      const project = options.project || null;
      const peerGaps = collectCombinedPeerGaps(cwd, state, project, {
        includeStageOnly: options.includeStageOnly !== false
      });
      if (peerGaps.length) {
        return {
          type: "peer",
          message: buildToolEnforcement(peerGaps),
          signature: peerDriftSignature(peerGaps)
        };
      }
      const codeGaps = collectCombinedCodeGaps(cwd, state, project);
      if (codeGaps.length) {
        return {
          type: "code",
          message: buildCodeEnforcement(cwd, codeGaps),
          signature: hash(JSON.stringify({ type: "code", gaps: codeGaps.map((gap) => serializableCodeGap(cwd, gap)) })),
          gaps: codeGaps
        };
      }
      return null;
    };
    var buildStopEnforcement = (pendingMessage) => buildSystemReminder("STOP ENFORCEMENT", [
      ...section("STATE", [
        "SDD drift stop enforcement.",
        "The assistant attempted to stop while required SDD synchronization or review is still missing."
      ]),
      ...section("PENDING SDD REMINDER", [stripSystemReminderWrapper(pendingMessage)]),
      ...section("REQUIRED ACTION", [
        "Continue the current task now. Do not ask the user for permission to continue.",
        "For code-review gaps, read/review the listed SDD document(s), then update only the files that actually need changes.",
        "For peer-sync gaps, use read, then edit or write, to synchronize the listed SDD document(s) before trying to stop again."
      ]),
      ...section("EXIT CRITERIA", [
        "After the required SDD work is resolved, resume the original user task if anything remains; do not stop only because the SDD checkpoint is resolved.",
        "If those documents have already been reviewed and no edit is needed, stop again with a concise final answer; the hook will record the review confirmation marker."
      ])
    ]);
    var formatCarryOverReminder = (project, options = {}) => {
      const driftDirs = collectCarryOverDrift(project);
      if (!driftDirs.length) return "";
      return buildSystemReminder("CARRY-OVER DRIFT", [
        ...section("STATE", [
          `${options.prefix || ""}SDD carry-over drift from prior sessions:`,
          ...driftDirs.map((dir) => `- ${dir.relDir}: ${dir.state}`)
        ]),
        ...section("REQUIRED ACTION", [
          "Before final answer, review these active SDD change directories and synchronize design.md/tasks.md with the implementation if needed.",
          subagentReviewRule()
        ])
      ]);
    };
    var buildPreCompactSummary = (cwdOrProject, stateOrNull = null, projectOrNull = null) => {
      const legacyCall = typeof cwdOrProject !== "string";
      const cwd = legacyCall ? "" : cwdOrProject;
      const state = legacyCall ? null : stateOrNull;
      const project = legacyCall ? cwdOrProject : projectOrNull;
      const driftDirs = collectCarryOverDrift(project);
      const pending = cwd && state ? buildQuestionCheckpointEnforcement(cwd, state, project) : null;
      const checkpointActive = Boolean(pending?.signature) && state?.subagentCheckpointNotice?.active && state.subagentCheckpointNotice.signature === pending.signature;
      if (!driftDirs.length && !checkpointActive) return "";
      if (checkpointActive) {
        return buildSystemReminder("COMPACTION CHECKPOINT RECOVERY", [
          ...section("STATE", [
            "SDD drift checkpoint preserved across compaction:",
            "Before compaction, the assistant was blocked from asking the user or handing control back because SDD synchronization/review was pending.",
            ...driftDirs.length ? [
              "Active SDD change-dir states:",
              ...driftDirs.slice(0, 20).map((dir) => `- ${dir.relDir}: ${dir.state}`)
            ] : []
          ]),
          ...section("REQUIRED ACTION", [
            "After compaction resumes, handle this SDD work first, then return to the original user task from where it was interrupted."
          ]),
          ...section("EXIT CRITERIA", resumeOriginalTaskRules()),
          ...section("PENDING SDD REMINDER", [stripSystemReminderWrapper(pending.message)])
        ]);
      }
      return buildSystemReminder("COMPACTION DRIFT SUMMARY", [
        ...section("STATE", [
          "SDD drift summary preserved across compaction:",
          ...driftDirs.slice(0, 20).map((dir) => `- ${dir.relDir}: ${dir.state}`)
        ]),
        ...section("REQUIRED ACTION", [
          "After compaction resumes, review these active SDD change directories before final answer and synchronize design.md/tasks.md with the implementation if needed."
        ]),
        ...section("EXIT CRITERIA", resumeOriginalTaskRules())
      ]);
    };
    module2.exports = {
      buildAttributionReviewPrompt,
      buildCodeEnforcement,
      buildCodeToolReminder,
      buildPendingEnforcement,
      buildPreCompactSummary,
      buildQuestionCheckpointEnforcement,
      buildQuestionCheckpointMessage,
      buildStopEnforcement,
      buildSubagentCheckpointEnforcement,
      buildToolEnforcement,
      formatCarryOverReminder,
      formatCodeReviewTargets,
      formatGap,
      peerDriftSignature,
      serializableCodeGap,
      serializablePeerGap
    };
  }
});

// src/core/report.js
var require_report = __commonJS({
  "src/core/report.js"(exports2, module2) {
    var fs = require("fs");
    var path2 = require("path");
    var { collectCombinedCodeGaps, collectCombinedPeerGaps } = require_drift_engine();
    var { rel } = require_paths();
    var { formatGap } = require_prompts();
    var { editedSddSeqAfter } = require_session_state();
    var { writeTextAtomic } = require_state_storage();
    var confirmationStillNeedsHumanReview = (state, confirmation) => !editedSddSeqAfter(state, confirmation?.reviewTargets || [], Number(confirmation?.codeSeq || 0));
    var collectCodeReviewAdvisoryLines = (cwd, state) => Object.values(state.codeReviewConfirmations || {}).filter((confirmation) => confirmation?.confirmed && confirmation?.userConfirmationRecommended).filter((confirmation) => confirmationStillNeedsHumanReview(state, confirmation)).sort((left, right) => {
      const leftSeq = Number(left.codeSeq || 0);
      const rightSeq = Number(right.codeSeq || 0);
      return rightSeq - leftSeq;
    }).map((confirmation) => {
      const codeList = (confirmation.codeFiles || []).map((file) => rel(cwd, file)).join(", ");
      const reviewList = (confirmation.reviewTargets || []).map((file) => rel(cwd, file)).join(", ");
      return `  - reviewed SDD document(s) after code change(s) [${codeList || "unknown"}] and made no SDD edits. User confirmation recommended for: ${reviewList || "design.md, tasks.md"}`;
    });
    var collectReportLines = (cwd, state, project = null) => {
      const lines = collectCombinedPeerGaps(cwd, state, project, { includeStageOnly: false }).map(
        (gap) => `  - ${formatGap(gap)}`
      );
      for (const gap of collectCombinedCodeGaps(cwd, state, project)) {
        const codeList = gap.codeFiles.map((file) => rel(cwd, file)).join(", ");
        const reviewList = (gap.pendingReviewTargets || gap.reviewTargets || []).map((file) => rel(cwd, file)).join(", ");
        lines.push(
          `  - edited code file(s) [${codeList}], but did not review SDD document(s) after the code change: ${reviewList}`
        );
      }
      lines.push(...collectCodeReviewAdvisoryLines(cwd, state));
      return lines;
    };
    var refreshReport = (cwd, state, project = null) => {
      const reportPath = path2.join(cwd, ".sdd-drift-report.md");
      const lines = collectReportLines(cwd, state, project);
      if (lines.length) {
        try {
          const body = lines.join("\n") + "\n";
          try {
            const existing = fs.readFileSync(reportPath, "utf8");
            if (existing.replace(/^## .*\r?\n/, "") === body) return;
          } catch {
          }
          writeTextAtomic(reportPath, "## " + (/* @__PURE__ */ new Date()).toISOString() + "\n" + body);
        } catch {
        }
        return;
      }
      try {
        fs.unlinkSync(reportPath);
      } catch {
      }
    };
    module2.exports = {
      collectCodeReviewAdvisoryLines,
      collectReportLines,
      confirmationStillNeedsHumanReview,
      refreshReport
    };
  }
});

// src/core/output.js
var require_output = __commonJS({
  "src/core/output.js"(exports2, module2) {
    var createOutputHelpers = ({
      isOpenCodeHookInput,
      opencodeStopReportOnly = false,
      strictBlock = false,
      stdout = process.stdout,
      stderr = process.stderr,
      exit = process.exit
    } = {}) => {
      if (typeof isOpenCodeHookInput !== "function") {
        throw new TypeError("isOpenCodeHookInput is required");
      }
      const buildClaudeCodeOutput = (hookEventName, message) => JSON.stringify({
        hookSpecificOutput: {
          hookEventName: hookEventName || "PostToolUse",
          additionalContext: message
        }
      });
      const buildPreToolUseDenyOutput = (message) => JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: message,
          additionalContext: message
        }
      });
      const buildStopOutput = (input, message) => {
        if (isOpenCodeHookInput(input)) {
          if (opencodeStopReportOnly) {
            return JSON.stringify({
              decision: "approve",
              stop_hook_active: false,
              sdd_drift_report_only: true
            });
          }
          return JSON.stringify({
            decision: "block",
            reason: "SDD drift check found pending SDD synchronization or review. Attempting OpenCode Stop continuation; see .sdd-drift-report.md if the session does not continue.",
            inject_prompt: message,
            stop_hook_active: true
          });
        }
        return JSON.stringify({
          decision: "block",
          reason: message
        });
      };
      const emitEnforcement = (input, message) => {
        if (strictBlock) {
          stderr.write(message);
          exit(2);
          return;
        }
        if (input?.hook_event_name === "PreToolUse") {
          stdout.write(buildPreToolUseDenyOutput(message));
          return;
        }
        if (isOpenCodeHookInput(input)) {
          stdout.write(message);
          return;
        }
        stdout.write(buildClaudeCodeOutput(input?.hook_event_name, message));
      };
      const emitStopEnforcement = (input, message) => {
        if (strictBlock) {
          stderr.write(message);
          exit(2);
          return;
        }
        stdout.write(buildStopOutput(input, message));
      };
      return {
        buildClaudeCodeOutput,
        buildPreToolUseDenyOutput,
        buildStopOutput,
        emitEnforcement,
        emitStopEnforcement
      };
    };
    module2.exports = {
      createOutputHelpers
    };
  }
});

// src/adapters/claude-code/command-hook.js
var require_command_hook = __commonJS({
  "src/adapters/claude-code/command-hook.js"(exports2, module2) {
    var crypto = require("crypto");
    var fs = require("fs");
    var path2 = require("path");
    var { Actions, runActions } = require_actions();
    var { HookHandlers, createHookHandlers } = require_dispatcher();
    var { handlePreCompact } = require_pre_compact();
    var { handlePostToolUse } = require_post_tool_use();
    var { handlePreToolUse } = require_pre_tool_use();
    var { handleStop } = require_stop();
    var { handleUserPromptSubmit } = require_user_prompt_submit();
    var { readStdin } = require_stdin();
    var {
      getToolFilePath,
      isQuestionCheckpointTool,
      isSubagentCheckpointTool,
      normalizeToolName: normalizeCheckpointToolName
    } = require_tool_events();
    var {
      collectCheckpointOutputText,
      extractCheckpointEditedPaths,
      hydrateStateFromCheckpointMtime,
      hydrateStateFromCheckpointOutput,
      hydrateStateFromTranscript,
      resolveTranscriptPath
    } = require_hydration();
    var { normalizeKey, rel, resolveFile, samePath, toPosix } = require_paths();
    var { Attribution } = require_attribution();
    var { isCodePath, isSddPath } = require_file_classifier();
    var { acquireFileLock, releaseFileLock } = require_locks();
    var {
      cleanupDiagnosticLogs,
      recordDiagnosticSummaryEvent,
      writeDiagnosticLog
    } = require_diagnostics();
    var {
      diagnosticLogPath,
      projectStatePath,
      statePath
    } = require_state_storage();
    var {
      applyToolRecord,
      clearPeerSyncs,
      clearStageOnlyRequirements,
      editedSeq,
      emptyState,
      getPeerSyncBucket,
      hasEditedSddChange,
      loadState,
      markToolEvent,
      pruneStateFiles,
      recordFile,
      saveState,
      touchedSeq,
      updateRequirementsForEdit
    } = require_session_state();
    var {
      collectActiveChangeDirs,
      collectCarryOverDrift,
      computeProjectConditions,
      computeProjectState,
      createChangeDirFromFs,
      discoverChangeDirs,
      docKeyForFile,
      emptyProjectState,
      ensureProjectChangeDirs,
      eventMsForFileRecord,
      loadProjectState,
      normalizeProjectState,
      recomputeProjectState,
      refreshAlignedBaseline,
      relDirForProject,
      saveProjectState
    } = require_project_state();
    var {
      codeReviewSignature,
      collectCodeGaps,
      collectCombinedCodeGaps,
      collectCombinedPeerGaps,
      collectPeerGaps,
      collectProjectCodeGaps,
      collectProjectPeerGaps,
      collectReviewTargets,
      drift,
      isDtsContextActive,
      markCodeReviewNoEditConfirmation
    } = require_drift_engine();
    var {
      buildAttributionReviewPrompt,
      buildCodeEnforcement,
      buildCodeToolReminder,
      buildPendingEnforcement,
      buildPreCompactSummary,
      buildQuestionCheckpointEnforcement,
      buildStopEnforcement,
      buildSubagentCheckpointEnforcement,
      buildToolEnforcement,
      formatCarryOverReminder,
      peerDriftSignature,
      serializableCodeGap
    } = require_prompts();
    var {
      collectReportLines,
      refreshReport
    } = require_report();
    var { createOutputHelpers } = require_output();
    var {
      ATTRIBUTION_REVIEW_RULES,
      DESIGN_FILE,
      PROPOSAL_FILE,
      TASKS_FILE,
      findSdd,
      getChangeDoc,
      hasSddWorkspace,
      isArchivedChangeDir
    } = require_sdd_rules();
    var {
      ACTIVE_CHANGE_DIR_TTL_MS,
      CIRCUIT_COOLDOWN_MS,
      CIRCUIT_MAX_FAILURES,
      CODE_REVIEW_STOP_MAX_BLOCKS,
      CODE_REVIEW_TOOL_MAX_REMINDERS,
      CODE_REVIEW_TOOL_SESSION_MAX_REMINDERS,
      DEBUG,
      DTS_CONTEXT_OVERRIDE,
      DTS_CONTEXT_SKIP,
      DTS_CONTEXT_TEXT_MAX_BYTES,
      OPENCODE_STOP_REPORT_ONLY,
      OUTPUT_MODE,
      PROJECT_LINKED_CODE_CAP,
      PROJECT_LOCK_WAIT_MS,
      SHOW_WARNINGS,
      STATE_LOCK_RETRY_MS,
      STATE_LOCK_STALE_MS,
      STATE_LOCK_WAIT_MS,
      STDIN_TIMEOUT_MS,
      STOP_MAX_BLOCKS,
      STRICT_BLOCK
    } = require_runtime_config();
    var DTS_CONTEXT_PATTERNS = [
      /\bDTS[-_\s]?\d{4,}\b/i,
      /\bDTS-\d+\b/,
      /\bDTS\b/,
      /dts\s*(问题单|工单|缺陷单|缺陷|bug|issue|ticket)/i,
      /(问题单|工单|缺陷单|缺陷|issue\s+ticket|bug\s+ticket|ticket).{0,30}dts/i,
      /(DTS|问题单|工单|缺陷单|缺陷|issue\s+ticket|bug\s+ticket|ticket).{0,40}(修复|修改|处理|解决|fix|resolve|repair|patch|handle|address)/i,
      /(修复|修改|处理|解决|fix|resolve|repair|patch|handle|address).{0,40}(DTS|问题单|工单|缺陷单|缺陷|issue\s+ticket|bug\s+ticket|ticket)/i,
      /dts\s*(问题单|单|工单|缺陷|bug|issue|ticket)/i,
      /(问题单|工单|缺陷单|缺陷|issue\s+ticket|bug\s+ticket|ticket).{0,30}dts/i
    ];
    var DTS_CONTEXT_NEGATION_PATTERNS = [
      /(不是|非|无需|不要|不属于)\s*(DTS|问题单|工单|缺陷单|缺陷|issue\s+ticket|bug\s+ticket|ticket)/i,
      /(DTS|问题单|工单|缺陷单|缺陷|issue\s+ticket|bug\s+ticket|ticket).{0,10}(不是|非|无需|不要|不属于)/i,
      /\bnot\s+(?:a\s+)?(?:DTS|issue\s+ticket|bug\s+ticket|ticket)\b/i,
      /(不是|非|无需|不要|不属于)\s*DTS/i,
      /DTS.{0,10}(不是|非|无需|不要|不属于)/i,
      /\bnot\s+(?:a\s+)?DTS\b/i
    ];
    var parseHookInput = (raw) => JSON.parse(String(raw || "{}").replace(/^\uFEFF/, ""));
    var hash = (value) => crypto.createHash("sha1").update(String(value)).digest("hex").slice(0, 12);
    var limitString = (value, max = 500) => {
      const text = String(value || "");
      return text.length > max ? `${text.slice(0, max)}...` : text;
    };
    var summarizeInput = (input) => ({
      hook_event_name: input?.hook_event_name || null,
      hook_source: input?.hook_source || null,
      session_id: input?.session_id || null,
      tool_name: input?.tool_name || null,
      tool_use_id: input?.tool_use_id || input?.toolUseId || null,
      cwd: input?.cwd || null
    });
    var summarizeGaps = (cwd, peerGaps, codeGaps) => ({
      peerGapCount: peerGaps.length,
      codeGapCount: codeGaps.length,
      peerGaps: peerGaps.map((gap) => ({
        relDir: gap.relDir,
        required: gap.required,
        stageOnly: Boolean(gap.stageOnly),
        sourceFiles: gap.sourceFiles || [],
        absent: gap.absent,
        unsynced: gap.unsynced,
        stale: gap.stale
      })),
      codeGaps: codeGaps.map((gap) => ({
        codeFiles: (gap.codeFiles || []).map((file) => rel(cwd, file)),
        pendingReviewTargets: (gap.pendingReviewTargets || []).map((file) => rel(cwd, file)),
        reviewReady: Boolean(gap.reviewReady),
        needsConfirmation: Boolean(gap.needsConfirmation)
      }))
    });
    var circuitMaxFailures = () => Number.isFinite(CIRCUIT_MAX_FAILURES) ? Math.max(1, CIRCUIT_MAX_FAILURES) : 5;
    var circuitCooldownMs = () => Number.isFinite(CIRCUIT_COOLDOWN_MS) ? Math.max(1, CIRCUIT_COOLDOWN_MS) : 60 * 1e3;
    var CircuitBreaker = {
      isOpen(state, hookName, now = Date.now()) {
        const bucket = state?.circuitBreaker?.[hookName];
        return Boolean(bucket && Number(bucket.openUntilMs || 0) > now);
      },
      recordFailure(state, hookName, now = Date.now()) {
        if (!state?.circuitBreaker || !hookName) return false;
        const bucket = state.circuitBreaker[hookName] || { failures: 0, openUntilMs: 0 };
        bucket.failures = Number(bucket.failures || 0) + 1;
        let opened = false;
        if (bucket.failures >= circuitMaxFailures()) {
          bucket.failures = 0;
          bucket.openUntilMs = now + circuitCooldownMs();
          bucket.openedAt = new Date(now).toISOString();
          opened = true;
        }
        state.circuitBreaker[hookName] = bucket;
        return opened;
      },
      recordSuccess(state, hookName) {
        const bucket = state?.circuitBreaker?.[hookName];
        if (!bucket) return false;
        const changed = Number(bucket.failures || 0) !== 0 || Number(bucket.openUntilMs || 0) !== 0;
        bucket.failures = 0;
        bucket.openUntilMs = 0;
        delete bucket.openedAt;
        return changed;
      }
    };
    var isDtsContextText = (text) => {
      const value = String(text || "");
      if (!value.trim()) return false;
      if (DTS_CONTEXT_NEGATION_PATTERNS.some((pattern) => pattern.test(value))) return false;
      return DTS_CONTEXT_PATTERNS.some((pattern) => pattern.test(value));
    };
    var dtsOverrideActive = () => {
      if (!DTS_CONTEXT_SKIP) return false;
      if (["1", "true", "yes", "on"].includes(DTS_CONTEXT_OVERRIDE)) return true;
      if (["0", "false", "no", "off"].includes(DTS_CONTEXT_OVERRIDE)) return false;
      return null;
    };
    var collectInputContextStrings = (value, key = "", depth = 0) => {
      if (depth > 6 || value == null) return [];
      const normalizedKey = String(key || "").toLowerCase();
      if (["tool_input", "toolinput", "old_string", "oldstring", "new_string", "newstring", "content"].includes(
        normalizedKey
      )) {
        return [];
      }
      if (typeof value === "string") {
        if (!normalizedKey || /prompt|message|context|instruction|request|description|summary|title|user|input/.test(
          normalizedKey
        )) {
          return [value];
        }
        return [];
      }
      if (Array.isArray(value)) {
        return value.flatMap((item) => collectInputContextStrings(item, key, depth + 1));
      }
      if (typeof value !== "object") return [];
      const strings = [];
      const userText = value.role === "user" ? contentText(value.content) : value.type === "user" ? contentText(value.content || value.message?.content) : value.message?.role === "user" ? contentText(value.message.content) : "";
      if (userText.trim()) strings.push(userText);
      for (const [childKey, childValue] of Object.entries(value)) {
        strings.push(...collectInputContextStrings(childValue, childKey, depth + 1));
      }
      return strings;
    };
    var contentText = (content) => {
      if (typeof content === "string") return content;
      if (!Array.isArray(content)) return "";
      return content.map((part) => {
        if (typeof part === "string") return part;
        return part?.text || part?.content || part?.value || "";
      }).filter(Boolean).join("\n");
    };
    var transcriptUserText = (entry) => {
      if (!entry || typeof entry !== "object") return "";
      if (entry.role === "user") return contentText(entry.content);
      if (entry.type === "user") return contentText(entry.content || entry.message?.content);
      if (entry.message?.role === "user") return contentText(entry.message.content);
      return "";
    };
    var readLastTranscriptUserText = (transcriptPath) => {
      if (!transcriptPath || typeof transcriptPath !== "string") return "";
      let content = "";
      try {
        const stat = fs.statSync(transcriptPath);
        const start = Math.max(0, stat.size - DTS_CONTEXT_TEXT_MAX_BYTES);
        const fd = fs.openSync(transcriptPath, "r");
        const buffer = Buffer.alloc(stat.size - start);
        fs.readSync(fd, buffer, 0, buffer.length, start);
        fs.closeSync(fd);
        content = buffer.toString("utf8");
      } catch {
        return "";
      }
      let lastUserText = "";
      for (const line of content.split(/\r?\n/)) {
        if (!line.trim()) continue;
        try {
          const text = transcriptUserText(JSON.parse(line));
          if (text.trim()) lastUserText = text;
        } catch {
        }
      }
      return lastUserText;
    };
    var setDtsContext = (state, source, text) => {
      state.dtsContext = {
        active: true,
        source,
        evidenceHash: hash(text),
        detectedAt: (/* @__PURE__ */ new Date()).toISOString()
      };
      return true;
    };
    var updateDtsContextFromInput = (state, input, transcriptPath) => {
      if (!DTS_CONTEXT_SKIP) {
        state.dtsContext = null;
        return false;
      }
      const override = dtsOverrideActive();
      if (override === true) return setDtsContext(state, "env", "SDD_DRIFT_DTS_CONTEXT");
      if (override === false && DTS_CONTEXT_OVERRIDE) {
        state.dtsContext = null;
        return false;
      }
      const inputText = collectInputContextStrings(input).join("\n");
      if (isDtsContextText(inputText)) return setDtsContext(state, "hook-input", inputText);
      const transcriptText = readLastTranscriptUserText(transcriptPath);
      if (isDtsContextText(transcriptText)) return setDtsContext(state, "transcript", transcriptText);
      return Boolean(state.dtsContext?.active);
    };
    var getToolEventKey = (input) => {
      const id = input?.tool_use_id || input?.toolUseId;
      if (typeof id === "string" && id.trim()) {
        return `${input.session_id || "default"}:${input.hook_event_name || ""}:${id.trim()}`;
      }
      return null;
    };
    var attributionReviewSignature = (cwd, codeFiles, candidates) => hash(
      JSON.stringify({
        type: "attribution-review",
        codeFiles: (codeFiles || []).map((file) => rel(cwd, file)).sort(),
        candidates: (candidates || []).map((dir) => dir.relDir).sort()
      })
    );
    var markAttributionReviewEmitted = (cwd, state, codeFiles, candidates) => {
      if (!state || !Array.isArray(candidates) || candidates.length === 0) return null;
      state.attributionReviews = state.attributionReviews && typeof state.attributionReviews === "object" ? state.attributionReviews : {};
      const signature = attributionReviewSignature(cwd, codeFiles, candidates);
      if (state.attributionReviews[signature]?.emittedAt) return null;
      const prompt = buildAttributionReviewPrompt(cwd, { codeFiles, candidates });
      state.attributionReviews[signature] = {
        signature,
        emittedAt: (/* @__PURE__ */ new Date()).toISOString(),
        codeFiles: (codeFiles || []).map((file) => rel(cwd, file)).sort(),
        candidates: candidates.map((dir) => dir.relDir).sort()
      };
      state.attributionReviewPrompts = [
        ...state.attributionReviewPrompts || [],
        { signature, prompt }
      ];
      return { signature, prompt };
    };
    var takeAttributionReviewPrompts = (state) => {
      const prompts = Array.isArray(state?.attributionReviewPrompts) ? state.attributionReviewPrompts : [];
      if (state) delete state.attributionReviewPrompts;
      return prompts;
    };
    var pendingAttributionReviews = (state) => Object.values(state?.attributionReviews || {}).filter((review) => !review.resolution);
    var candidateHasDir = (review, relDirValue) => (review.candidates || []).some((candidate) => toPosix(candidate) === toPosix(relDirValue));
    var resolveAttributionReviewsForDoc = (cwd, project, state, sessionID, doc, record) => {
      const reviews = pendingAttributionReviews(state);
      if (!reviews.length || !doc?.dir) return false;
      const relDirValue = relDirForProject(cwd, doc.dir);
      const edited = Number(record?.editedSeq || 0) > 0;
      const nowIso = (/* @__PURE__ */ new Date()).toISOString();
      let changed = false;
      for (const review of reviews) {
        const isCandidate = candidateHasDir(review, relDirValue);
        const isNewChangeDir = !isCandidate && project?.changeDirs?.[relDirValue];
        if (!isCandidate && !isNewChangeDir) continue;
        if (edited) {
          review.resolution = isCandidate ? "edit" : "new-change-dir";
          review.resolvedToDir = relDirValue;
          review.resolvedAt = nowIso;
          if (project) {
            project.activeChangeDir = relDirValue;
            project.activeUntilMs = Date.now() + ACTIVE_CHANGE_DIR_TTL_MS;
            project.activeLastEditedSession = sessionID;
          }
          changed = true;
        } else if (!review.partialResolution) {
          review.partialResolution = "read-only";
          review.partialResolvedToDir = relDirValue;
          review.partialResolvedAt = nowIso;
          changed = true;
        }
      }
      return changed;
    };
    var resolveReadOnlyAttributionReviews = (state) => {
      const nowIso = (/* @__PURE__ */ new Date()).toISOString();
      let changed = false;
      for (const review of pendingAttributionReviews(state)) {
        if (review.partialResolution !== "read-only") continue;
        review.resolution = "no-edit-confirmed";
        review.resolvedAt = nowIso;
        review.resolvedToDir = review.partialResolvedToDir;
        changed = true;
      }
      return changed;
    };
    var acceptUnresolvedAttributionReviews = (state) => {
      const nowIso = (/* @__PURE__ */ new Date()).toISOString();
      let changed = false;
      for (const review of pendingAttributionReviews(state)) {
        review.resolution = "unrelated";
        review.resolvedAt = nowIso;
        changed = true;
      }
      return changed;
    };
    var updateProjectDocFromRecord = (cwd, project, state, sessionID, doc, record) => {
      const relDirValue = relDirForProject(cwd, doc.dir);
      const dir = project.changeDirs[relDirValue] || createChangeDirFromFs(cwd, doc.dir);
      const key = docKeyForFile(doc.file);
      if (!key) return;
      dir.docSyncs = dir.docSyncs && typeof dir.docSyncs === "object" ? dir.docSyncs : {};
      const edited = Number(record.editedSeq || 0) > 0;
      const eventMs = eventMsForFileRecord(record, edited);
      const target = {
        ...dir.docs[key] || {},
        exists: true
      };
      if (edited) {
        if (target.lastEditedSession && eventMs <= Number(target.lastEditedMs || 0)) {
          dir.docs[key] = target;
          project.changeDirs[relDirValue] = dir;
          return;
        }
        const previousConditions = computeProjectConditions(dir);
        target.lastEditedMs = Math.max(Number(target.lastEditedMs || 0), eventMs);
        target.lastEditedSession = sessionID;
        target.lastReviewedMs = Math.max(Number(target.lastReviewedMs || 0), target.lastEditedMs);
        target.lastReviewedSession = sessionID;
        const designEdited = Number(dir.docs.design?.lastEditedMs || 0);
        const tasksEdited = Number(dir.docs.tasks?.lastEditedMs || 0);
        const designEditedInSession = key === "tasks" && editedSeq(state, path2.join(doc.dir, DESIGN_FILE)) > 0 && editedSeq(state, path2.join(doc.dir, DESIGN_FILE)) < Number(record.editedSeq || 0);
        const tasksEditedInSession = key === "design" && editedSeq(state, path2.join(doc.dir, TASKS_FILE)) > 0 && editedSeq(state, path2.join(doc.dir, TASKS_FILE)) < Number(record.editedSeq || 0);
        const sessionPeerSync = getPeerSyncBucket(state, doc.dir, false)?.files?.[doc.file];
        const sessionSyncedFromDesign = key === "tasks" && sessionPeerSync?.sourceFile === DESIGN_FILE;
        const sessionSyncedFromTasks = key === "design" && sessionPeerSync?.sourceFile === TASKS_FILE;
        const tasksWasSyncedFromPriorDesign = key === "design" && dir.docSyncs?.tasks?.sourceFile === DESIGN_FILE;
        const designWasSyncedFromPriorTasks = key === "tasks" && dir.docSyncs?.design?.sourceFile === TASKS_FILE;
        if (designWasSyncedFromPriorTasks) delete dir.docSyncs.design;
        if (tasksWasSyncedFromPriorDesign) delete dir.docSyncs.tasks;
        if (key === "tasks" && (sessionSyncedFromDesign || previousConditions.designAheadOfTasks || designEditedInSession) && !(!sessionSyncedFromDesign && designWasSyncedFromPriorTasks)) {
          dir.docSyncs.tasks = {
            sourceFile: DESIGN_FILE,
            sourceEditedMs: designEdited,
            targetEditedMs: target.lastEditedMs
          };
        } else if (key === "design" && (sessionSyncedFromTasks || previousConditions.tasksAheadOfDesign || tasksEditedInSession) && !(!sessionSyncedFromTasks && tasksWasSyncedFromPriorDesign)) {
          dir.docSyncs.design = {
            sourceFile: TASKS_FILE,
            sourceEditedMs: tasksEdited,
            targetEditedMs: target.lastEditedMs
          };
        } else {
          if (key === "tasks") delete dir.docSyncs.design;
          if (key === "design") delete dir.docSyncs.tasks;
        }
        project.activeChangeDir = relDirValue;
        project.activeUntilMs = Date.now() + ACTIVE_CHANGE_DIR_TTL_MS;
        project.activeLastEditedSession = sessionID;
      } else {
        if (target.lastReviewedSession && eventMs <= Number(target.lastReviewedMs || 0)) {
          dir.docs[key] = target;
          project.changeDirs[relDirValue] = dir;
          return;
        }
        target.lastReviewedMs = Math.max(Number(target.lastReviewedMs || 0), eventMs);
        target.lastReviewedSession = sessionID;
      }
      dir.docs[key] = target;
      project.changeDirs[relDirValue] = dir;
      resolveAttributionReviewsForDoc(cwd, project, state, sessionID, doc, record);
    };
    var getChangeDirForPath = (fp) => {
      const root = findSdd(fp);
      if (!root) return null;
      const relPath = toPosix(path2.relative(root, fp));
      const match = relPath.match(/^changes\/([^/]+)(?:\/|$)/);
      if (!match) return null;
      return {
        root,
        id: match[1],
        dir: path2.join(root, "changes", match[1]),
        rel: relPath
      };
    };
    var recordProjectArchiveAction = (cwd, project, fp) => {
      const changeDir = getChangeDirForPath(fp);
      if (!changeDir) return false;
      const relDirValue = relDirForProject(cwd, changeDir.dir);
      const dir = project.changeDirs[relDirValue] || createChangeDirFromFs(cwd, changeDir.dir);
      if (!isArchivedChangeDir(changeDir.dir)) return false;
      dir.archived = true;
      dir.conditions = computeProjectConditions(dir);
      dir.state = "ARCHIVED";
      project.changeDirs[relDirValue] = dir;
      if (project.activeChangeDir === relDirValue) {
        project.activeChangeDir = null;
        project.activeUntilMs = 0;
      }
      return true;
    };
    var collectProjectAttributionTargets = (cwd, project, state, codeFile) => {
      const decision = Attribution.decide({ cwd, session: state, project, codeFile });
      if (decision?.kind === "needs-review") {
        markAttributionReviewEmitted(cwd, state, [codeFile], decision.candidates);
        return [];
      }
      return Attribution.targetsForDecision(decision);
    };
    var appendProjectLinkedCode = (dir, cwd, record, sessionID) => {
      const relPath = rel(cwd, record.path);
      const lastEditedMs = eventMsForFileRecord(record, true);
      const existing = (dir.linkedCode || []).find((item) => samePath(path2.join(cwd, item.path), record.path));
      if (existing) {
        existing.lastEditedMs = Math.max(Number(existing.lastEditedMs || 0), lastEditedMs);
        existing.lastEditedSession = sessionID;
        return;
      }
      dir.linkedCode = [
        ...dir.linkedCode || [],
        {
          path: relPath,
          lastEditedMs,
          lastEditedSession: sessionID,
          linkedAt: lastEditedMs
        }
      ].sort((left, right) => Number(right.lastEditedMs || 0) - Number(left.lastEditedMs || 0)).slice(0, Math.max(1, PROJECT_LINKED_CODE_CAP || 200));
    };
    var applySessionToProject = (cwd, project, state, sessionID) => {
      ensureProjectChangeDirs(cwd, project);
      if (isDtsContextActive(state)) return recomputeProjectState(project, cwd);
      for (const record of Object.values(state.files || {})) {
        const fp = record?.path;
        if (!fp) continue;
        const doc = getChangeDoc(fp);
        if (doc?.dir && doc.file) {
          updateProjectDocFromRecord(cwd, project, state, sessionID, doc, record);
          continue;
        }
        if (record.editedSeq && isCodePath(fp)) {
          const targets = collectProjectAttributionTargets(cwd, project, state, fp);
          for (const dir of targets) appendProjectLinkedCode(dir, cwd, record, sessionID);
          if (targets.length === 1) {
            project.activeChangeDir = targets[0].relDir;
            project.activeUntilMs = Date.now() + ACTIVE_CHANGE_DIR_TTL_MS;
            project.activeLastEditedSession = sessionID;
          }
        }
      }
      for (const fp of state.edited || []) recordProjectArchiveAction(cwd, project, fp);
      return recomputeProjectState(project, cwd);
    };
    var carryOverSignature = (project) => hash(
      JSON.stringify(
        collectCarryOverDrift(project).map((dir) => ({
          relDir: dir.relDir,
          state: dir.state
        }))
      )
    );
    var markCarryOverNoticeEmitted = (state, project, source) => {
      const signature = carryOverSignature(project);
      state.carryOverNotice = {
        signature,
        source,
        emittedAt: (/* @__PURE__ */ new Date()).toISOString()
      };
    };
    var shouldEmitCarryOverNotice = (state, project) => {
      const driftDirs = collectCarryOverDrift(project);
      if (!driftDirs.length) return false;
      return state.carryOverNotice?.signature !== carryOverSignature(project);
    };
    var isImplementationFlowCodePending = (cwd, state, pending) => {
      if (pending?.type !== "code") return false;
      const gaps = pending.gaps || [];
      if (!gaps.length) return false;
      return gaps.every((gap) => {
        const latest = Number(gap.latestCodeSeq || 0);
        if (!latest) return false;
        const targets = gap.reviewTargets || [];
        if (!targets.length) return false;
        return targets.every((target) => {
          const seq = editedSeq(state, target);
          return seq > 0 && seq < latest;
        });
      });
    };
    var markImplementationFlowConfirmation = (cwd, state, pending, project = null) => {
      if (!isImplementationFlowCodePending(cwd, state, pending)) return false;
      const nowMs = Date.now() * 1e3;
      for (const gap of pending.gaps || []) {
        const signature = gap.reviewSignature || codeReviewSignature(cwd, gap);
        if (!signature) continue;
        state.codeReviewConfirmations[signature] = {
          confirmed: true,
          confirmedAt: (/* @__PURE__ */ new Date()).toISOString(),
          codeSeq: gap.latestCodeSeq || 0,
          codeFiles: gap.codeFiles || [],
          reviewTargets: gap.reviewTargets || [],
          implementationFlow: true,
          userConfirmationRecommended: false
        };
        if (project) {
          const relDirs = new Set(
            (gap.reviewTargets || []).map((file) => getChangeDirForPath(file)).filter(Boolean).map((changeDir) => relDirForProject(cwd, changeDir.dir))
          );
          for (const relDirValue of relDirs) {
            const dir = project.changeDirs?.[relDirValue];
            if (!dir) continue;
            dir.alignedAtMs = Math.max(Number(dir.alignedAtMs || 0), Number(gap.latestCodeMs || 0), nowMs);
            dir.alignedAt = (/* @__PURE__ */ new Date()).toISOString();
          }
        }
      }
      if (project) recomputeProjectState(project, cwd);
      return true;
    };
    var clearCodeDriftNoticeIfResolved = (state, codeGaps) => {
      if (codeGaps.length) return;
      state.codeDriftNotice = null;
    };
    var clearPeerDriftNoticeIfResolved = (state, peerGaps) => {
      if (peerGaps.length) return;
      state.peerDriftNotice = null;
    };
    var clearSubagentCheckpointNoticeIfResolved = (state, pending) => {
      if (pending) return;
      state.subagentCheckpointNotice = null;
    };
    var markPeerDriftNoticeEmitted = (state, peerGaps) => {
      if (!peerGaps.length) return;
      state.peerDriftNotice = {
        active: true,
        signature: peerDriftSignature(peerGaps),
        emittedAt: (/* @__PURE__ */ new Date()).toISOString()
      };
    };
    var codeReviewToolMaxReminders = () => {
      if (!Number.isFinite(CODE_REVIEW_TOOL_MAX_REMINDERS)) return 1;
      return Math.max(0, CODE_REVIEW_TOOL_MAX_REMINDERS);
    };
    var codeReviewToolSessionMaxReminders = () => {
      if (!Number.isFinite(CODE_REVIEW_TOOL_SESSION_MAX_REMINDERS)) return 1;
      return Math.max(0, CODE_REVIEW_TOOL_SESSION_MAX_REMINDERS);
    };
    var codeDriftNoticeEmissionCount = (state) => Math.max(0, Number(state.codeDriftNotice?.emissionCount || 0));
    var codeDriftToolSessionEmissionCount = (state) => Math.max(0, Number(state.codeDriftToolNotice?.emissionCount || 0));
    var hasPendingCodeReview = (codeGaps) => codeGaps.some((gap) => !gap.reviewReady);
    var shouldEmitCodeDriftNotice = (state, codeGaps) => {
      if (!hasPendingCodeReview(codeGaps)) return false;
      const maxReminders = codeReviewToolMaxReminders();
      if (maxReminders === 0) return false;
      const sessionMaxReminders = codeReviewToolSessionMaxReminders();
      if (sessionMaxReminders === 0) return false;
      if (codeDriftToolSessionEmissionCount(state) >= sessionMaxReminders) return false;
      if (!state.codeDriftNotice?.active) return true;
      return codeDriftNoticeEmissionCount(state) < maxReminders;
    };
    var isCodeDriftNoticeSuppressed = (state, codeGaps) => hasPendingCodeReview(codeGaps) && (Boolean(state.codeDriftNotice?.active) && codeDriftNoticeEmissionCount(state) >= codeReviewToolMaxReminders() || codeDriftToolSessionEmissionCount(state) >= codeReviewToolSessionMaxReminders());
    var markCodeDriftNoticeEmitted = (cwd, state, codeGaps) => {
      if (!codeGaps.length) return;
      const existing = state.codeDriftNotice || {};
      state.codeDriftNotice = {
        ...existing,
        active: true,
        firstCodeSeq: existing.firstCodeSeq || codeGaps[0].latestCodeSeq || 0,
        latestCodeSeq: codeGaps[0].latestCodeSeq || existing.latestCodeSeq || 0,
        signature: hash(JSON.stringify(codeGaps.map((gap) => serializableCodeGap(cwd, gap)))),
        emittedAt: existing.emittedAt || (/* @__PURE__ */ new Date()).toISOString(),
        lastEmittedAt: (/* @__PURE__ */ new Date()).toISOString(),
        emissionCount: codeDriftNoticeEmissionCount(state) + 1
      };
      const sessionNotice = state.codeDriftToolNotice || {};
      state.codeDriftToolNotice = {
        ...sessionNotice,
        emittedAt: sessionNotice.emittedAt || (/* @__PURE__ */ new Date()).toISOString(),
        lastEmittedAt: (/* @__PURE__ */ new Date()).toISOString(),
        emissionCount: codeDriftToolSessionEmissionCount(state) + 1
      };
    };
    var shouldEmitSubagentCheckpointNotice = (state, pending) => Boolean(pending?.signature) && state.subagentCheckpointNotice?.signature !== pending.signature;
    var markSubagentCheckpointNoticeEmitted = (state, pending, tool) => {
      if (!pending?.signature) return;
      state.subagentCheckpointNotice = {
        active: true,
        signature: pending.signature,
        type: pending.type,
        tool: normalizeCheckpointToolName(tool),
        emittedAt: (/* @__PURE__ */ new Date()).toISOString()
      };
    };
    var markStopCodeReviewConfirmation = (state, pending) => {
      if (pending?.type !== "code") return false;
      return markCodeReviewNoEditConfirmation(state, pending.gaps || []);
    };
    var isOpenCodeHookInput = (input) => {
      if (OUTPUT_MODE === "opencode") return true;
      if (OUTPUT_MODE === "claude" || OUTPUT_MODE === "claude-code") return false;
      return input?.hook_source === "opencode-plugin";
    };
    var createRuntimeOutputHelpers = (options = {}) => createOutputHelpers({
      isOpenCodeHookInput,
      opencodeStopReportOnly: OPENCODE_STOP_REPORT_ONLY,
      strictBlock: STRICT_BLOCK,
      stdout: options.stdout || process.stdout,
      stderr: options.stderr || process.stderr,
      exit: options.exit || process.exit
    });
    var defaultOutputHelpers = createRuntimeOutputHelpers();
    var {
      buildClaudeCodeOutput,
      buildPreToolUseDenyOutput,
      buildStopOutput,
      emitEnforcement,
      emitStopEnforcement
    } = defaultOutputHelpers;
    var dispatch = async (input, options = {}) => {
      const cwd = input.cwd || process.cwd();
      if (!hasSddWorkspace(cwd)) return;
      const sessionID = input.session_id || "default";
      const currentStatePath = statePath(cwd, sessionID);
      const currentProjectPath = projectStatePath(cwd);
      const stateLock = acquireFileLock(currentStatePath, {
        staleMs: STATE_LOCK_STALE_MS,
        waitMs: STATE_LOCK_WAIT_MS,
        retryMs: STATE_LOCK_RETRY_MS
      });
      if (!stateLock) {
        writeDiagnosticLog(cwd, {
          event: "state_lock_unavailable",
          input: summarizeInput(input),
          statePath: currentStatePath
        });
        return;
      }
      const projectLock = acquireFileLock(currentProjectPath, {
        staleMs: STATE_LOCK_STALE_MS,
        waitMs: PROJECT_LOCK_WAIT_MS,
        retryMs: STATE_LOCK_RETRY_MS
      });
      try {
        const state = loadState(cwd, sessionID);
        const project = projectLock ? loadProjectState(cwd) : null;
        const persist = () => {
          if (project) {
            applySessionToProject(cwd, project, state, sessionID);
            saveProjectState(cwd, project);
            state.projectStateSeenAt = project.lastUpdatedAt;
          }
          saveState(cwd, sessionID, state);
        };
        const persistAndReport = () => {
          if (project) {
            applySessionToProject(cwd, project, state, sessionID);
            saveProjectState(cwd, project);
            state.projectStateSeenAt = project.lastUpdatedAt;
          }
          refreshReport(cwd, state, project);
          saveState(cwd, sessionID, state);
        };
        const transcriptPathForContext = resolveTranscriptPath(input);
        const dtsContextActive = updateDtsContextFromInput(state, input, transcriptPathForContext);
        const outputHelpers = options.stdout || options.stderr || options.exit ? createRuntimeOutputHelpers(options) : defaultOutputHelpers;
        const stdout = options.stdout || process.stdout;
        const handlerContext = {
          cwd,
          sessionID,
          state,
          project,
          applySessionToProject,
          applyToolRecord,
          buildClaudeCodeOutput: outputHelpers.buildClaudeCodeOutput,
          buildCodeEnforcement,
          buildCodeToolReminder,
          buildAttributionReviewPrompt,
          buildPreCompactSummary,
          buildQuestionCheckpointEnforcement,
          buildPendingEnforcement,
          buildSubagentCheckpointEnforcement,
          buildToolEnforcement,
          clearCodeDriftNoticeIfResolved,
          clearPeerDriftNoticeIfResolved,
          buildStopEnforcement,
          clearSubagentCheckpointNoticeIfResolved,
          clearPeerSyncs,
          clearStageOnlyRequirements,
          CODE_REVIEW_STOP_MAX_BLOCKS,
          codeDriftNoticeEmissionCount,
          codeDriftToolSessionEmissionCount,
          codeReviewToolMaxReminders,
          codeReviewToolSessionMaxReminders,
          collectCombinedCodeGaps,
          collectCombinedPeerGaps,
          drift,
          emitEnforcement: outputHelpers.emitEnforcement,
          emitStopEnforcement: outputHelpers.emitStopEnforcement,
          formatCarryOverReminder,
          getToolEventKey,
          getToolFilePath,
          isDtsContextActive,
          isOpenCodeHookInput,
          isQuestionCheckpointTool,
          limitString,
          hydrateStateFromTranscript,
          hydrateStateFromCheckpointOutput,
          acceptUnresolvedAttributionReviews,
          markCarryOverNoticeEmitted,
          markCodeDriftNoticeEmitted,
          markCodeReviewNoEditConfirmation,
          markImplementationFlowConfirmation,
          markPeerDriftNoticeEmitted,
          markSubagentCheckpointNoticeEmitted,
          markStopCodeReviewConfirmation,
          markToolEvent,
          OPENCODE_STOP_REPORT_ONLY,
          persist,
          persistAndReport,
          peerDriftSignature,
          refreshAlignedBaseline,
          refreshReport,
          rel,
          resolveReadOnlyAttributionReviews,
          resolveFile,
          shouldEmitCarryOverNotice,
          shouldEmitCodeDriftNotice,
          shouldEmitSubagentCheckpointNotice,
          isCodeDriftNoticeSuppressed,
          isSubagentCheckpointTool,
          summarizeInput,
          summarizeGaps,
          SHOW_WARNINGS,
          STOP_MAX_BLOCKS,
          takeAttributionReviewPrompts,
          transcriptPathForContext,
          writeDiagnosticLog,
          writeStdout: (message) => stdout.write(message)
        };
        writeDiagnosticLog(cwd, {
          event: "hook_start",
          input: summarizeInput(input),
          statePath: currentStatePath,
          projectPath: currentProjectPath,
          stateLockAcquired: Boolean(stateLock),
          projectLockAcquired: Boolean(projectLock),
          outputMode: OUTPUT_MODE || "auto",
          strictBlock: STRICT_BLOCK,
          dtsContextActive
        });
        if (CircuitBreaker.isOpen(state, input.hook_event_name)) {
          writeDiagnosticLog(cwd, {
            event: "circuit_open_skip",
            input: summarizeInput(input)
          });
          saveState(cwd, sessionID, state);
          return;
        }
        const recordCircuitSuccess = () => {
          if (CircuitBreaker.recordSuccess(state, input.hook_event_name)) {
            saveState(cwd, sessionID, state);
            writeDiagnosticLog(cwd, {
              event: "circuit_close",
              input: summarizeInput(input)
            });
          }
        };
        try {
          if (input.hook_event_name === "UserPromptSubmit" || input.hook_event_name === "ChatMessage") {
            handleUserPromptSubmit(input, handlerContext);
            recordCircuitSuccess();
            return;
          }
          if (input.hook_event_name === "PreCompact") {
            handlePreCompact(input, handlerContext);
            recordCircuitSuccess();
            return;
          }
          if (input.hook_event_name === "PreToolUse") {
            handlePreToolUse(input, handlerContext);
            recordCircuitSuccess();
            return;
          }
          if (input.hook_event_name === "Stop") {
            handleStop(input, handlerContext);
            recordCircuitSuccess();
            return;
          }
          if (input.hook_event_name === "PostToolUse") {
            handlePostToolUse(input, handlerContext);
            recordCircuitSuccess();
            return;
          }
          persistAndReport();
          writeDiagnosticLog(cwd, {
            event: "ignored_event",
            input: summarizeInput(input)
          });
          recordCircuitSuccess();
          return;
        } catch (err) {
          const opened = CircuitBreaker.recordFailure(state, input.hook_event_name);
          saveState(cwd, sessionID, state);
          writeDiagnosticLog(cwd, {
            event: "handler_exception",
            input: summarizeInput(input),
            error: limitString(err?.stack || err, 2e3)
          });
          if (opened) {
            writeDiagnosticLog(cwd, {
              event: "circuit_open",
              input: summarizeInput(input)
            });
          }
          return;
        }
      } finally {
        releaseFileLock(projectLock);
        releaseFileLock(stateLock);
      }
    };
    var main = async () => {
      const input = parseHookInput(await readStdin(STDIN_TIMEOUT_MS));
      await dispatch(input);
    };
    var runHookInput2 = async (input, options = {}) => {
      let stdout = "";
      let stderr = "";
      let status = 0;
      const stdoutStream = {
        write: (chunk) => {
          stdout += String(chunk || "");
          return true;
        }
      };
      const stderrStream = {
        write: (chunk) => {
          stderr += String(chunk || "");
          return true;
        }
      };
      const exit = (code = 0) => {
        status = Number.isFinite(Number(code)) ? Number(code) : 0;
        const error = new Error(`sdd-drift-check hook requested exit ${status}`);
        error.__sddDriftHookExit = true;
        throw error;
      };
      try {
        await dispatch(input, {
          ...options,
          stdout: options.stdout || stdoutStream,
          stderr: options.stderr || stderrStream,
          exit: options.exit || exit
        });
      } catch (error) {
        if (!error?.__sddDriftHookExit) throw error;
      }
      return {
        status,
        stdout,
        stderr
      };
    };
    if (require.main === module2) {
      main().catch((err) => {
        writeDiagnosticLog(process.cwd(), {
          event: "hook_exception",
          error: limitString(err?.stack || err, 2e3)
        });
        if (DEBUG) process.stderr.write(`[sdd-drift-check] ${err?.stack || err}
`);
        process.exit(0);
      });
    } else {
      module2.exports = {
        buildToolEnforcement,
        buildClaudeCodeOutput,
        buildCodeEnforcement,
        buildCodeToolReminder,
        buildAttributionReviewPrompt,
        buildPendingEnforcement,
        buildPreToolUseDenyOutput,
        buildQuestionCheckpointEnforcement,
        buildStopEnforcement,
        buildStopOutput,
        buildSubagentCheckpointEnforcement,
        clearCodeDriftNoticeIfResolved,
        clearSubagentCheckpointNoticeIfResolved,
        cleanupDiagnosticLogs,
        collectActiveChangeDirs,
        collectCarryOverDrift,
        collectCodeGaps,
        collectCombinedCodeGaps,
        collectCombinedPeerGaps,
        collectPeerGaps,
        collectProjectCodeGaps,
        collectProjectPeerGaps,
        collectReportLines,
        collectReviewTargets,
        computeProjectConditions,
        computeProjectState,
        CircuitBreaker,
        codeReviewSignature,
        diagnosticLogPath,
        dispatch,
        drift,
        emptyState,
        findSdd,
        getChangeDoc,
        hasEditedSddChange,
        hasSddWorkspace,
        collectCheckpointOutputText,
        extractCheckpointEditedPaths,
        hydrateStateFromCheckpointMtime,
        hydrateStateFromCheckpointOutput,
        hydrateStateFromTranscript,
        isCodeDriftNoticeSuppressed,
        isDtsContextActive,
        isDtsContextText,
        isOpenCodeHookInput,
        isArchivedChangeDir,
        isQuestionCheckpointTool,
        isSubagentCheckpointTool,
        loadProjectState,
        loadState,
        normalizeKey,
        normalizeProjectState,
        parseHookInput,
        projectStatePath,
        applyToolRecord,
        applySessionToProject,
        acquireFileLock,
        ATTRIBUTION_REVIEW_RULES,
        Attribution,
        Actions,
        buildPreCompactSummary,
        createHookHandlers,
        handlePreCompact,
        handlePostToolUse,
        handlePreToolUse,
        handleStop,
        handleUserPromptSubmit,
        getToolEventKey,
        HookHandlers,
        markCarryOverNoticeEmitted,
        markAttributionReviewEmitted,
        markToolEvent,
        pruneStateFiles,
        refreshAlignedBaseline,
        recordFile,
        recordDiagnosticSummaryEvent,
        resolveTranscriptPath,
        refreshReport,
        releaseFileLock,
        acceptUnresolvedAttributionReviews,
        resolveReadOnlyAttributionReviews,
        runActions,
        runHookInput: runHookInput2,
        saveProjectState,
        saveState,
        writeDiagnosticLog,
        takeAttributionReviewPrompts,
        updateDtsContextFromInput,
        shouldEmitCarryOverNotice,
        shouldEmitCodeDriftNotice,
        shouldEmitSubagentCheckpointNotice,
        markCodeDriftNoticeEmitted,
        markImplementationFlowConfirmation,
        markSubagentCheckpointNoticeEmitted,
        markCodeReviewNoEditConfirmation,
        markStopCodeReviewConfirmation,
        updateRequirementsForEdit
      };
    }
  }
});

// src/adapters/opencode/native-plugin.js
var path = require("node:path");
var { runHookInput } = require_command_hook();
var {
  QUESTION_CHECKPOINT_TOOL_NAMES,
  isSupportedOpenCodeToolEvent,
  normalizeToolArgs,
  normalizeToolName
} = require_tool_events();
var PLUGIN_NAME = "sdd-drift-check-opencode";
var TOOL_INPUT_CACHE_TTL_MS = 5 * 60 * 1e3;
var IDLE_DEDUP_WINDOW_MS = 500;
var isSupportedToolEvent = isSupportedOpenCodeToolEvent;
var normalizeCwd = (ctx) => path.resolve(ctx?.worktree || ctx?.directory || process.cwd());
var getSessionID = (input) => input?.sessionID || input?.sessionId || input?.session_id || "default";
var getToolCallID = (input) => input?.callID || input?.callId || input?.toolCallID || input?.toolCallId || input?.tool_use_id || input?.id || null;
var toolCacheKey = (input) => {
  const callID = getToolCallID(input);
  if (!callID) return null;
  return `${getSessionID(input)}:${normalizeToolName(input?.tool)}:${callID}`;
};
var pruneToolInputCache = (cache, now = Date.now()) => {
  for (const [key, item] of cache.entries()) {
    if (now - item.updatedAtMs > TOOL_INPUT_CACHE_TTL_MS) {
      cache.delete(key);
    }
  }
};
var cacheToolInput = (cache, input, args, now = Date.now()) => {
  const key = toolCacheKey(input);
  if (!key) return false;
  pruneToolInputCache(cache, now);
  cache.set(key, {
    args: normalizeToolArgs(args),
    updatedAtMs: now
  });
  return true;
};
var takeCachedToolInput = (cache, input, now = Date.now()) => {
  const key = toolCacheKey(input);
  if (!key) return null;
  pruneToolInputCache(cache, now);
  const item = cache.get(key);
  if (!item) return null;
  cache.delete(key);
  return normalizeToolArgs(item.args);
};
var compactText = (value, max = 1e3) => {
  const text = String(value || "");
  return text.length > max ? `${text.slice(0, max)}...` : text;
};
var logPluginIssue = async (client, level, message, extra = {}) => {
  try {
    await client?.app?.log?.({
      body: {
        service: PLUGIN_NAME,
        level,
        message,
        extra
      }
    });
  } catch {
  }
};
var runNativeHook = async (hookInput) => {
  try {
    return await runHookInput(hookInput);
  } catch (error) {
    return {
      status: null,
      stdout: "",
      stderr: "",
      error
    };
  }
};
var appendToolOutput = (output, message) => {
  const text = String(message || "").trim();
  if (!text) return false;
  const current = String(output.output || "");
  output.output = current ? `${current}

${text}` : text;
  output.metadata = {
    ...output.metadata || {},
    sddDriftCheck: {
      injected: true
    }
  };
  return true;
};
var parseHookJson = (text) => {
  const trimmed = String(text || "").trim();
  if (!trimmed || !/^[{[]/.test(trimmed)) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
};
var getPreToolUseDenyReason = (result) => {
  const parsed = parseHookJson(result?.stdout);
  const specific = parsed?.hookSpecificOutput;
  if (specific?.permissionDecision === "deny") {
    return specific.permissionDecisionReason || parsed.reason || "Tool use denied by SDD drift check.";
  }
  if (parsed?.decision === "block" || parsed?.decision === "deny") {
    return parsed.reason || parsed.inject_prompt || "Tool use denied by SDD drift check.";
  }
  if (result?.status === 2) {
    return String(result.stdout || result.stderr || "Tool use denied by SDD drift check.").trim();
  }
  return null;
};
var getStopInjectPrompt = (result) => {
  const parsed = parseHookJson(result?.stdout);
  if (!parsed || parsed.decision !== "block") return null;
  return String(parsed.inject_prompt || "").trim() || null;
};
var buildToolOutputSummary = (output = {}) => ({
  title: compactText(output?.title || "", 1e3),
  output: compactText(output?.output || "", 64 * 1024)
});
var buildPreToolUseInput = (ctx, input, args) => ({
  hook_source: "opencode-plugin",
  hook_event_name: "PreToolUse",
  session_id: getSessionID(input),
  tool_use_id: getToolCallID(input),
  tool_name: normalizeToolName(input.tool),
  tool_input: normalizeToolArgs(args || {}),
  cwd: normalizeCwd(ctx)
});
var buildPostToolUseInput = (ctx, input, output, argsOverride = null) => ({
  hook_source: "opencode-plugin",
  hook_event_name: "PostToolUse",
  session_id: getSessionID(input),
  tool_use_id: getToolCallID(input),
  tool_name: normalizeToolName(input.tool),
  tool_input: normalizeToolArgs(argsOverride || input.args || {}),
  tool_output: buildToolOutputSummary(output),
  cwd: normalizeCwd(ctx)
});
var buildStopInput = (ctx, sessionID) => ({
  hook_source: "opencode-plugin",
  hook_event_name: "Stop",
  session_id: sessionID || "default",
  cwd: normalizeCwd(ctx)
});
var partText = (parts) => Array.isArray(parts) ? parts.map(
  (part) => typeof part === "string" ? part : part?.text || part?.content || part?.value || ""
).filter(Boolean).join("\n") : "";
var buildChatMessageInput = (ctx, input, output) => ({
  hook_source: "opencode-plugin",
  hook_event_name: "ChatMessage",
  session_id: getSessionID(input),
  message_id: input?.messageID || null,
  agent: input?.agent || null,
  model: input?.model || null,
  message: output?.message || null,
  parts: output?.parts || [],
  message_text: partText(output?.parts),
  cwd: normalizeCwd(ctx)
});
var normalizeIdleEvent = (event) => {
  if (event?.type === "session.idle") {
    return {
      sessionID: event?.properties?.sessionID || "default",
      rawType: event.type
    };
  }
  if (event?.type === "session.status") {
    const status = event?.properties?.status;
    if (status !== "idle" && status?.type !== "idle") return null;
    return {
      sessionID: event?.properties?.sessionID || "default",
      rawType: event.type
    };
  }
  return null;
};
var shouldHandleIdle = (recentIdleBySession, sessionID, now = Date.now()) => {
  const id = sessionID || "default";
  for (const [key, lastAt2] of recentIdleBySession.entries()) {
    if (now - lastAt2 > IDLE_DEDUP_WINDOW_MS * 10) {
      recentIdleBySession.delete(key);
    }
  }
  const lastAt = recentIdleBySession.get(id);
  if (lastAt && now - lastAt < IDLE_DEDUP_WINDOW_MS) {
    return false;
  }
  recentIdleBySession.set(id, now);
  return true;
};
var promptSession = async (ctx, sessionID, prompt) => {
  const session = ctx?.client?.session;
  const fn = typeof session?.promptAsync === "function" ? session.promptAsync.bind(session) : typeof session?.prompt === "function" ? session.prompt.bind(session) : null;
  if (!fn) return false;
  await fn({
    path: { id: sessionID || "default" },
    body: {
      parts: [
        {
          type: "text",
          text: prompt
        }
      ]
    },
    query: {
      directory: normalizeCwd(ctx)
    }
  });
  return true;
};
exports.SddDriftCheckOpenCode = async (ctx) => {
  const hookRunner = typeof ctx?.__sddDriftRunHookInput === "function" ? ctx.__sddDriftRunHookInput : runNativeHook;
  const toolInputCache = /* @__PURE__ */ new Map();
  const recentIdleBySession = /* @__PURE__ */ new Map();
  return {
    "chat.message": async (input, output) => {
      const result = await hookRunner(buildChatMessageInput(ctx, input, output));
      if (result.error || result.timedOut) {
        await logPluginIssue(ctx.client, "warn", "chat message context capture did not complete", {
          sessionID: input?.sessionID,
          timedOut: Boolean(result.timedOut),
          error: compactText(result.error?.message || ""),
          stderr: compactText(result.stderr)
        });
      }
    },
    "tool.execute.before": async (input, output = {}) => {
      const tool = normalizeToolName(input.tool);
      const args = normalizeToolArgs(output?.args || input.args || {});
      cacheToolInput(toolInputCache, input, args);
      if (!QUESTION_CHECKPOINT_TOOL_NAMES.has(tool)) return;
      const result = await hookRunner(buildPreToolUseInput(ctx, input, args));
      if (result.error || result.timedOut) {
        await logPluginIssue(ctx.client, "warn", "question checkpoint did not complete", {
          tool,
          sessionID: getSessionID(input),
          timedOut: Boolean(result.timedOut),
          error: compactText(result.error?.message || ""),
          stderr: compactText(result.stderr)
        });
        return;
      }
      const denyReason = getPreToolUseDenyReason(result);
      if (!denyReason) return;
      await logPluginIssue(ctx.client, "info", "blocked question tool for SDD drift checkpoint", {
        tool,
        sessionID: getSessionID(input),
        callID: getToolCallID(input)
      });
      throw new Error(denyReason);
    },
    "tool.execute.after": async (input, output) => {
      const tool = normalizeToolName(input.tool);
      const args = takeCachedToolInput(toolInputCache, input) || normalizeToolArgs(input.args || {});
      if (!isSupportedToolEvent(tool, args || {})) return;
      const result = await hookRunner(buildPostToolUseInput(ctx, input, output, args));
      if (result.error || result.timedOut) {
        await logPluginIssue(ctx.client, "warn", "command hook did not complete", {
          timedOut: Boolean(result.timedOut),
          error: compactText(result.error?.message || ""),
          stderr: compactText(result.stderr)
        });
        return;
      }
      const message = result.stdout || (process.env.SDD_DRIFT_NATIVE_APPEND_STDERR === "1" ? result.stderr : "");
      if (appendToolOutput(output, message)) {
        await logPluginIssue(ctx.client, "info", "injected SDD drift reminder", {
          tool,
          sessionID: getSessionID(input),
          callID: getToolCallID(input)
        });
      }
    },
    event: async ({ event }) => {
      const idle = normalizeIdleEvent(event);
      if (!idle) return;
      const sessionID = idle.sessionID;
      if (!shouldHandleIdle(recentIdleBySession, sessionID)) return;
      const result = await hookRunner(buildStopInput(ctx, sessionID));
      if (result.error || result.timedOut) {
        await logPluginIssue(ctx.client, "warn", "idle check did not complete", {
          sessionID,
          rawType: idle.rawType,
          timedOut: Boolean(result.timedOut),
          error: compactText(result.error?.message || ""),
          stderr: compactText(result.stderr)
        });
        return;
      }
      const injectPrompt = getStopInjectPrompt(result);
      if (!injectPrompt) return;
      try {
        const injected = await promptSession(ctx, sessionID, injectPrompt);
        await logPluginIssue(ctx.client, injected ? "info" : "warn", "processed Stop continuation", {
          sessionID,
          rawType: idle.rawType,
          injected
        });
      } catch (error) {
        await logPluginIssue(ctx.client, "warn", "Stop continuation prompt failed", {
          sessionID,
          rawType: idle.rawType,
          error: compactText(error?.message || String(error))
        });
      }
    }
  };
};
exports._private = {
  buildChatMessageInput,
  buildPreToolUseInput,
  buildPostToolUseInput,
  buildStopInput,
  cacheToolInput,
  getPreToolUseDenyReason,
  getStopInjectPrompt,
  isSupportedToolEvent,
  normalizeToolName,
  normalizeToolArgs,
  normalizeIdleEvent,
  partText,
  promptSession,
  runNativeHook,
  shouldHandleIdle,
  takeCachedToolInput
};
