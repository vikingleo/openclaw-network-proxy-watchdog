import fs from "node:fs";

import { ensureParentDir } from "./config.js";
import type { RuntimeConfig, WatchdogState } from "./types.js";

export function loadState(config: RuntimeConfig): WatchdogState {
  if (!fs.existsSync(config.stateFile)) {
    return emptyState();
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(config.stateFile, "utf8")) as Partial<WatchdogState>;
    return {
      failureCount: parsed.failureCount ?? 0,
      lastProbeAt: parsed.lastProbeAt ?? null,
      lastProbeSummary: parsed.lastProbeSummary ?? null,
      lastProbeOk: parsed.lastProbeOk ?? null,
      lastSwitchAt: parsed.lastSwitchAt ?? null,
      lastSwitchFrom: parsed.lastSwitchFrom ?? null,
      lastSwitchTo: parsed.lastSwitchTo ?? null,
      currentTarget: parsed.currentTarget ?? null,
      lastError: parsed.lastError ?? null,
    };
  } catch {
    return emptyState();
  }
}

export function saveState(config: RuntimeConfig, state: WatchdogState): void {
  ensureParentDir(config.stateFile);
  fs.writeFileSync(config.stateFile, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

function emptyState(): WatchdogState {
  return {
    failureCount: 0,
    lastProbeAt: null,
    lastProbeSummary: null,
    lastProbeOk: null,
    lastSwitchAt: null,
    lastSwitchFrom: null,
    lastSwitchTo: null,
    currentTarget: null,
    lastError: null,
  };
}
