import { createDriver } from "./driver-factory.js";
import { resolveHealthCheckProbeUrl, runHealthCheck } from "./health-check.js";
import { loadState, saveState } from "./state-store.js";
import type {
  DriverTargetDelayResult,
  LoggerLike,
  NetworkProxyDriver,
  RunIterationResult,
  RuntimeConfig,
  WatchdogState,
} from "./types.js";

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
  const nextTarget = await pickNextTarget({
    config,
    openclawConfig,
    driver,
    logger,
    candidates: config.switchPolicy.candidates,
    availableTargets,
    currentTarget,
  });
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

async function pickNextTarget(params: {
  config: RuntimeConfig;
  openclawConfig: Record<string, unknown>;
  driver: NetworkProxyDriver;
  logger: LoggerLike;
  candidates: string[];
  availableTargets: string[];
  currentTarget: string | null;
}): Promise<string | null> {
  const source = filterCandidateTargets(params.candidates, params.availableTargets);

  if (!source.length) {
    return null;
  }

  const lowestLatencyTarget = await pickLowestLatencyTelegramTarget({
    config: params.config,
    openclawConfig: params.openclawConfig,
    driver: params.driver,
    logger: params.logger,
    targets: source,
    currentTarget: params.currentTarget,
  });
  if (lowestLatencyTarget) {
    return lowestLatencyTarget;
  }

  return pickNextTargetByOrder(source, params.currentTarget);
}

function filterCandidateTargets(candidates: string[], availableTargets: string[]): string[] {
  return candidates.length
    ? candidates.filter((candidate) => availableTargets.includes(candidate))
    : availableTargets;
}

async function pickLowestLatencyTelegramTarget(params: {
  config: RuntimeConfig;
  openclawConfig: Record<string, unknown>;
  driver: NetworkProxyDriver;
  logger: LoggerLike;
  targets: string[];
  currentTarget: string | null;
}): Promise<string | null> {
  if (params.config.healthCheck.kind !== "telegram-bot-api") {
    return null;
  }
  if (typeof params.driver.measureTargets !== "function") {
    return null;
  }

  const probeUrl = resolveHealthCheckProbeUrl({
    healthCheck: params.config.healthCheck,
    openclawConfig: params.openclawConfig,
  });
  if (!probeUrl) {
    params.logger.warn("[proxy-watchdog] 未找到 Telegram bot token，跳过最低延迟选线。");
    return null;
  }

  const targetsToMeasure = params.targets.filter((target) => target !== params.currentTarget);
  const measurementTargets = params.currentTarget ? targetsToMeasure : params.targets;
  if (!measurementTargets.length) {
    return null;
  }
  const results = await params.driver.measureTargets({
    targets: measurementTargets,
    url: probeUrl,
    timeoutMs: params.config.healthCheck.timeoutMs,
  });
  const availableResults = results
    .filter((item) => item.ok && item.delayMs !== null)
    .sort((left, right) => {
      if (left.delayMs === right.delayMs) {
        return left.target.localeCompare(right.target);
      }
      return (left.delayMs ?? Number.POSITIVE_INFINITY) - (right.delayMs ?? Number.POSITIVE_INFINITY);
    });

  if (!availableResults.length) {
    params.logger.warn(`[proxy-watchdog] 候选线路都未通过 Telegram 延迟测试，回退到顺序切线。${formatDelayResults(results)}`);
    return null;
  }

  const best = availableResults[0] ?? null;
  if (!best) {
    return null;
  }
  params.logger.info(`[proxy-watchdog] 已按 Telegram 最低延迟优先选择线路：${best.target} (${best.delayMs}ms)。${formatDelayResults(availableResults)}`);
  return best.target;
}

function pickNextTargetByOrder(source: string[], currentTarget: string | null): string | null {
  if (!source.length) {
    return null;
  }

  if (!currentTarget) {
    return source[0] ?? null;
  }

  const alternatives = source.filter((item) => item !== currentTarget);
  if (!alternatives.length) {
    return null;
  }

  const index = source.indexOf(currentTarget);
  if (index === -1) {
    return alternatives[0] ?? null;
  }
  return source.slice(index + 1).concat(source.slice(0, index)).find((item) => item !== currentTarget) ?? null;
}

function formatDelayResults(results: DriverTargetDelayResult[]): string {
  if (!results.length) {
    return "";
  }
  const summary = results
    .map((item) => item.delayMs !== null ? `${item.target}=${item.delayMs}ms` : `${item.target}=fail`)
    .join(", ");
  return ` 测试结果：${truncate(summary, 220)}`;
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

function truncate(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, Math.max(0, maxLength - 1))}…` : value;
}
