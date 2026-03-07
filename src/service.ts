import { createDriver } from "./driver-factory.js";
import { runHealthCheck } from "./health-check.js";
import { loadState, saveState } from "./state-store.js";
import type { LoggerLike, RunIterationResult, RuntimeConfig, WatchdogState } from "./types.js";

export class NetworkProxyWatchdogService {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private inFlight = false;

  constructor(private readonly params: {
    config: RuntimeConfig;
    openclawConfig: Record<string, unknown>;
    logger: LoggerLike;
  }) {}

  async start(): Promise<void> {
    const { config, logger } = this.params;
    if (!config.enabled || this.running) {
      return;
    }
    this.running = true;
    logger.info(`[proxy-watchdog] service started (driver=${config.driver.type}, intervalMs=${config.healthCheck.intervalMs})`);
    await this.runOnce();
    this.timer = setInterval(() => {
      this.runOnce().catch((error) => {
        logger.error(`[proxy-watchdog] runOnce failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
      });
    }, config.healthCheck.intervalMs);
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.running = false;
  }

  async runOnce(): Promise<RunIterationResult> {
    if (this.inFlight) {
      throw new Error("上一次探测还没跑完，先别催。\n");
    }
    this.inFlight = true;
    try {
      return await runWatchdogIteration(this.params);
    } finally {
      this.inFlight = false;
    }
  }
}

export async function runWatchdogIteration(params: {
  config: RuntimeConfig;
  openclawConfig: Record<string, unknown>;
  logger: LoggerLike;
}): Promise<RunIterationResult> {
  const { config, openclawConfig, logger } = params;
  const driver = createDriver(config.driver, logger);
  const state = loadState(config);
  const probe = await runHealthCheck({ healthCheck: config.healthCheck, openclawConfig });
  const now = new Date().toISOString();

  state.lastProbeAt = now;
  state.lastProbeSummary = probe.summary;
  state.lastProbeOk = probe.ok;

  if (probe.ok) {
    if (state.failureCount > 0) {
      logger.info(`[proxy-watchdog] 健康检查恢复：${probe.summary}`);
    }
    state.failureCount = 0;
    state.lastError = null;
    state.currentTarget = await safeReadCurrentTarget(driver, state.currentTarget);
    saveState(config, state);
    return { probe, switched: false, switchResult: null, state };
  }

  if (!probe.countsAsFailure) {
    state.lastError = probe.summary;
    state.currentTarget = await safeReadCurrentTarget(driver, state.currentTarget);
    saveState(config, state);
    logger.warn(`[proxy-watchdog] 探测未通过，但不计入切线阈值：${probe.summary}`);
    return { probe, switched: false, switchResult: null, state };
  }

  state.failureCount += 1;
  state.lastError = probe.summary;
  logger.warn(`[proxy-watchdog] 健康检查失败（${state.failureCount}/${config.switchPolicy.failureThreshold}）：${probe.summary}`);

  if (state.failureCount < config.switchPolicy.failureThreshold) {
    state.currentTarget = await safeReadCurrentTarget(driver, state.currentTarget);
    saveState(config, state);
    return { probe, switched: false, switchResult: null, state };
  }

  if (inCooldown(state, config.switchPolicy.switchCooldownMs, now)) {
    state.currentTarget = await safeReadCurrentTarget(driver, state.currentTarget);
    saveState(config, state);
    logger.warn("[proxy-watchdog] 已达到阈值，但仍在切换冷却期内，暂不切线。");
    return { probe, switched: false, switchResult: null, state };
  }

  const availableTargets = await driver.listTargets();
  const currentTarget = await safeReadCurrentTarget(driver, state.currentTarget);
  const nextTarget = pickNextTarget({ candidates: config.switchPolicy.candidates, availableTargets, currentTarget });
  if (!nextTarget) {
    state.currentTarget = currentTarget;
    saveState(config, state);
    throw new Error("没有可切换的目标线路。\n");
  }

  const switchResult = await driver.switchTarget(nextTarget);
  state.failureCount = 0;
  state.lastSwitchAt = now;
  state.lastSwitchFrom = switchResult.from;
  state.lastSwitchTo = switchResult.to;
  state.currentTarget = switchResult.to;
  state.lastError = null;
  saveState(config, state);
  logger.warn(`[proxy-watchdog] 已切线：${switchResult.from ?? "<unknown>"} -> ${switchResult.to}`);

  return { probe, switched: true, switchResult, state };
}

function pickNextTarget(params: {
  candidates: string[];
  availableTargets: string[];
  currentTarget: string | null;
}): string | null {
  const source = params.candidates.length
    ? params.candidates.filter((candidate) => params.availableTargets.includes(candidate))
    : params.availableTargets;

  if (!source.length) {
    return null;
  }

  if (!params.currentTarget) {
    return source[0] ?? null;
  }

  const index = source.indexOf(params.currentTarget);
  if (index === -1) {
    return source.find((item) => item !== params.currentTarget) ?? source[0] ?? null;
  }
  if (source.length === 1) {
    return source[0] ?? null;
  }
  return source[(index + 1) % source.length] ?? null;
}

function inCooldown(state: WatchdogState, cooldownMs: number, nowIso: string): boolean {
  if (!cooldownMs || !state.lastSwitchAt) {
    return false;
  }
  const delta = Date.parse(nowIso) - Date.parse(state.lastSwitchAt);
  return delta >= 0 && delta < cooldownMs;
}

async function safeReadCurrentTarget(driver: ReturnType<typeof createDriver>, fallback: string | null): Promise<string | null> {
  try {
    return await driver.getCurrentTarget();
  } catch {
    return fallback;
  }
}
