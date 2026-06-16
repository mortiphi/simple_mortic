import type { AppServerActivity, AppServerActivityKind } from "../shared/types.js";

export type AppServerRawTrace = {
  method: string;
  turnId?: string;
  itemType?: string;
  itemId?: string;
  detail?: string;
};

export type AppServerNormalizedEvent = {
  raw: AppServerRawTrace;
  activity?: Omit<AppServerActivity, "id" | "elapsedMs">;
};

const MAX_SAFE_DETAIL = 180;

function textCandidate(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value;
  }
  return undefined;
}

function safeSnippet(value: string, max = MAX_SAFE_DETAIL): string {
  return value.replace(/\s+/g, " ").trim().slice(0, max);
}

function byteDelta(value: unknown, label: string): string {
  return `${label} ${Buffer.byteLength(typeof value === "string" ? value : "", "utf8")} bytes`;
}

export function appServerItemType(params: any): string | undefined {
  const item = params?.item;
  const candidates = [item?.type, params?.itemType, params?.type];
  return candidates.find((value): value is string => typeof value === "string" && value.trim().length > 0);
}

export function appServerItemId(params: any): string | undefined {
  const value = params?.item?.id ?? params?.itemId ?? params?.id;
  return typeof value === "string" ? value : undefined;
}

export function appServerTurnId(params: any): string | undefined {
  const value = params?.turnId ?? params?.turn?.id ?? params?.item?.turnId ?? params?.item?.turn_id;
  return typeof value === "string" ? value : undefined;
}

function itemStartedActivity(method: string, itemType: string | undefined, itemId: string | undefined): AppServerNormalizedEvent["activity"] {
  const started: Record<string, { kind: AppServerActivityKind; label: string }> = {
    commandExecution: { kind: "command", label: "Running command" },
    mcpToolCall: { kind: "tool", label: "Checking tool" },
    dynamicToolCall: { kind: "tool", label: "Checking tool" },
    webSearch: { kind: "search", label: "Searching" },
    fileChange: { kind: "file", label: "Preparing changes" },
    reasoning: { kind: "reasoning", label: "Thinking through the request" },
    plan: { kind: "plan", label: "Planning" }
  };
  const mapped = itemType ? started[itemType] : undefined;
  if (!mapped) return undefined;
  return {
    ...mapped,
    itemType,
    itemId,
    method,
    display: true
  };
}

function itemCompletedActivity(method: string, itemType: string | undefined, itemId: string | undefined): AppServerNormalizedEvent["activity"] {
  if (itemType === "commandExecution") {
    return { kind: "command", label: "Command finished", itemType, itemId, method, display: true };
  }
  if (itemType === "mcpToolCall" || itemType === "dynamicToolCall") {
    return { kind: "tool", label: "Tool finished", itemType, itemId, method, display: true };
  }
  if (itemType === "webSearch") {
    return { kind: "search", label: "Search finished", itemType, itemId, method, display: true };
  }
  return undefined;
}

function safeDetail(method: string, params: any): string | undefined {
  switch (method) {
    case "item/commandExecution/outputDelta":
      return byteDelta(params?.delta, "command output delta");
    case "item/commandExecution/terminalInteraction":
      return "terminal interaction";
    case "item/fileChange/outputDelta":
      return byteDelta(params?.delta, "file output delta");
    case "item/fileChange/patchUpdated":
      return Array.isArray(params?.changes) ? `patch updated (${params.changes.length} changes)` : "patch updated";
    case "item/mcpToolCall/progress": {
      const message = textCandidate(params?.message, params?.progress?.message, params?.detail);
      return message ? safeSnippet(message) : "tool progress";
    }
    case "item/reasoning/summaryTextDelta": {
      const delta = textCandidate(params?.delta, params?.text, params?.summaryTextDelta, params?.item?.text);
      return delta ? safeSnippet(delta) : "summary text delta";
    }
    case "item/reasoning/summaryPartAdded":
      return "summary part added";
    case "item/reasoning/textDelta":
      return byteDelta(params?.delta, "reasoning text delta");
    case "turn/plan/updated": {
      const explanation = textCandidate(params?.explanation);
      const planCount = Array.isArray(params?.plan) ? params.plan.length : undefined;
      return [explanation ? safeSnippet(explanation) : undefined, planCount !== undefined ? `${planCount} plan steps` : undefined]
        .filter(Boolean)
        .join(" · ") || "plan updated";
    }
    case "turn/diff/updated": {
      const diff = typeof params?.diff === "string" ? params.diff : "";
      return `diff updated (${Buffer.byteLength(diff, "utf8")} bytes)`;
    }
    case "item/agentMessage/delta":
      return byteDelta(params?.delta, "agent delta");
    case "error": {
      const message = typeof params?.error?.message === "string" ? params.error.message : undefined;
      const code = typeof params?.error?.codexErrorInfo === "string" ? params.error.codexErrorInfo : undefined;
      return [code, message?.slice(0, 240)].filter(Boolean).join(": ") || "app-server error";
    }
    default:
      return undefined;
  }
}

export function normalizeAppServerNotification(message: { method: string; params?: any }): AppServerNormalizedEvent {
  const method = message.method;
  const params = (message as any).params;
  const itemType = appServerItemType(params);
  const itemId = appServerItemId(params);
  const raw: AppServerRawTrace = {
    method,
    turnId: appServerTurnId(params),
    itemType,
    itemId,
    detail: safeDetail(method, params)
  };

  let activity: AppServerNormalizedEvent["activity"];
  if (method === "item/started") {
    activity = itemStartedActivity(method, itemType, itemId);
  } else if (method === "item/completed") {
    activity = itemCompletedActivity(method, itemType, itemId);
  } else if (method === "item/commandExecution/outputDelta") {
    activity = { kind: "command", label: "Reviewing command result", detail: raw.detail, itemType: "commandExecution", itemId, method, display: true };
  } else if (method === "item/commandExecution/terminalInteraction") {
    activity = { kind: "command", label: "Command needs terminal input", detail: raw.detail, itemType: "commandExecution", itemId, method, display: true };
  } else if (method === "item/fileChange/outputDelta" || method === "item/fileChange/patchUpdated") {
    activity = { kind: "file", label: "Preparing changes", detail: raw.detail, itemType: "fileChange", itemId, method, display: true };
  } else if (method === "item/mcpToolCall/progress") {
    activity = { kind: "tool", label: "Checking tool", detail: raw.detail, itemType: "mcpToolCall", itemId, method, display: true };
  } else if (method === "item/reasoning/summaryTextDelta") {
    activity = { kind: "reasoning", label: "Thinking through the request", detail: raw.detail, itemType: "reasoning", itemId, method, display: true };
  } else if (method === "item/reasoning/summaryPartAdded") {
    activity = { kind: "reasoning", label: "Reasoning summary updated", detail: raw.detail, itemType: "reasoning", itemId, method, display: true };
  } else if (method === "item/reasoning/textDelta") {
    activity = { kind: "reasoning", label: "Reasoning internally", detail: raw.detail, itemType: "reasoning", itemId, method, display: false };
  } else if (method === "turn/plan/updated") {
    activity = { kind: "plan", label: "Planning", detail: raw.detail, method, display: true };
  } else if (method === "turn/diff/updated") {
    activity = { kind: "diff", label: "Preparing changes", detail: raw.detail, method, display: true };
  }

  return { raw, activity };
}
