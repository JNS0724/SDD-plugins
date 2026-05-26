var __getOwnPropNames = Object.getOwnPropertyNames;
var __commonJS = (cb, mod) => function __require() {
  return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
};

// src/actions.js
var require_actions = __commonJS({
  "src/actions.js"(exports2, module2) {
    var ACTION_ORDER = ["log", "save_project", "save_session", "refresh_report", "emit_message"];
    var Actions2 = {
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
    var runActions2 = async (actions, ctx) => {
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
      Actions: Actions2,
      runActions: runActions2
    };
  }
});

// src/handlers/pre-compact.js
var require_pre_compact = __commonJS({
  "src/handlers/pre-compact.js"(exports2, module2) {
    var handlePreCompact2 = (input, ctx) => {
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
    module2.exports = { handlePreCompact: handlePreCompact2 };
  }
});

// src/handlers/pre-tool-use.js
var require_pre_tool_use = __commonJS({
  "src/handlers/pre-tool-use.js"(exports2, module2) {
    var handlePreToolUse2 = (input, ctx) => {
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
    module2.exports = { handlePreToolUse: handlePreToolUse2 };
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
    var handlePostToolUse2 = (input, ctx) => {
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
    module2.exports = { handlePostToolUse: handlePostToolUse2 };
  }
});

// src/handlers/stop.js
var require_stop = __commonJS({
  "src/handlers/stop.js"(exports2, module2) {
    var handleStop2 = (input, ctx) => {
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
    module2.exports = { handleStop: handleStop2 };
  }
});

// src/handlers/user-prompt-submit.js
var require_user_prompt_submit = __commonJS({
  "src/handlers/user-prompt-submit.js"(exports2, module2) {
    var handleUserPromptSubmit2 = (input, ctx) => {
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
    module2.exports = { handleUserPromptSubmit: handleUserPromptSubmit2 };
  }
});

// src/dispatcher.js
var require_dispatcher = __commonJS({
  "src/dispatcher.js"(exports2, module2) {
    var { handlePreCompact: handlePreCompact2 } = require_pre_compact();
    var { handlePreToolUse: handlePreToolUse2 } = require_pre_tool_use();
    var { handlePostToolUse: handlePostToolUse2 } = require_post_tool_use();
    var { handleStop: handleStop2 } = require_stop();
    var { handleUserPromptSubmit: handleUserPromptSubmit2 } = require_user_prompt_submit();
    var makeHandlerSpec = (requiresSession, requiresProject, lockPolicy, handle) => ({
      requiresSession,
      requiresProject,
      lockPolicy,
      handle
    });
    var createHookHandlers2 = (handlers = {}) => ({
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
    var HookHandlers2 = createHookHandlers2({
      PreCompact: handlePreCompact2,
      PostToolUse: handlePostToolUse2,
      PreToolUse: handlePreToolUse2,
      Stop: handleStop2,
      UserPromptSubmit: handleUserPromptSubmit2
    });
    module2.exports = {
      HookHandlers: HookHandlers2,
      createHookHandlers: createHookHandlers2
    };
  }
});

// src/stdin.js
var require_stdin = __commonJS({
  "src/stdin.js"(exports2, module2) {
    var readStdin2 = (timeoutMs) => new Promise((resolve, reject) => {
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
    module2.exports = { readStdin: readStdin2 };
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
    var QUESTION_CHECKPOINT_TOOL_NAMES = /* @__PURE__ */ new Set([
      "ask_user",
      "ask_user_question",
      "askuser",
      "askuserquestion",
      "confirm",
      "confirmation",
      "question"
    ]);
    var getToolFilePath2 = (args) => args?.file_path || args?.filePath || args?.path || args?.file;
    var normalizeToolName = (tool) => {
      const name = String(tool || "").trim().toLowerCase().replace(/[-\s.]+/g, "_");
      if (name === "multi_edit" || name === "multi-edit") return "multiedit";
      return name;
    };
    var isSubagentCheckpointTool2 = (tool) => {
      const normalized = normalizeToolName(tool);
      if (normalized === "background_task") return false;
      return SUBAGENT_CHECKPOINT_TOOL_NAMES.has(normalized);
    };
    var isQuestionCheckpointTool2 = (tool) => QUESTION_CHECKPOINT_TOOL_NAMES.has(normalizeToolName(tool));
    var isSupportedOpenCodeToolEvent = (tool, args) => {
      const normalized = normalizeToolName(tool);
      if (FILE_TOOL_NAMES.has(normalized) && getToolFilePath2(args || {})) return true;
      if (normalized === "background_task") return false;
      if (isQuestionCheckpointTool2(normalized)) return true;
      return isSubagentCheckpointTool2(normalized);
    };
    var normalizeToolArgs = (args) => {
      const copy = { ...args || {} };
      const fp = getToolFilePath2(copy);
      if (fp && !copy.file_path) copy.file_path = fp;
      return copy;
    };
    module2.exports = {
      FILE_TOOL_NAMES,
      SUBAGENT_CHECKPOINT_TOOL_NAMES,
      QUESTION_CHECKPOINT_TOOL_NAMES,
      getToolFilePath: getToolFilePath2,
      isQuestionCheckpointTool: isQuestionCheckpointTool2,
      isSubagentCheckpointTool: isSubagentCheckpointTool2,
      isSupportedOpenCodeToolEvent,
      normalizeToolArgs,
      normalizeToolName
    };
  }
});

// src/core/paths.js
var require_paths = __commonJS({
  "src/core/paths.js"(exports2, module2) {
    var path2 = require("path");
    var toPosix2 = (fp) => String(fp || "").replace(/\\/g, "/");
    var isCaseInsensitiveFs = () => process.platform === "win32" || process.platform === "darwin";
    var normalizeKey2 = (fp) => {
      const normalized = toPosix2(path2.resolve(fp));
      return isCaseInsensitiveFs() ? normalized.toLowerCase() : normalized;
    };
    var samePath2 = (left, right) => normalizeKey2(left) === normalizeKey2(right);
    var rel2 = (cwd, fp) => toPosix2(path2.relative(cwd, fp));
    var resolveFile2 = (cwd, fp) => path2.isAbsolute(fp) ? path2.normalize(fp) : path2.resolve(cwd, fp);
    module2.exports = {
      isCaseInsensitiveFs,
      normalizeKey: normalizeKey2,
      rel: rel2,
      resolveFile: resolveFile2,
      samePath: samePath2,
      toPosix: toPosix2
    };
  }
});

// src/core/file-classifier.js
var require_file_classifier = __commonJS({
  "src/core/file-classifier.js"(exports2, module2) {
    var path2 = require("path");
    var { toPosix: toPosix2 } = require_paths();
    var CODE_EXT = /\.(ts|tsx|js|jsx|mjs|cjs|html|css|vue|svelte|py|go|rs|java|kt|swift|cc|cpp|c|h|hpp|rb|php|cs|scss|sql)$/i;
    var isSddPath2 = (fp) => {
      const normalized = toPosix2(path2.resolve(fp));
      return normalized.includes("/sdd/") || normalized.includes("/.sdd/");
    };
    var isSddChangePath = (fp) => {
      const normalized = toPosix2(path2.resolve(fp));
      return normalized.includes("/sdd/changes/") || normalized.includes("/.sdd/changes/");
    };
    var isCodePath2 = (fp) => CODE_EXT.test(fp) && !isSddPath2(fp);
    module2.exports = {
      CODE_EXT,
      isCodePath: isCodePath2,
      isSddChangePath,
      isSddPath: isSddPath2
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
    var fs2 = require("fs");
    var path2 = require("path");
    var { toPosix: toPosix2 } = require_paths();
    var STATE_DIR = ".sdd-drift-hook-state";
    var PEER_FILES = ["design.md", "tasks.md"];
    var PROPOSAL_FILE2 = "proposal.md";
    var DESIGN_FILE2 = "design.md";
    var TASKS_FILE2 = "tasks.md";
    var REVIEW_FILES = [DESIGN_FILE2, TASKS_FILE2];
    var ARCHIVED_CHANGE_DIR_NAMES = /* @__PURE__ */ new Set(["archive", "archives", "archived", ".archive", ".archived", "\u5DF2\u5F52\u6863"]);
    var ARCHIVE_MARKER_FILES = [".archived", ".archive", "ARCHIVED", "archived.md", "archive.md", "\u5DF2\u5F52\u6863.md"];
    var ARCHIVE_STATUS_FILES = ["status.md", "state.md", "metadata.md", ".status"];
    var CHANGE_DOC_REQUIREMENTS = {
      [PROPOSAL_FILE2]: [DESIGN_FILE2],
      [DESIGN_FILE2]: [TASKS_FILE2],
      [TASKS_FILE2]: [DESIGN_FILE2]
    };
    var DOCUMENT_SYNC_RULES = [
      "Before editing any SDD document, read the current file and preserve its existing Markdown template.",
      "Keep every existing heading line exactly as-is, including the top-level title such as # Design or # Tasks, and keep the original heading order.",
      "Do not replace the whole document with a summary, marker, or single-line result.",
      "Do not add new sections.",
      "Do not rewrite the document template.",
      "Find the existing section that should change and edit that section only.",
      "Do not add a new section or rewrite the template just to satisfy this enforcement.",
      "Do not remove unrelated existing paragraphs, checklist items, examples, requirements, or notes while synchronizing drift.",
      "For existing SDD documents, prefer Edit or MultiEdit. If Write is necessary, copy the original file content first and write the full document including all existing headings, template text, paragraphs, and checklist items.",
      "Do not edit design.md and tasks.md in the same parallel tool batch; update one SDD document, wait for its tool result and hook feedback, then update the required peer.",
      "Find the most appropriate existing heading, paragraph, list item, or task item, and make the smallest needed update there.",
      "For tasks.md, preserve the task-list format and update the relevant existing checklist item when possible."
    ];
    var ACTIVE_SDD_ALIGNMENT_RULES = [
      "Active SDD documents are live planning records until their change directory is archived; before the final answer, keep active design.md and tasks.md aligned with the implemented code.",
      "Do not treat an optimization or refactor as documentation-free if it changes behavior, API or contracts, algorithms, state or data flow, data structures, performance strategy, error handling, security boundaries, user-visible results, or implementation constraints; update design.md when any of those code facts changed.",
      "Do not satisfy SDD alignment by only adding a marker, completion note, or generic summary; replace the specific stale sentence, paragraph, or checklist item so the document states the actual implemented behavior, API, error handling, performance strategy, or task status.",
      "When a changed code file adds or changes exported names, public function signatures, literal return values, config defaults, user-visible strings, or acceptance-relevant constants, carry those concrete facts into the appropriate existing design.md/tasks.md wording instead of summarizing them vaguely.",
      "After editing design.md, re-read the changed sentence mentally and ensure no old wording still contradicts the code you just wrote.",
      "Update tasks.md when the code completes, changes, cancels, splits, or invalidates an implementation task, checklist item, planned step, or acceptance condition.",
      "The no-document-change path is only valid for purely mechanical edits with no design or task impact, such as formatting-only changes, comment-only edits, test-only scaffolding, or dependency/config churn that does not change the active SDD plan.",
      "If you choose no SDD edit, explicitly state which active design.md/tasks.md files you reviewed and why the code change has no design or task impact.",
      "Modify only content relevant to the current code batch; do not invent future requirements or broaden the scope."
    ];
    var ATTRIBUTION_REVIEW_RULES2 = [
      "Purely mechanical changes (formatting, comment-only edits, test-scaffolding, dependency bumps, lint fixes) do not require any SDD document update. State this conclusion explicitly in your response and continue.",
      "If the code change implements behavior already described in a candidate change-dir's design.md, and that change-dir's tasks.md already reflects the implementation, no SDD action is needed.",
      "If the code change adds, changes, or removes behavior not described in any candidate change-dir's design.md, update the most relevant change-dir's design.md to state the actual implemented behavior. Update tasks.md if a tracked task item is now complete or invalidated.",
      "If the code change is genuinely unrelated to any active change-dir, acknowledge it as out-of-SDD scope in your response, or create a new sdd/changes/<id>/ directory when the work is feature-sized and warrants tracking.",
      "If multiple candidate change-dirs could apply, choose the most specific match based on design.md content and briefly document the reasoning in your response. Do not edit unrelated change-dirs."
    ];
    var SUBAGENT_REVIEW_RULE = "If the current environment supports subagents and a read-only review subagent is allowed, you may delegate SDD review to it; otherwise perform the review yourself with the read tool. The main agent remains responsible for any final edits.";
    var RESUME_ORIGINAL_TASK_RULES = [
      "SDD review is a checkpoint inside the current task, not the final task.",
      "Treat SDD review/synchronization as a checkpoint inside the current user task, not as the whole task.",
      "After the SDD review or synchronization is complete, return to the original user task.",
      "After the required SDD work is complete, resume the original user task/request from where you paused if any implementation, verification, cleanup, or response work remains.",
      "Only give the final answer when both the original user task and the required SDD review/synchronization are complete."
    ];
    var formatAttributionReviewRules = () => [
      "When deciding whether SDD documents need edits, apply these attribution review rules in order:",
      ...ATTRIBUTION_REVIEW_RULES2.map((rule, index) => `${index + 1}. ${rule}`)
    ];
    var findSdd2 = (fp) => {
      const parts = toPosix2(path2.resolve(fp)).split("/");
      for (let index = parts.length - 1; index >= 0; index -= 1) {
        const part = parts[index];
        if (part !== "sdd" && part !== ".sdd") continue;
        const rel2 = parts.slice(index + 1).join("/");
        if (rel2 === "" || rel2.startsWith("changes/") || rel2.startsWith("specs/")) {
          return path2.normalize(parts.slice(0, index + 1).join("/"));
        }
      }
      return null;
    };
    var getChangeDoc2 = (fp) => {
      const root = findSdd2(fp);
      const rawRel = root ? path2.relative(root, fp) : "";
      if (!root || rawRel.startsWith("..")) return null;
      const rel2 = toPosix2(rawRel);
      const match = rel2.match(/^changes\/([^/]+)\/([^/]+\.md)$/);
      if (!match) return { root, rel: rel2 };
      const [, id, file] = match;
      return {
        root,
        rel: rel2,
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
        return fs2.readFileSync(fp, "utf8").slice(0, 4096);
      } catch {
        return "";
      }
    };
    var isArchivedChangeDir2 = (dir) => {
      if (!dir || isArchivedChangeDirName(dir)) return true;
      for (const marker of ARCHIVE_MARKER_FILES) {
        if (fs2.existsSync(path2.join(dir, marker))) return true;
      }
      for (const statusFile of ARCHIVE_STATUS_FILES) {
        const text = readSmallText(path2.join(dir, statusFile));
        if (text && isArchiveStatusText(text)) return true;
      }
      return false;
    };
    var hasSddWorkspace2 = (cwd) => {
      for (const name of ["sdd", ".sdd"]) {
        try {
          if (fs2.statSync(path2.join(cwd, name)).isDirectory()) return true;
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
      ATTRIBUTION_REVIEW_RULES: ATTRIBUTION_REVIEW_RULES2,
      CHANGE_DOC_REQUIREMENTS,
      DESIGN_FILE: DESIGN_FILE2,
      DOCUMENT_SYNC_RULES,
      PEER_FILES,
      PROPOSAL_FILE: PROPOSAL_FILE2,
      RESUME_ORIGINAL_TASK_RULES,
      REVIEW_FILES,
      STATE_DIR,
      SUBAGENT_REVIEW_RULE,
      TASKS_FILE: TASKS_FILE2,
      formatAttributionReviewRules,
      findSdd: findSdd2,
      getChangeDoc: getChangeDoc2,
      hasSddWorkspace: hasSddWorkspace2,
      isArchiveStatusText,
      isArchivedChangeDir: isArchivedChangeDir2,
      isArchivedChangeDirName
    };
  }
});

// src/core/state-storage.js
var require_state_storage = __commonJS({
  "src/core/state-storage.js"(exports2, module2) {
    var crypto2 = require("crypto");
    var fs2 = require("fs");
    var os = require("os");
    var path2 = require("path");
    var { normalizeKey: normalizeKey2 } = require_paths();
    var { STATE_RETENTION_MS } = require_runtime_config();
    var { STATE_DIR } = require_sdd_rules();
    var sanitize = (value) => String(value || "default").replace(/[^a-zA-Z0-9_.-]/g, "_");
    var hash2 = (value) => crypto2.createHash("sha1").update(String(value)).digest("hex").slice(0, 12);
    var stateDirCache = /* @__PURE__ */ new Map();
    var findNearestGitDir = (cwd) => {
      let dir = path2.resolve(cwd);
      while (dir !== path2.dirname(dir)) {
        const gitPath = path2.join(dir, ".git");
        try {
          const stat = fs2.statSync(gitPath);
          if (stat.isDirectory()) return gitPath;
          if (stat.isFile()) {
            const content = fs2.readFileSync(gitPath, "utf8").trim();
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
        fs2.mkdirSync(dir, { recursive: true });
        fs2.writeFileSync(tmp, "");
        fs2.renameSync(tmp, target);
        fs2.unlinkSync(target);
        return true;
      } catch {
        try {
          fs2.unlinkSync(tmp);
        } catch {
        }
        try {
          fs2.unlinkSync(target);
        } catch {
        }
        return false;
      }
    };
    var stateDir = (cwd) => {
      const cacheKey = normalizeKey2(cwd);
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
      const tempStateDir = path2.join(os.tmpdir(), "sdd-drift-check", hash2(path2.resolve(cwd)));
      stateDirCache.set(cacheKey, tempStateDir);
      return tempStateDir;
    };
    var statePath2 = (cwd, sessionID) => path2.join(stateDir(cwd), `${hash2(path2.resolve(cwd))}-${sanitize(sessionID)}.json`);
    var projectStatePath2 = (cwd) => path2.join(stateDir(cwd), "project.json");
    var diagnosticLogPath2 = (cwd) => process.env.SDD_DRIFT_LOG_PATH || path2.join(stateDir(cwd), "sdd-drift-check.log.jsonl");
    var writeTextAtomic = (target, text) => {
      fs2.mkdirSync(path2.dirname(target), { recursive: true });
      const tmp = path2.join(path2.dirname(target), `.${path2.basename(target)}.${process.pid}.${Date.now()}.tmp`);
      fs2.writeFileSync(tmp, text);
      try {
        fs2.renameSync(tmp, target);
      } catch (err) {
        try {
          fs2.writeFileSync(target, text);
        } catch {
          try {
            fs2.unlinkSync(tmp);
          } catch {
          }
          throw err;
        }
        try {
          fs2.unlinkSync(tmp);
        } catch {
        }
      }
    };
    var cleanupOldState = (cwd) => {
      const dir = stateDir(cwd);
      try {
        const now = Date.now();
        for (const entry of fs2.readdirSync(dir, { withFileTypes: true })) {
          if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
          const fp = path2.join(dir, entry.name);
          const stat = fs2.statSync(fp);
          if (now - stat.mtimeMs > STATE_RETENTION_MS) fs2.unlinkSync(fp);
        }
      } catch {
      }
    };
    module2.exports = {
      canUseStateDir,
      cleanupOldState,
      diagnosticLogPath: diagnosticLogPath2,
      findNearestGitDir,
      hash: hash2,
      projectStatePath: projectStatePath2,
      sanitize,
      stateDir,
      statePath: statePath2,
      writeTextAtomic
    };
  }
});

// src/core/session-state.js
var require_session_state = __commonJS({
  "src/core/session-state.js"(exports2, module2) {
    var fs2 = require("fs");
    var path2 = require("path");
    var { getToolFilePath: getToolFilePath2 } = require_tool_events();
    var { isCodePath: isCodePath2, isSddChangePath } = require_file_classifier();
    var { normalizeKey: normalizeKey2, resolveFile: resolveFile2, samePath: samePath2 } = require_paths();
    var {
      CHANGE_DOC_REQUIREMENTS,
      DESIGN_FILE: DESIGN_FILE2,
      PEER_FILES,
      PROPOSAL_FILE: PROPOSAL_FILE2,
      TASKS_FILE: TASKS_FILE2,
      getChangeDoc: getChangeDoc2
    } = require_sdd_rules();
    var { SESSION_FILES_MAX, TOOL_EVENT_CAP, TRANSCRIPT_EVENT_CAP } = require_runtime_config();
    var { cleanupOldState, statePath: statePath2, writeTextAtomic } = require_state_storage();
    var emptyState2 = () => ({
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
      if (!items.some((existing) => samePath2(existing, item))) items.push(path2.normalize(item));
    };
    var sessionFilesMax = () => Number.isFinite(SESSION_FILES_MAX) ? Math.max(100, SESSION_FILES_MAX) : 1e3;
    var fileRecordOrder = (record) => Math.max(
      Number(record?.editedSeq || 0),
      Number(record?.touchedSeq || 0),
      Number(record?.firstEditedSeq || 0)
    );
    var pruneStateFiles2 = (state) => {
      const maxFiles = sessionFilesMax();
      const entries = Object.entries(state.files || {});
      if (entries.length <= maxFiles) return false;
      const keep = new Set(
        entries.sort((left, right) => fileRecordOrder(right[1]) - fileRecordOrder(left[1])).slice(0, maxFiles).map(([key]) => key)
      );
      state.files = Object.fromEntries(entries.filter(([key]) => keep.has(key)));
      state.touched = (state.touched || []).filter((file) => keep.has(normalizeKey2(file)));
      state.edited = (state.edited || []).filter((file) => keep.has(normalizeKey2(file)));
      return true;
    };
    var normalizeState = (parsed) => {
      const state = emptyState2();
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
        const key = normalizeKey2(fp);
        state.files[key] = {
          ...state.files[key] || {},
          path: path2.normalize(fp),
          touchedSeq: state.files[key]?.touchedSeq || 1
        };
      }
      for (const fp of state.edited) {
        const key = normalizeKey2(fp);
        state.files[key] = {
          ...state.files[key] || {},
          path: path2.normalize(fp),
          touchedSeq: state.files[key]?.touchedSeq || 1,
          editedSeq: state.files[key]?.editedSeq || 1,
          firstEditedSeq: state.files[key]?.firstEditedSeq || state.files[key]?.editedSeq || 1
        };
      }
      pruneStateFiles2(state);
      return state;
    };
    var loadState2 = (cwd, sessionID) => {
      try {
        return normalizeState(JSON.parse(fs2.readFileSync(statePath2(cwd, sessionID), "utf8")));
      } catch {
        return emptyState2();
      }
    };
    var saveState2 = (cwd, sessionID, state) => {
      cleanupOldState(cwd);
      writeTextAtomic(statePath2(cwd, sessionID), JSON.stringify(state, null, 2));
    };
    var touchedSeq2 = (state, fp) => state.files[normalizeKey2(fp)]?.touchedSeq || 0;
    var editedSeq2 = (state, fp) => state.files[normalizeKey2(fp)]?.editedSeq || 0;
    var firstEditedSeq = (state, fp) => state.files[normalizeKey2(fp)]?.firstEditedSeq || 0;
    var latestEditedCodeSeq = (state) => Object.values(state.files || {}).reduce((latest, file) => {
      if (!file.editedSeq || !isCodePath2(file.path || "")) return latest;
      return Math.max(latest, file.editedSeq || 0);
    }, 0);
    var editedSddSeqAfter = (state, files, seq) => files.some((file) => editedSeq2(state, file) > seq);
    var markToolEvent2 = (state, eventKey) => {
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
        return fs2.statSync(fp).mtimeMs;
      } catch {
        return 0;
      }
    };
    var latestStateEventMs = (state) => Object.values(state.files || {}).reduce(
      (latest, file) => Math.max(latest, Number(file?.touchedAtMs || 0), Number(file?.editedAtMs || 0)),
      0
    );
    var recordFile2 = (state, fp, edited) => {
      const abs = path2.normalize(path2.resolve(fp));
      const key = normalizeKey2(abs);
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
      pruneStateFiles2(state);
      return state.clock;
    };
    var addChangeDir = (state, dir) => addPath(state.changeDirs, dir);
    var getRequirementBucket = (state, dir, create) => {
      const key = normalizeKey2(dir);
      if (!state.requirements[key] && create) {
        state.requirements[key] = { dir: path2.normalize(dir), files: {} };
      }
      return state.requirements[key];
    };
    var cleanupRequirementBucket = (state, dir) => {
      const key = normalizeKey2(dir);
      const bucket = state.requirements[key];
      if (bucket && Object.keys(bucket.files || {}).length === 0) delete state.requirements[key];
    };
    var getPeerSyncBucket2 = (state, dir, create) => {
      const key = normalizeKey2(dir);
      if (!state.peerSyncs[key] && create) {
        state.peerSyncs[key] = { dir: path2.normalize(dir), files: {} };
      }
      return state.peerSyncs[key];
    };
    var cleanupPeerSyncBucket = (state, dir) => {
      const key = normalizeKey2(dir);
      const bucket = state.peerSyncs[key];
      if (bucket && Object.keys(bucket.files || {}).length === 0) delete state.peerSyncs[key];
    };
    var markPeerSyncResponse = (state, dir, file, sourceFile, sourceSeq, targetSeq) => {
      if (!sourceFile) return;
      const bucket = getPeerSyncBucket2(state, dir, true);
      bucket.files[file] = { sourceFile, sourceSeq, targetSeq };
    };
    var isPeerSyncContinuation = (state, dir, file, seq) => {
      const bucket = getPeerSyncBucket2(state, dir, false);
      const sync = bucket?.files?.[file];
      if (!sync?.sourceFile) return false;
      const sourceSeq = editedSeq2(state, path2.join(dir, sync.sourceFile));
      if (sourceSeq > sync.sourceSeq) {
        delete bucket.files[file];
        cleanupPeerSyncBucket(state, dir);
        return false;
      }
      if (seq > sync.targetSeq) sync.targetSeq = seq;
      return true;
    };
    var clearPeerSyncsForSourceEdit = (state, dir, sourceFile, seq) => {
      const bucket = getPeerSyncBucket2(state, dir, false);
      if (!bucket) return;
      for (const [file, sync] of Object.entries(bucket.files || {})) {
        if (sync?.sourceFile === sourceFile && seq > sync.sourceSeq) delete bucket.files[file];
      }
      cleanupPeerSyncBucket(state, dir);
    };
    var clearPeerSyncs2 = (state) => {
      state.peerSyncs = {};
    };
    var clearStageOnlyRequirements2 = (state) => {
      for (const [key, bucket] of Object.entries(state.requirements || {})) {
        for (const [file, requirement] of Object.entries(bucket.files || {})) {
          if (requirement?.stageOnly || requirement?.sourceFile === PROPOSAL_FILE2) delete bucket.files[file];
        }
        if (Object.keys(bucket.files || {}).length === 0) delete state.requirements[key];
      }
    };
    var isInitialTasksPlanEdit = (state, dir, seq) => {
      const tasksPath = path2.join(dir, TASKS_FILE2);
      const designPath = path2.join(dir, DESIGN_FILE2);
      const designSourceSeq = Math.max(touchedSeq2(state, designPath), editedSeq2(state, designPath));
      return firstEditedSeq(state, tasksPath) === seq && designSourceSeq > 0 && fs2.existsSync(designPath);
    };
    var updateRequirementsForEdit2 = (state, dir, file, seq) => {
      const bucket = getRequirementBucket(state, dir, false);
      const pending = bucket?.files?.[file];
      let satisfiedStageOnly = false;
      if (pending && seq > pending.afterSeq) {
        satisfiedStageOnly = Boolean(pending.stageOnly || pending.sourceFile === PROPOSAL_FILE2);
        if (!satisfiedStageOnly) {
          markPeerSyncResponse(state, dir, file, pending.sourceFile, pending.afterSeq, seq);
        }
        delete bucket.files[file];
        cleanupRequirementBucket(state, dir);
        if (!satisfiedStageOnly) return;
      }
      if (!satisfiedStageOnly && isPeerSyncContinuation(state, dir, file, seq)) return;
      if (file === TASKS_FILE2 && isInitialTasksPlanEdit(state, dir, seq)) {
        const designPath = path2.join(dir, DESIGN_FILE2);
        markPeerSyncResponse(
          state,
          dir,
          TASKS_FILE2,
          DESIGN_FILE2,
          Math.max(touchedSeq2(state, designPath), editedSeq2(state, designPath)),
          seq
        );
        return;
      }
      clearPeerSyncsForSourceEdit(state, dir, file, seq);
      const stageOnly = file === PROPOSAL_FILE2;
      let requiredPeers = CHANGE_DOC_REQUIREMENTS[file] || [];
      if (file === TASKS_FILE2) {
        const latestCodeSeq = latestEditedCodeSeq(state);
        const designReviewedAfterCode = touchedSeq2(state, path2.join(dir, DESIGN_FILE2)) > latestCodeSeq;
        const tasksEditedAfterCode = seq > latestCodeSeq;
        if (latestCodeSeq > 0 && designReviewedAfterCode && tasksEditedAfterCode) {
          requiredPeers = [];
        }
      }
      if (requiredPeers.length === 0) return;
      const target = getRequirementBucket(state, dir, true);
      for (const peer of requiredPeers) {
        const peerPath = path2.join(dir, peer);
        if (!fs2.existsSync(peerPath)) continue;
        if (editedSeq2(state, peerPath) > seq) continue;
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
    var applyToolRecord2 = (cwd, state, toolName, toolInput) => {
      const fp = getToolFilePath2(toolInput || {});
      if (!fp || typeof fp !== "string") return false;
      const tool = String(toolName || "").toLowerCase();
      const isEdit = tool === "edit" || tool === "write" || tool === "multiedit";
      if (!isEdit && tool !== "read") return false;
      const abs = resolveFile2(cwd, fp);
      const seq = recordFile2(state, abs, isEdit);
      if (isEdit) {
        const doc = getChangeDoc2(abs);
        if (doc?.dir && doc.file) {
          addChangeDir(state, doc.dir);
          updateRequirementsForEdit2(state, doc.dir, doc.file, seq);
        }
      }
      return true;
    };
    var hasEditedSddChange2 = (state) => Object.values(state.files).some((file) => file.editedSeq && isSddChangePath(file.path || ""));
    module2.exports = {
      addChangeDir,
      addPath,
      applyToolRecord: applyToolRecord2,
      clearPeerSyncs: clearPeerSyncs2,
      clearStageOnlyRequirements: clearStageOnlyRequirements2,
      cleanupPeerSyncBucket,
      cleanupRequirementBucket,
      editedSddSeqAfter,
      editedSeq: editedSeq2,
      emptyState: emptyState2,
      fileMtimeMs,
      fileRecordOrder,
      firstEditedSeq,
      getPeerSyncBucket: getPeerSyncBucket2,
      getRequirementBucket,
      hasEditedSddChange: hasEditedSddChange2,
      isInitialTasksPlanEdit,
      isPeerSyncContinuation,
      latestEditedCodeSeq,
      latestStateEventMs,
      loadState: loadState2,
      markPeerSyncResponse,
      markToolEvent: markToolEvent2,
      markTranscriptEvent,
      normalizeState,
      pruneStateFiles: pruneStateFiles2,
      recordFile: recordFile2,
      saveState: saveState2,
      sessionFilesMax,
      touchedSeq: touchedSeq2,
      updateRequirementsForEdit: updateRequirementsForEdit2
    };
  }
});

// src/core/hydration.js
var require_hydration = __commonJS({
  "src/core/hydration.js"(exports2, module2) {
    var fs2 = require("fs");
    var os = require("os");
    var path2 = require("path");
    var { isCodePath: isCodePath2 } = require_file_classifier();
    var { normalizeKey: normalizeKey2, rel: rel2, resolveFile: resolveFile2, samePath: samePath2 } = require_paths();
    var {
      CHECKPOINT_MTIME_SCAN,
      CHECKPOINT_MTIME_SCAN_MAX_FILES,
      CHECKPOINT_MTIME_SCAN_MAX_VISITS,
      CHECKPOINT_MTIME_WINDOW_MS,
      CHECKPOINT_OUTPUT_TEXT_MAX_BYTES,
      DTS_CONTEXT_SKIP: DTS_CONTEXT_SKIP2
    } = require_runtime_config();
    var { hasSddWorkspace: hasSddWorkspace2 } = require_sdd_rules();
    var { applyToolRecord: applyToolRecord2, fileMtimeMs, markTranscriptEvent, recordFile: recordFile2 } = require_session_state();
    var { hash: hash2 } = require_state_storage();
    var { isSubagentCheckpointTool: isSubagentCheckpointTool2 } = require_tool_events();
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
    var limitString2 = (value, max = 500) => {
      const text = String(value || "");
      return text.length > max ? `${text.slice(0, max)}...` : text;
    };
    var isDtsContextActive2 = (state) => DTS_CONTEXT_SKIP2 && Boolean(state.dtsContext?.active);
    var resolveTranscriptPath2 = (input) => {
      const explicit = input?.transcript_path;
      if (explicit && typeof explicit === "string" && fs2.existsSync(explicit)) {
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
      return candidates.find((candidate) => fs2.existsSync(candidate)) || explicit;
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
      return `pos:${lineIndex}:${recordIndex}:${hash2(
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
      const stat = fs2.statSync(abs);
      const sameCursor = state.transcriptCursor?.path === abs;
      let offset = sameCursor ? Number(state.transcriptCursor?.offset || 0) : 0;
      let lineIndex = sameCursor ? Number(state.transcriptCursor?.lineIndex || 0) : 0;
      if (!Number.isFinite(offset) || offset < 0 || offset > stat.size) {
        offset = 0;
        lineIndex = 0;
      }
      const buffer = fs2.readFileSync(abs).subarray(offset);
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
    var hydrateStateFromTranscript2 = (cwd, state, transcriptPath) => {
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
      return applyToolRecord2(cwd, state, toolName, toolInput);
    };
    var collectCheckpointStrings = (value, depth = 0, seen = /* @__PURE__ */ new Set()) => {
      if (value == null || depth > 4) return [];
      if (typeof value === "string") return [limitString2(value, CHECKPOINT_OUTPUT_TEXT_MAX_BYTES)];
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
    var collectCheckpointOutputText2 = (input) => {
      const texts = [];
      for (const key of CHECKPOINT_OUTPUT_KEYS) {
        if (Object.prototype.hasOwnProperty.call(input || {}, key)) {
          texts.push(...collectCheckpointStrings(input[key]));
        }
      }
      return limitString2(texts.filter(Boolean).join("\n"), CHECKPOINT_OUTPUT_TEXT_MAX_BYTES);
    };
    var stripCheckpointPathToken = (token) => String(token || "").replace(/^[\s"'`(<\[\-*]+/, "").replace(/^\d+[.)]\s*/, "").replace(/[\s"'`)>.,;:\]]+$/, "");
    var isInsideWorkspace = (cwd, fp) => {
      const relative = path2.relative(path2.resolve(cwd), path2.resolve(fp));
      return Boolean(relative) && !relative.startsWith("..") && !path2.isAbsolute(relative);
    };
    var isIgnoredCheckpointPath = (cwd, fp) => {
      const relative = rel2(cwd, fp);
      return CHECKPOINT_PATH_IGNORE_RE.test(relative);
    };
    var checkpointLineMayDescribeEdit = (line, priorHeaderLines) => CHECKPOINT_EDIT_LINE_RE.test(line) || priorHeaderLines > 0;
    var extractCheckpointEditedPaths2 = (cwd, text) => {
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
          const abs = path2.isAbsolute(token) ? path2.resolve(token) : resolveFile2(cwd, token);
          if (!isInsideWorkspace(cwd, abs)) continue;
          if (isIgnoredCheckpointPath(cwd, abs)) continue;
          if (!fs2.existsSync(abs)) continue;
          if (!isCodePath2(abs)) continue;
          if (!paths.some((existing) => samePath2(existing, abs))) paths.push(path2.normalize(abs));
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
      const existing = state.files[normalizeKey2(fp)];
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
          entries = fs2.readdirSync(dir, { withFileTypes: true });
        } catch {
          continue;
        }
        for (const entry of entries) {
          if (visited >= maxVisits || found.length >= maxFiles) break;
          const fp = path2.join(dir, entry.name);
          if (!isInsideWorkspace(cwd, fp) && !samePath2(cwd, fp)) continue;
          if (isIgnoredCheckpointPath(cwd, fp)) continue;
          visited += 1;
          if (entry.isDirectory()) {
            stack.push(fp);
            continue;
          }
          if (!entry.isFile()) continue;
          if (!isCodePath2(fp)) continue;
          if (!shouldRecordCheckpointMtimePath(state, fp, cutoffMs)) continue;
          found.push(path2.normalize(fp));
        }
      }
      return found;
    };
    var hydrateStateFromCheckpointMtime2 = (cwd, state, input, text = collectCheckpointOutputText2(input)) => {
      const tool = String(input?.tool_name || "").toLowerCase();
      if (!CHECKPOINT_MTIME_SCAN) return false;
      if (!hasSddWorkspace2(cwd) || isDtsContextActive2(state)) return false;
      if (!isSubagentCheckpointTool2(tool, input?.tool_input || {})) return false;
      const hasText = Boolean(String(text || "").trim());
      if (hasText && !checkpointOutputSuggestsCodeEdit(text)) return false;
      const now = Date.now();
      const createdAt = Date.parse(state.createdAt || "") || now;
      const cutoffMs = Math.max(createdAt, now - checkpointMtimeWindowMs());
      let changed = false;
      for (const fp of scanRecentCheckpointCodePaths(cwd, state, cutoffMs)) {
        recordFile2(state, fp, true);
        changed = true;
      }
      return changed;
    };
    var hydrateStateFromCheckpointOutput2 = (cwd, state, input) => {
      const tool = String(input?.tool_name || "").toLowerCase();
      if (!isSubagentCheckpointTool2(tool, input?.tool_input || {})) return false;
      const text = collectCheckpointOutputText2(input);
      if (!text) return hydrateStateFromCheckpointMtime2(cwd, state, input, "");
      let changed = false;
      for (const fp of extractCheckpointEditedPaths2(cwd, text)) {
        recordFile2(state, fp, true);
        changed = true;
      }
      return changed || hydrateStateFromCheckpointMtime2(cwd, state, input, text);
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
      collectCheckpointOutputText: collectCheckpointOutputText2,
      collectCheckpointStrings,
      countTranscriptLines,
      extractCheckpointEditedPaths: extractCheckpointEditedPaths2,
      hydrateStateFromCheckpointMtime: hydrateStateFromCheckpointMtime2,
      hydrateStateFromCheckpointOutput: hydrateStateFromCheckpointOutput2,
      hydrateStateFromTranscript: hydrateStateFromTranscript2,
      isIgnoredCheckpointPath,
      isInsideWorkspace,
      readTranscriptChunk,
      recordToolFromHydration,
      resolveTranscriptPath: resolveTranscriptPath2,
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
    var { toPosix: toPosix2 } = require_paths();
    var splitPath = (fp) => toPosix2(fp).split("/").filter(Boolean);
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
      const normalizedCwd = toPosix2(cwd).replace(/\/+$/, "");
      const normalizedFile = toPosix2(fp);
      return normalizedFile.startsWith(`${normalizedCwd}/`) ? normalizedFile.slice(normalizedCwd.length + 1) : normalizedFile;
    };
    var pathInChangeDir = (cwd, fp, relDir) => {
      const relFile = relFromCwd(cwd, fp);
      const normalizedDir = toPosix2(relDir).replace(/\/+$/, "");
      return relFile === normalizedDir || relFile.startsWith(`${normalizedDir}/`);
    };
    var pathSimilar = (cwd, codeFile, linkedCode = []) => {
      const relCodeFile = relFromCwd(cwd, codeFile);
      return linkedCode.some((item) => {
        const linkedPath = toPosix2(item?.path || "");
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
    var Attribution2 = {
      decide,
      pathInChangeDir,
      pathSimilar,
      relFromCwd,
      sharedPrefixDepth,
      targetsForDecision
    };
    module2.exports = { Attribution: Attribution2 };
  }
});

// src/core/locks.js
var require_locks = __commonJS({
  "src/core/locks.js"(exports2, module2) {
    var fs2 = require("fs");
    var path2 = require("path");
    var { DEFAULT_LOCK_STALE_MS } = require_runtime_config();
    var sleepSync = (ms) => {
      if (ms <= 0) return;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
    };
    var acquireFileLock2 = (target, options = {}) => {
      const staleMs = options.staleMs || DEFAULT_LOCK_STALE_MS;
      const waitMs = options.waitMs || 0;
      const retryMs = options.retryMs || 25;
      const lockPath = `${target}.lock`;
      const openLock = () => {
        fs2.mkdirSync(path2.dirname(lockPath), { recursive: true });
        const fd = fs2.openSync(lockPath, "wx");
        fs2.writeFileSync(fd, `${process.pid}
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
          if (Date.now() - fs2.statSync(lockPath).mtimeMs > staleMs) fs2.unlinkSync(lockPath);
        } catch {
        }
        if (Date.now() >= deadline) return null;
        sleepSync(retryMs);
      }
    };
    var releaseFileLock2 = (lock) => {
      if (!lock) return;
      try {
        fs2.closeSync(lock.fd);
      } catch {
      }
      try {
        fs2.unlinkSync(lock.lockPath);
      } catch {
      }
    };
    module2.exports = {
      acquireFileLock: acquireFileLock2,
      releaseFileLock: releaseFileLock2,
      sleepSync
    };
  }
});

// src/core/diagnostics.js
var require_diagnostics = __commonJS({
  "src/core/diagnostics.js"(exports2, module2) {
    var fs2 = require("fs");
    var path2 = require("path");
    var { acquireFileLock: acquireFileLock2, releaseFileLock: releaseFileLock2 } = require_locks();
    var {
      DIAGNOSTIC_LOG,
      DIAGNOSTIC_LOG_MAX_BYTES,
      DIAGNOSTIC_LOG_RETENTION_DAYS,
      DIAGNOSTIC_SUMMARY_WINDOW_MS
    } = require_runtime_config();
    var { diagnosticLogPath: diagnosticLogPath2, writeTextAtomic } = require_state_storage();
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
    var recordDiagnosticSummaryEvent2 = (state, eventName, nowMs = Date.now(), windowMsValue = DIAGNOSTIC_SUMMARY_WINDOW_MS, trackedEvents = DIAGNOSTIC_SUMMARY_EVENTS) => {
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
        if (!fs2.existsSync(target)) return;
        if (fs2.statSync(target).size < maxBytes) return;
        const rotated = `${target}.1`;
        try {
          fs2.unlinkSync(rotated);
        } catch {
        }
        fs2.renameSync(target, rotated);
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
        text = fs2.readFileSync(target, "utf8");
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
          fs2.unlinkSync(target);
        } catch {
        }
        return;
      }
      writeTextAtomic(target, `${kept.join("\n")}
`);
    };
    var cleanupDiagnosticLogs2 = (target, now = Date.now()) => {
      const retentionMs = diagnosticLogRetentionMs();
      if (retentionMs === null) return;
      const cutoffMs = now - retentionMs;
      const dir = path2.dirname(target);
      const base = path2.basename(target);
      const rotatedPattern = new RegExp(`^${escapeRegExp(base)}\\.\\d+$`);
      try {
        for (const entry of fs2.readdirSync(dir, { withFileTypes: true })) {
          if (!entry.isFile()) continue;
          if (entry.name !== base && !rotatedPattern.test(entry.name)) continue;
          const fp = path2.join(dir, entry.name);
          const stat = fs2.statSync(fp);
          if (stat.mtimeMs < cutoffMs) {
            try {
              fs2.unlinkSync(fp);
            } catch {
            }
            continue;
          }
          pruneDiagnosticLogFile(fp, cutoffMs);
        }
      } catch {
      }
    };
    var writeDiagnosticLog2 = (cwd, event) => {
      if (!DIAGNOSTIC_LOG) return;
      let lock = null;
      try {
        const target = diagnosticLogPath2(cwd || process.cwd());
        fs2.mkdirSync(path2.dirname(target), { recursive: true });
        lock = acquireFileLock2(target);
        if (!lock) return;
        cleanupDiagnosticLogs2(target);
        rotateDiagnosticLog(target);
        const nowMs = Date.now();
        const lines = [
          ...recordDiagnosticSummaryEvent2(diagnosticSummaryState, event?.event, nowMs),
          event
        ].map(
          (entry) => JSON.stringify({
            ts: new Date(nowMs).toISOString(),
            pid: process.pid,
            ...entry
          })
        );
        fs2.appendFileSync(target, `${lines.join("\n")}
`);
      } catch {
      } finally {
        releaseFileLock2(lock);
      }
    };
    module2.exports = {
      DIAGNOSTIC_SUMMARY_EVENTS,
      cleanupDiagnosticLogs: cleanupDiagnosticLogs2,
      diagnosticLogRetentionMs,
      diagnosticSummaryLine,
      diagnosticSummaryState,
      diagnosticSummaryWindowMs,
      parseDiagnosticLogTs,
      pruneDiagnosticLogFile,
      recordDiagnosticSummaryEvent: recordDiagnosticSummaryEvent2,
      rotateDiagnosticLog,
      writeDiagnosticLog: writeDiagnosticLog2
    };
  }
});

// src/core/project-state.js
var require_project_state = __commonJS({
  "src/core/project-state.js"(exports2, module2) {
    var fs2 = require("fs");
    var path2 = require("path");
    var { isCodePath: isCodePath2 } = require_file_classifier();
    var { normalizeKey: normalizeKey2, samePath: samePath2, toPosix: toPosix2 } = require_paths();
    var { editedSeq: editedSeq2 } = require_session_state();
    var {
      DESIGN_FILE: DESIGN_FILE2,
      PROPOSAL_FILE: PROPOSAL_FILE2,
      TASKS_FILE: TASKS_FILE2,
      isArchivedChangeDir: isArchivedChangeDir2
    } = require_sdd_rules();
    var { projectStatePath: projectStatePath2, writeTextAtomic } = require_state_storage();
    var discoverChangeDirs2 = (cwd) => {
      const roots = ["sdd", ".sdd"].map((dir) => path2.join(cwd, dir));
      const dirs = [];
      for (const root of roots) {
        const changesRoot = path2.join(root, "changes");
        try {
          for (const entry of fs2.readdirSync(changesRoot, { withFileTypes: true })) {
            if (entry.isDirectory()) dirs.push(path2.join(changesRoot, entry.name));
          }
        } catch {
        }
      }
      return dirs;
    };
    var collectActiveChangeDirs2 = (cwd, state) => {
      const dirs = [...state.changeDirs || [], ...discoverChangeDirs2(cwd)];
      const active = [];
      for (const dir of dirs) {
        const normalized = path2.normalize(dir);
        if (isArchivedChangeDir2(normalized)) continue;
        if (!active.some((existing) => samePath2(existing, normalized))) active.push(normalized);
      }
      return active;
    };
    var emptyProjectState2 = () => ({
      version: 1,
      lastUpdatedAt: (/* @__PURE__ */ new Date()).toISOString(),
      changeDirs: {},
      activeChangeDir: null,
      activeUntilMs: 0,
      activeLastEditedSession: null
    });
    var relDirForProject2 = (cwd, dir) => toPosix2(path2.relative(cwd, dir));
    var docKeyForFile2 = (file) => {
      if (file === PROPOSAL_FILE2) return "proposal";
      if (file === DESIGN_FILE2) return "design";
      if (file === TASKS_FILE2) return "tasks";
      return null;
    };
    var docFileForKey = (key) => {
      if (key === "proposal") return PROPOSAL_FILE2;
      if (key === "design") return DESIGN_FILE2;
      if (key === "tasks") return TASKS_FILE2;
      return null;
    };
    var eventMsForFileRecord2 = (record, edited) => {
      const value = edited ? record?.editedAtMs : record?.touchedAtMs;
      if (Number.isFinite(value)) return value;
      if (Number.isFinite(record?.mtimeMs)) return Math.round(record.mtimeMs * 1e3);
      return Date.now() * 1e3;
    };
    var docRecordFromFs = (fp) => {
      try {
        const stat = fs2.statSync(fp);
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
    var createChangeDirFromFs2 = (cwd, dir) => {
      const normalized = path2.normalize(dir);
      const changeDir = {
        relDir: relDirForProject2(cwd, normalized),
        archived: isArchivedChangeDir2(normalized),
        docs: {
          proposal: docRecordFromFs(path2.join(normalized, PROPOSAL_FILE2)),
          design: docRecordFromFs(path2.join(normalized, DESIGN_FILE2)),
          tasks: docRecordFromFs(path2.join(normalized, TASKS_FILE2))
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
      changeDir.conditions = computeProjectConditions2(changeDir);
      changeDir.state = computeProjectState2(changeDir.conditions, changeDir.archived);
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
      const relDir = toPosix2(value?.relDir || relDirValue || "");
      const absDir = path2.join(cwd, relDir);
      const fromFs = createChangeDirFromFs2(cwd, absDir);
      const changeDir = {
        ...fromFs,
        ...value,
        relDir,
        archived: Boolean(value?.archived) || isArchivedChangeDir2(absDir),
        docs: {
          proposal: normalizeProjectDoc(value?.docs?.proposal || fromFs.docs.proposal),
          design: normalizeProjectDoc(value?.docs?.design || fromFs.docs.design),
          tasks: normalizeProjectDoc(value?.docs?.tasks || fromFs.docs.tasks)
        },
        linkedCode: Array.isArray(value?.linkedCode) ? value.linkedCode.filter((item) => item?.path && Number.isFinite(item?.lastEditedMs)).map((item) => ({
          path: toPosix2(item.path),
          lastEditedMs: Number(item.lastEditedMs),
          ...typeof item.lastEditedSession === "string" ? { lastEditedSession: item.lastEditedSession } : {},
          linkedAt: Number.isFinite(item.linkedAt) ? Number(item.linkedAt) : Number(item.lastEditedMs)
        })) : [],
        alignedAt: typeof value?.alignedAt === "string" ? value.alignedAt : null,
        alignedAtMs: Number.isFinite(value?.alignedAtMs) ? Number(value.alignedAtMs) : 0,
        docSyncs: value?.docSyncs && typeof value.docSyncs === "object" ? value.docSyncs : value?.peerSyncs && typeof value.peerSyncs === "object" ? value.peerSyncs : {}
      };
      delete changeDir.peerSyncs;
      changeDir.conditions = computeProjectConditions2(changeDir);
      changeDir.state = computeProjectState2(changeDir.conditions, changeDir.archived);
      return changeDir;
    };
    var computeProjectConditions2 = (dir) => {
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
      const tasksSyncedFromDesign = docSyncs.tasks?.sourceFile === DESIGN_FILE2 && Number(docSyncs.tasks.sourceEditedMs || 0) >= designEdited && Number(docSyncs.tasks.targetEditedMs || 0) >= Number(docSyncs.tasks.sourceEditedMs || 0);
      const designSyncedFromTasks = docSyncs.design?.sourceFile === TASKS_FILE2 && Number(docSyncs.design.sourceEditedMs || 0) >= tasksEdited && Number(docSyncs.design.targetEditedMs || 0) >= Number(docSyncs.design.sourceEditedMs || 0);
      const reviewTargets = [
        designExists ? [DESIGN_FILE2, designReviewed] : null,
        tasksExists ? [TASKS_FILE2, tasksReviewed] : null
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
    var computeProjectState2 = (conditions, archived) => {
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
    var recomputeProjectState2 = (project, cwd) => {
      for (const [relDirValue, dir] of Object.entries(project.changeDirs || {})) {
        const absDir = path2.join(cwd, dir.relDir || relDirValue);
        dir.archived = Boolean(dir.archived) || isArchivedChangeDir2(absDir);
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
        dir.conditions = computeProjectConditions2(dir);
        dir.state = computeProjectState2(dir.conditions, dir.archived);
      }
      project.lastUpdatedAt = (/* @__PURE__ */ new Date()).toISOString();
      return project;
    };
    var ensureProjectChangeDirs2 = (cwd, project) => {
      for (const dir of discoverChangeDirs2(cwd)) {
        const relDirValue = relDirForProject2(cwd, dir);
        if (!project.changeDirs[relDirValue]) {
          project.changeDirs[relDirValue] = createChangeDirFromFs2(cwd, dir);
        }
      }
      return recomputeProjectState2(project, cwd);
    };
    var normalizeProjectState2 = (cwd, parsed) => {
      const project = emptyProjectState2();
      if (parsed && typeof parsed === "object") {
        project.version = 1;
        project.lastUpdatedAt = typeof parsed.lastUpdatedAt === "string" && parsed.lastUpdatedAt ? parsed.lastUpdatedAt : project.lastUpdatedAt;
        project.activeChangeDir = typeof parsed.activeChangeDir === "string" ? toPosix2(parsed.activeChangeDir) : null;
        project.activeUntilMs = Number.isFinite(parsed.activeUntilMs) ? Number(parsed.activeUntilMs) : 0;
        project.activeLastEditedSession = typeof parsed.activeLastEditedSession === "string" ? parsed.activeLastEditedSession : null;
        project.changeDirs = {};
        for (const [relDirValue, value] of Object.entries(parsed.changeDirs || {})) {
          project.changeDirs[toPosix2(relDirValue)] = normalizeProjectChangeDir(cwd, relDirValue, value);
        }
      }
      return ensureProjectChangeDirs2(cwd, project);
    };
    var quarantineCorruptStateFile = (fp) => {
      try {
        if (!fs2.existsSync(fp)) return;
        fs2.renameSync(fp, `${fp}.corrupt-${Date.now()}`);
      } catch {
      }
    };
    var loadProjectState2 = (cwd) => {
      const fp = projectStatePath2(cwd);
      try {
        return normalizeProjectState2(cwd, JSON.parse(fs2.readFileSync(fp, "utf8")));
      } catch (err) {
        if (err?.code !== "ENOENT") quarantineCorruptStateFile(fp);
        return normalizeProjectState2(cwd, emptyProjectState2());
      }
    };
    var saveProjectState2 = (cwd, project) => {
      recomputeProjectState2(project, cwd);
      writeTextAtomic(projectStatePath2(cwd), JSON.stringify(project, null, 2));
    };
    var collectCarryOverDrift2 = (project) => Object.values(project?.changeDirs || {}).filter((dir) => !dir.archived).filter((dir) => dir.state !== "ALIGNED" && dir.state !== "PROPOSAL_STAGE");
    var refreshAlignedBaseline2 = (cwd, project, state) => {
      if (!project) return false;
      const nowMs = Date.now() * 1e3;
      let changed = false;
      for (const dir of Object.values(project.changeDirs || {})) {
        if (dir.archived) continue;
        const linkedCodeRecords = (dir.linkedCode || []).map((item) => state.files?.[normalizeKey2(path2.join(cwd, item.path))]).filter((record) => record?.editedSeq && isCodePath2(record.path || ""));
        if (!linkedCodeRecords.length) continue;
        const latestCodeSeq = Math.max(0, ...linkedCodeRecords.map((record) => Number(record.editedSeq || 0)));
        if (!latestCodeSeq) continue;
        const docPaths = [DESIGN_FILE2, TASKS_FILE2].filter((file) => dir.docs?.[docKeyForFile2(file)]?.exists).map((file) => path2.join(cwd, dir.relDir, file));
        if (!docPaths.length) continue;
        const docSeqs = docPaths.map((file) => editedSeq2(state, file));
        const allDocsEditedBeforeCode = docSeqs.every((seq) => seq > 0 && seq < latestCodeSeq);
        if (!allDocsEditedBeforeCode) continue;
        const latestCodeMs = Math.max(0, ...linkedCodeRecords.map((record) => eventMsForFileRecord2(record, true)));
        if (Number(dir.alignedAtMs || 0) >= latestCodeMs) continue;
        dir.alignedAtMs = Math.max(nowMs, latestCodeMs);
        dir.alignedAt = (/* @__PURE__ */ new Date()).toISOString();
        changed = true;
      }
      if (changed) recomputeProjectState2(project, cwd);
      return changed;
    };
    module2.exports = {
      collectActiveChangeDirs: collectActiveChangeDirs2,
      collectCarryOverDrift: collectCarryOverDrift2,
      computeProjectConditions: computeProjectConditions2,
      computeProjectState: computeProjectState2,
      createChangeDirFromFs: createChangeDirFromFs2,
      discoverChangeDirs: discoverChangeDirs2,
      docFileForKey,
      docKeyForFile: docKeyForFile2,
      docRecordFromFs,
      emptyProjectState: emptyProjectState2,
      ensureProjectChangeDirs: ensureProjectChangeDirs2,
      eventMsForFileRecord: eventMsForFileRecord2,
      loadProjectState: loadProjectState2,
      normalizeProjectChangeDir,
      normalizeProjectDoc,
      normalizeProjectState: normalizeProjectState2,
      quarantineCorruptStateFile,
      recomputeProjectState: recomputeProjectState2,
      refreshAlignedBaseline: refreshAlignedBaseline2,
      relDirForProject: relDirForProject2,
      saveProjectState: saveProjectState2
    };
  }
});

// src/core/drift-engine.js
var require_drift_engine = __commonJS({
  "src/core/drift-engine.js"(exports2, module2) {
    var fs2 = require("fs");
    var path2 = require("path");
    var { isCodePath: isCodePath2 } = require_file_classifier();
    var { rel: rel2, samePath: samePath2, toPosix: toPosix2 } = require_paths();
    var {
      collectActiveChangeDirs: collectActiveChangeDirs2,
      computeProjectConditions: computeProjectConditions2,
      discoverChangeDirs: discoverChangeDirs2,
      docKeyForFile: docKeyForFile2
    } = require_project_state();
    var {
      editedSeq: editedSeq2,
      editedSddSeqAfter,
      hasEditedSddChange: hasEditedSddChange2,
      touchedSeq: touchedSeq2
    } = require_session_state();
    var { CODE_REVIEW_CONFIRMATION_CAP, DTS_CONTEXT_SKIP: DTS_CONTEXT_SKIP2 } = require_runtime_config();
    var {
      DESIGN_FILE: DESIGN_FILE2,
      PEER_FILES,
      PROPOSAL_FILE: PROPOSAL_FILE2,
      REVIEW_FILES,
      TASKS_FILE: TASKS_FILE2,
      getChangeDoc: getChangeDoc2,
      hasSddWorkspace: hasSddWorkspace2,
      isArchivedChangeDir: isArchivedChangeDir2
    } = require_sdd_rules();
    var { hash: hash2 } = require_state_storage();
    var isDtsContextActive2 = (state) => DTS_CONTEXT_SKIP2 && Boolean(state.dtsContext?.active);
    var drift2 = (cwd, fp, state) => {
      const warn = [];
      const doc = getChangeDoc2(fp);
      if (!hasSddWorkspace2(cwd) || isDtsContextActive2(state)) return warn;
      if (doc?.root) {
        if (doc.rel.startsWith("specs/")) {
          warn.push(
            `SDD DRIFT: ${doc.rel} was changed directly. SDD changes should normally go through sdd/changes/<id>/. If this bypass is intentional, mention it explicitly.`
          );
        }
        return warn;
      }
      if (isCodePath2(fp) && !hasEditedSddChange2(state)) {
        warn.push(
          `SDD DRIFT: code file ${path2.basename(fp)} was changed, but this session did not edit any sdd/changes/** file. SDD expects a change proposal first.`
        );
      }
      return warn;
    };
    var collectPeerGaps2 = (cwd, state, options = {}) => {
      const includeStageOnly = options.includeStageOnly !== false;
      const includeHard = options.includeHard !== false;
      const gaps = [];
      for (const bucket of Object.values(state.requirements || {})) {
        const dir = bucket.dir;
        if (isArchivedChangeDir2(dir)) continue;
        const absent = [];
        const unsynced = [];
        const stale = [];
        const required = [];
        const pendingRequirements = [];
        for (const [file, requirement] of Object.entries(bucket.files || {})) {
          const requirementStageOnly = Boolean(requirement?.stageOnly || requirement?.sourceFile === PROPOSAL_FILE2);
          if (requirementStageOnly ? !includeStageOnly : !includeHard) continue;
          const peerPath = path2.join(dir, file);
          const seq = editedSeq2(state, peerPath);
          if (seq > requirement.afterSeq) continue;
          required.push(file);
          pendingRequirements.push({ file, ...requirement, stageOnly: requirementStageOnly });
          if (!fs2.existsSync(peerPath)) {
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
        const edited = [PROPOSAL_FILE2, ...PEER_FILES].filter((file) => editedSeq2(state, path2.join(dir, file)) > 0);
        const relDir = toPosix2(path2.relative(cwd, dir));
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
    var collectProjectPeerGaps2 = (cwd, project, options = {}) => {
      const includeStageOnly = options.includeStageOnly !== false;
      const includeHard = options.includeHard !== false;
      const gaps = [];
      for (const dir of Object.values(project?.changeDirs || {})) {
        if (dir.archived) continue;
        const absDir = path2.join(cwd, dir.relDir);
        const conditions = computeProjectConditions2(dir);
        const required = [];
        const sourceFiles = [];
        if (conditions.proposalOnly && includeStageOnly) continue;
        if (conditions.designAheadOfTasks && includeHard) {
          required.push(TASKS_FILE2);
          sourceFiles.push(DESIGN_FILE2);
        }
        if (conditions.tasksAheadOfDesign && includeHard) {
          required.push(DESIGN_FILE2);
          sourceFiles.push(TASKS_FILE2);
        }
        if (!required.length) continue;
        gaps.push({
          relDir: dir.relDir,
          edited: [PROPOSAL_FILE2, DESIGN_FILE2, TASKS_FILE2].filter((file) => {
            const key = docKeyForFile2(file);
            return Number(dir.docs?.[key]?.lastEditedMs || 0) > 0;
          }),
          sourceFiles,
          stageOnly: false,
          absent: required.filter((file) => !fs2.existsSync(path2.join(absDir, file))),
          missing: required.filter((file) => !fs2.existsSync(path2.join(absDir, file))),
          unsynced: required.filter((file) => fs2.existsSync(path2.join(absDir, file))),
          stale: [],
          required,
          projectLevel: true
        });
      }
      return gaps;
    };
    var collectProjectCodeGaps2 = (cwd, project) => {
      if (!project || !hasSddWorkspace2(cwd)) return [];
      const gaps = [];
      for (const dir of Object.values(project.changeDirs || {})) {
        if (dir.archived) continue;
        const conditions = computeProjectConditions2(dir);
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
          reviewSignature: hash2(
            JSON.stringify({
              type: "project-code",
              relDir: dir.relDir,
              latestCodeMs,
              reviewTargets: reviewTargets.map((file) => rel2(cwd, file)).sort()
            })
          )
        });
      }
      return gaps;
    };
    var codeReviewSignature2 = (cwd, gap) => hash2(
      JSON.stringify({
        codeFiles: (gap.codeFiles || []).map((file) => rel2(cwd, file)).sort(),
        latestCodeSeq: gap.latestCodeSeq || 0,
        reviewTargets: (gap.reviewTargets || []).map((file) => rel2(cwd, file)).sort()
      })
    );
    var isCodeReviewConfirmed = (state, signature) => Boolean(signature && state.codeReviewConfirmations?.[signature]?.confirmed);
    var collectReviewTargets2 = (cwd, state) => {
      if (!hasSddWorkspace2(cwd)) return [];
      const discoveredDirs = [...state.changeDirs || [], ...discoverChangeDirs2(cwd)];
      const dirs = collectActiveChangeDirs2(cwd, state);
      const targets = [];
      for (const dir of dirs) {
        for (const file of REVIEW_FILES) {
          const target = path2.join(dir, file);
          if (!fs2.existsSync(target)) continue;
          if (!targets.some((existing) => samePath2(existing, target))) {
            targets.push(path2.normalize(target));
          }
        }
      }
      if (targets.length || dirs.length || discoveredDirs.length) return targets;
      const fallbackRoot = fs2.existsSync(path2.join(cwd, ".sdd")) ? ".sdd" : "sdd";
      return REVIEW_FILES.map((file) => path2.join(cwd, fallbackRoot, "changes", "<change-id>", file));
    };
    var collectCodeGaps2 = (cwd, state) => {
      if (!hasSddWorkspace2(cwd) || isDtsContextActive2(state)) return [];
      const codeFiles = Object.values(state.files || {}).filter((file) => file.editedSeq && isCodePath2(file.path || "")).sort((left, right) => (right.editedSeq || 0) - (left.editedSeq || 0));
      if (!codeFiles.length) return [];
      const latestCodeSeq = codeFiles[0].editedSeq || 0;
      const reviewTargets = collectReviewTargets2(cwd, state);
      const pendingReviewTargets = reviewTargets.filter((file) => touchedSeq2(state, file) <= latestCodeSeq);
      const baseGap = {
        codeFiles: codeFiles.map((file) => file.path),
        latestCodeSeq,
        reviewTargets,
        pendingReviewTargets
      };
      const reviewSignature = codeReviewSignature2(cwd, baseGap);
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
    var collectCombinedPeerGaps2 = (cwd, state, project, options = {}) => {
      const combined = [
        ...collectPeerGaps2(cwd, state, options),
        ...collectProjectPeerGaps2(cwd, project, options)
      ];
      const seen = /* @__PURE__ */ new Set();
      return combined.filter((gap) => {
        const key = `${gap.relDir}:${gap.required.sort().join(",")}:${gap.sourceFiles.sort().join(",")}:${gap.stageOnly}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    };
    var collectCombinedCodeGaps2 = (cwd, state, project) => {
      const sessionGaps = collectCodeGaps2(cwd, state);
      const rawProjectGaps = collectProjectCodeGaps2(cwd, project);
      const projectGaps = rawProjectGaps.filter(
        (gap) => !state.codeReviewConfirmations?.[gap.reviewSignature]?.implementationFlow && !isCodeReviewConfirmed(state, gap.reviewSignature)
      );
      const codeFilesKey = (gap) => (gap.codeFiles || []).map((file) => rel2(cwd, file)).sort().join("\0");
      const projectCodeKeys = new Set(rawProjectGaps.map(codeFilesKey));
      const projectLinkedCode = new Set(
        Object.values(project?.changeDirs || {}).flatMap(
          (dir) => (dir.linkedCode || []).map((item) => toPosix2(item.path))
        )
      );
      const allCodeFilesTrackedByProject = (gap) => (gap.codeFiles || []).every((file) => projectLinkedCode.has(rel2(cwd, file)));
      const combined = [
        ...sessionGaps.filter(
          (gap) => !projectCodeKeys.has(codeFilesKey(gap)) && !allCodeFilesTrackedByProject(gap)
        ),
        ...projectGaps
      ];
      const seen = /* @__PURE__ */ new Set();
      return combined.filter((gap) => {
        const key = JSON.stringify({
          codeFiles: (gap.codeFiles || []).map((file) => rel2(cwd, file)).sort(),
          reviewTargets: (gap.reviewTargets || []).map((file) => rel2(cwd, file)).sort()
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
    var markCodeReviewNoEditConfirmation2 = (state, gaps) => {
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
      codeReviewSignature: codeReviewSignature2,
      collectCodeGaps: collectCodeGaps2,
      collectCombinedCodeGaps: collectCombinedCodeGaps2,
      collectCombinedPeerGaps: collectCombinedPeerGaps2,
      collectPeerGaps: collectPeerGaps2,
      collectProjectCodeGaps: collectProjectCodeGaps2,
      collectProjectPeerGaps: collectProjectPeerGaps2,
      collectReviewTargets: collectReviewTargets2,
      drift: drift2,
      isCodeReviewConfirmed,
      isDtsContextActive: isDtsContextActive2,
      markCodeReviewNoEditConfirmation: markCodeReviewNoEditConfirmation2,
      pruneCodeReviewConfirmations
    };
  }
});

// src/core/prompts.js
var require_prompts = __commonJS({
  "src/core/prompts.js"(exports2, module2) {
    var { collectCombinedCodeGaps: collectCombinedCodeGaps2, collectCombinedPeerGaps: collectCombinedPeerGaps2 } = require_drift_engine();
    var { rel: rel2 } = require_paths();
    var { collectCarryOverDrift: collectCarryOverDrift2 } = require_project_state();
    var {
      ACTIVE_SDD_ALIGNMENT_RULES,
      DOCUMENT_SYNC_RULES,
      RESUME_ORIGINAL_TASK_RULES,
      SUBAGENT_REVIEW_RULE,
      formatAttributionReviewRules
    } = require_sdd_rules();
    var { hash: hash2 } = require_state_storage();
    var SYSTEM_DIRECTIVE_PREFIX = "SDD-DRIFT-CHECK";
    var section = (title, lines = []) => ["", title, ...lines.filter(Boolean)];
    var buildSystemReminder = (type, lines) => [
      "<system-reminder>",
      `[SYSTEM DIRECTIVE: ${SYSTEM_DIRECTIVE_PREFIX} - ${type}]`,
      ...lines.filter((line) => line !== null && line !== void 0),
      "</system-reminder>"
    ].join("\n");
    var stripSystemReminderWrapper = (message) => String(message || "").trim().replace(/^<system-reminder>\s*/i, "").replace(/\s*<\/system-reminder>\s*$/i, "").trim();
    var buildAttributionReviewPrompt2 = (cwd, { codeFiles = [], candidates = [] } = {}) => {
      const codeLines = codeFiles.length ? codeFiles.map((file) => `  - ${rel2(cwd, file)}`) : ["  - unknown code file"];
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
          ...DOCUMENT_SYNC_RULES
        ]),
        ...section("ATTRIBUTION RULES", formatAttributionReviewRules())
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
    var buildToolEnforcement2 = (gaps, options = {}) => {
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
          ...section("EXIT CRITERIA", RESUME_ORIGINAL_TASK_RULES)
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
        ...section("SDD EDIT RULES", DOCUMENT_SYNC_RULES),
        ...section("EXIT CRITERIA", [
          ...RESUME_ORIGINAL_TASK_RULES,
          "Do not stop or summarize completion until the required peer document(s) are updated."
        ])
      ]);
    };
    var formatCodeReviewTargets = (cwd, files) => files.map((file) => rel2(cwd, file)).join(", ");
    var buildCodeEnforcement2 = (cwd, gaps, options = {}) => {
      const compact = Boolean(options.compact);
      const detail = gaps.map((gap) => {
        const codeList = gap.codeFiles.map((file) => rel2(cwd, file)).join(", ");
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
            SUBAGENT_REVIEW_RULE
          ]),
          ...section("SDD EDIT RULES", [
            "If you edit an SDD document, preserve its existing Markdown headings and template; do not replace it with a summary or single-line marker.",
            ...DOCUMENT_SYNC_RULES
          ]),
          ...section("ALIGNMENT RULES", [
            ...ACTIVE_SDD_ALIGNMENT_RULES,
            ...formatAttributionReviewRules()
          ]),
          ...section("EXIT CRITERIA", [
            "After both documents have been reviewed, resume the original user task if anything remains; finish only if the original task is already complete.",
            ...RESUME_ORIGINAL_TASK_RULES
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
          SUBAGENT_REVIEW_RULE
        ]),
        ...section("SDD EDIT RULES", [
          ...DOCUMENT_SYNC_RULES,
          "Do not create a no-op edit or add a new section just to satisfy this hook."
        ]),
        ...section("ALIGNMENT RULES", [
          ...ACTIVE_SDD_ALIGNMENT_RULES,
          ...formatAttributionReviewRules()
        ]),
        ...section("EXIT CRITERIA", [
          ...RESUME_ORIGINAL_TASK_RULES,
          "Do not give the final answer while this code-change batch still has unreviewed SDD documents."
        ])
      ]);
    };
    var buildCodeToolReminder2 = (cwd, gaps) => {
      const detail = gaps.map((gap) => {
        const codeList = gap.codeFiles.map((file) => rel2(cwd, file)).join(", ");
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
          SUBAGENT_REVIEW_RULE
        ]),
        ...section("EXIT CRITERIA", RESUME_ORIGINAL_TASK_RULES)
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
    var serializableCodeGap2 = (cwd, gap) => ({
      codeFiles: (gap.codeFiles || []).map((file) => rel2(cwd, file)).sort(),
      latestCodeSeq: gap.latestCodeSeq || 0,
      reviewTargets: (gap.reviewTargets || []).map((file) => rel2(cwd, file)).sort(),
      pendingReviewTargets: (gap.pendingReviewTargets || []).map((file) => rel2(cwd, file)).sort(),
      reviewReady: Boolean(gap.reviewReady),
      needsConfirmation: Boolean(gap.needsConfirmation)
    });
    var peerDriftSignature2 = (peerGaps) => hash2(JSON.stringify({ type: "peer", gaps: peerGaps.map(serializablePeerGap) }));
    var buildSubagentCheckpointEnforcement2 = (cwd, state, project = null) => {
      const hardPeerGaps = collectCombinedPeerGaps2(cwd, state, project, { includeStageOnly: false });
      if (hardPeerGaps.length) {
        return {
          type: "peer",
          signature: hash2(JSON.stringify({ type: "subagent-peer", gaps: hardPeerGaps.map(serializablePeerGap) })),
          message: buildToolEnforcement2(hardPeerGaps, { compact: true })
        };
      }
      const pendingCodeGaps = collectCombinedCodeGaps2(cwd, state, project).filter((gap) => !gap.reviewReady);
      if (pendingCodeGaps.length) {
        return {
          type: "code",
          signature: hash2(
            JSON.stringify({
              type: "subagent-code",
              gaps: pendingCodeGaps.map((gap) => serializableCodeGap2(cwd, gap))
            })
          ),
          message: buildCodeEnforcement2(cwd, pendingCodeGaps, { compact: true })
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
      ...section("EXIT CRITERIA", RESUME_ORIGINAL_TASK_RULES),
      ...section("PENDING SDD REMINDER", [stripSystemReminderWrapper(message)])
    ]);
    var buildQuestionCheckpointEnforcement2 = (cwd, state, project = null) => {
      const hardPeerGaps = collectCombinedPeerGaps2(cwd, state, project, { includeStageOnly: false });
      if (hardPeerGaps.length) {
        return {
          type: "peer",
          signature: hash2(JSON.stringify({ type: "question-peer", gaps: hardPeerGaps.map(serializablePeerGap) })),
          message: buildQuestionCheckpointMessage(buildToolEnforcement2(hardPeerGaps, { compact: true }))
        };
      }
      const pendingCodeGaps = collectCombinedCodeGaps2(cwd, state, project).filter((gap) => !gap.reviewReady);
      if (pendingCodeGaps.length) {
        return {
          type: "code",
          signature: hash2(
            JSON.stringify({
              type: "question-code",
              gaps: pendingCodeGaps.map((gap) => serializableCodeGap2(cwd, gap))
            })
          ),
          message: buildQuestionCheckpointMessage(buildCodeEnforcement2(cwd, pendingCodeGaps, { compact: true }))
        };
      }
      return null;
    };
    var buildPendingEnforcement2 = (cwd, state, options = {}) => {
      const project = options.project || null;
      const peerGaps = collectCombinedPeerGaps2(cwd, state, project, {
        includeStageOnly: options.includeStageOnly !== false
      });
      if (peerGaps.length) {
        return {
          type: "peer",
          message: buildToolEnforcement2(peerGaps),
          signature: peerDriftSignature2(peerGaps)
        };
      }
      const codeGaps = collectCombinedCodeGaps2(cwd, state, project);
      if (codeGaps.length) {
        return {
          type: "code",
          message: buildCodeEnforcement2(cwd, codeGaps),
          signature: hash2(JSON.stringify({ type: "code", gaps: codeGaps.map((gap) => serializableCodeGap2(cwd, gap)) })),
          gaps: codeGaps
        };
      }
      return null;
    };
    var buildStopEnforcement2 = (pendingMessage) => buildSystemReminder("STOP ENFORCEMENT", [
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
    var formatCarryOverReminder2 = (project, options = {}) => {
      const driftDirs = collectCarryOverDrift2(project);
      if (!driftDirs.length) return "";
      return buildSystemReminder("CARRY-OVER DRIFT", [
        ...section("STATE", [
          `${options.prefix || ""}SDD carry-over drift from prior sessions:`,
          ...driftDirs.map((dir) => `- ${dir.relDir}: ${dir.state}`)
        ]),
        ...section("REQUIRED ACTION", [
          "Before final answer, review these active SDD change directories and synchronize design.md/tasks.md with the implementation if needed.",
          SUBAGENT_REVIEW_RULE
        ])
      ]);
    };
    var buildPreCompactSummary2 = (cwdOrProject, stateOrNull = null, projectOrNull = null) => {
      const legacyCall = typeof cwdOrProject !== "string";
      const cwd = legacyCall ? "" : cwdOrProject;
      const state = legacyCall ? null : stateOrNull;
      const project = legacyCall ? cwdOrProject : projectOrNull;
      const driftDirs = collectCarryOverDrift2(project);
      const pending = cwd && state ? buildQuestionCheckpointEnforcement2(cwd, state, project) : null;
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
          ...section("EXIT CRITERIA", RESUME_ORIGINAL_TASK_RULES),
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
        ...section("EXIT CRITERIA", RESUME_ORIGINAL_TASK_RULES)
      ]);
    };
    module2.exports = {
      buildAttributionReviewPrompt: buildAttributionReviewPrompt2,
      buildCodeEnforcement: buildCodeEnforcement2,
      buildCodeToolReminder: buildCodeToolReminder2,
      buildPendingEnforcement: buildPendingEnforcement2,
      buildPreCompactSummary: buildPreCompactSummary2,
      buildQuestionCheckpointEnforcement: buildQuestionCheckpointEnforcement2,
      buildQuestionCheckpointMessage,
      buildStopEnforcement: buildStopEnforcement2,
      buildSubagentCheckpointEnforcement: buildSubagentCheckpointEnforcement2,
      buildToolEnforcement: buildToolEnforcement2,
      formatCarryOverReminder: formatCarryOverReminder2,
      formatCodeReviewTargets,
      formatGap,
      peerDriftSignature: peerDriftSignature2,
      serializableCodeGap: serializableCodeGap2,
      serializablePeerGap
    };
  }
});

// src/core/report.js
var require_report = __commonJS({
  "src/core/report.js"(exports2, module2) {
    var fs2 = require("fs");
    var path2 = require("path");
    var { collectCombinedCodeGaps: collectCombinedCodeGaps2, collectCombinedPeerGaps: collectCombinedPeerGaps2 } = require_drift_engine();
    var { rel: rel2 } = require_paths();
    var { formatGap } = require_prompts();
    var { editedSddSeqAfter } = require_session_state();
    var { writeTextAtomic } = require_state_storage();
    var confirmationStillNeedsHumanReview = (state, confirmation) => !editedSddSeqAfter(state, confirmation?.reviewTargets || [], Number(confirmation?.codeSeq || 0));
    var collectCodeReviewAdvisoryLines = (cwd, state) => Object.values(state.codeReviewConfirmations || {}).filter((confirmation) => confirmation?.confirmed && confirmation?.userConfirmationRecommended).filter((confirmation) => confirmationStillNeedsHumanReview(state, confirmation)).sort((left, right) => {
      const leftSeq = Number(left.codeSeq || 0);
      const rightSeq = Number(right.codeSeq || 0);
      return rightSeq - leftSeq;
    }).map((confirmation) => {
      const codeList = (confirmation.codeFiles || []).map((file) => rel2(cwd, file)).join(", ");
      const reviewList = (confirmation.reviewTargets || []).map((file) => rel2(cwd, file)).join(", ");
      return `  - reviewed SDD document(s) after code change(s) [${codeList || "unknown"}] and made no SDD edits. User confirmation recommended for: ${reviewList || "design.md, tasks.md"}`;
    });
    var collectReportLines2 = (cwd, state, project = null) => {
      const lines = collectCombinedPeerGaps2(cwd, state, project, { includeStageOnly: false }).map(
        (gap) => `  - ${formatGap(gap)}`
      );
      for (const gap of collectCombinedCodeGaps2(cwd, state, project)) {
        const codeList = gap.codeFiles.map((file) => rel2(cwd, file)).join(", ");
        const reviewList = (gap.pendingReviewTargets || gap.reviewTargets || []).map((file) => rel2(cwd, file)).join(", ");
        lines.push(
          `  - edited code file(s) [${codeList}], but did not review SDD document(s) after the code change: ${reviewList}`
        );
      }
      lines.push(...collectCodeReviewAdvisoryLines(cwd, state));
      return lines;
    };
    var refreshReport2 = (cwd, state, project = null) => {
      const reportPath = path2.join(cwd, ".sdd-drift-report.md");
      const lines = collectReportLines2(cwd, state, project);
      if (lines.length) {
        try {
          const body = lines.join("\n") + "\n";
          try {
            const existing = fs2.readFileSync(reportPath, "utf8");
            if (existing.replace(/^## .*\r?\n/, "") === body) return;
          } catch {
          }
          writeTextAtomic(reportPath, "## " + (/* @__PURE__ */ new Date()).toISOString() + "\n" + body);
        } catch {
        }
        return;
      }
      try {
        fs2.unlinkSync(reportPath);
      } catch {
      }
    };
    module2.exports = {
      collectCodeReviewAdvisoryLines,
      collectReportLines: collectReportLines2,
      confirmationStillNeedsHumanReview,
      refreshReport: refreshReport2
    };
  }
});

// src/core/output.js
var require_output = __commonJS({
  "src/core/output.js"(exports2, module2) {
    var createOutputHelpers2 = ({
      isOpenCodeHookInput: isOpenCodeHookInput2,
      opencodeStopReportOnly = false,
      strictBlock = false,
      stdout = process.stdout,
      stderr = process.stderr,
      exit = process.exit
    } = {}) => {
      if (typeof isOpenCodeHookInput2 !== "function") {
        throw new TypeError("isOpenCodeHookInput is required");
      }
      const buildClaudeCodeOutput2 = (hookEventName, message) => JSON.stringify({
        hookSpecificOutput: {
          hookEventName: hookEventName || "PostToolUse",
          additionalContext: message
        }
      });
      const buildPreToolUseDenyOutput2 = (message) => JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: message,
          additionalContext: message
        }
      });
      const buildStopOutput2 = (input, message) => {
        if (isOpenCodeHookInput2(input)) {
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
      const emitEnforcement2 = (input, message) => {
        if (strictBlock) {
          stderr.write(message);
          exit(2);
          return;
        }
        if (input?.hook_event_name === "PreToolUse") {
          stdout.write(buildPreToolUseDenyOutput2(message));
          return;
        }
        if (isOpenCodeHookInput2(input)) {
          stdout.write(message);
          return;
        }
        stdout.write(buildClaudeCodeOutput2(input?.hook_event_name, message));
      };
      const emitStopEnforcement2 = (input, message) => {
        if (strictBlock) {
          stderr.write(message);
          exit(2);
          return;
        }
        stdout.write(buildStopOutput2(input, message));
      };
      return {
        buildClaudeCodeOutput: buildClaudeCodeOutput2,
        buildPreToolUseDenyOutput: buildPreToolUseDenyOutput2,
        buildStopOutput: buildStopOutput2,
        emitEnforcement: emitEnforcement2,
        emitStopEnforcement: emitStopEnforcement2
      };
    };
    module2.exports = {
      createOutputHelpers: createOutputHelpers2
    };
  }
});

// src/adapters/claude-code/command-hook.js
var crypto = require("crypto");
var fs = require("fs");
var path = require("path");
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
    const designEditedInSession = key === "tasks" && editedSeq(state, path.join(doc.dir, DESIGN_FILE)) > 0 && editedSeq(state, path.join(doc.dir, DESIGN_FILE)) < Number(record.editedSeq || 0);
    const tasksEditedInSession = key === "design" && editedSeq(state, path.join(doc.dir, TASKS_FILE)) > 0 && editedSeq(state, path.join(doc.dir, TASKS_FILE)) < Number(record.editedSeq || 0);
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
  const relPath = toPosix(path.relative(root, fp));
  const match = relPath.match(/^changes\/([^/]+)(?:\/|$)/);
  if (!match) return null;
  return {
    root,
    id: match[1],
    dir: path.join(root, "changes", match[1]),
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
  const existing = (dir.linkedCode || []).find((item) => samePath(path.join(cwd, item.path), record.path));
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
var {
  buildClaudeCodeOutput,
  buildPreToolUseDenyOutput,
  buildStopOutput,
  emitEnforcement,
  emitStopEnforcement
} = createOutputHelpers({
  isOpenCodeHookInput,
  opencodeStopReportOnly: OPENCODE_STOP_REPORT_ONLY,
  strictBlock: STRICT_BLOCK
});
var dispatch = async (input) => {
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
    const handlerContext = {
      cwd,
      sessionID,
      state,
      project,
      applySessionToProject,
      applyToolRecord,
      buildClaudeCodeOutput,
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
      emitEnforcement,
      emitStopEnforcement,
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
      writeStdout: (message) => process.stdout.write(message)
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
if (require.main === module) {
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
  module.exports = {
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
