import type { OpenClawPluginApi, PluginCommandContext, ReplyPayload } from "openclaw/plugin-sdk";

import { buildRuntimeConfigFromPlugin } from "./config.js";
import { createDriver } from "./driver-factory.js";
import { loadState, saveState } from "./state-store.js";
import { runWatchdogIteration } from "./service.js";
import type { DriverDescribeResult, LoggerLike, RuntimeConfig, WatchdogState } from "./types.js";

type TelegramButton = {
  text: string;
  callback_data: string;
};

type CommandDeps = {
  openclawConfig: Record<string, unknown>;
  pluginConfig?: Record<string, unknown>;
  logger: LoggerLike;
};

export function registerProxyWatchdogCommand(api: OpenClawPluginApi, deps: CommandDeps): void {
  api.registerCommand({
    name: "proxywd",
    description: "网络代理看门狗控制台（管理员）",
    acceptsArgs: true,
    requireAuth: true,
    handler: async (ctx) => await handleProxyWatchdogCommand(ctx, deps),
  });
}

export async function handleProxyWatchdogCommand(ctx: PluginCommandContext, deps: CommandDeps): Promise<ReplyPayload> {
  const config = buildRuntimeConfigFromPlugin({
    openclawConfig: deps.openclawConfig,
    pluginConfig: deps.pluginConfig,
  });

  if (!isAdminAuthorized(ctx, config)) {
    return {
      text: [
        "网络代理看门狗",
        "",
        "无权限：仅管理员可执行该命令。",
      ].join("\n"),
      isError: true,
    };
  }

  const rawArgs = (ctx.args ?? "").trim();
  const [actionRaw = "menu"] = rawArgs ? rawArgs.split(/\s+/, 1) : ["menu"];
  const action = actionRaw.toLowerCase();
  const remainder = rawArgs ? rawArgs.slice(actionRaw.length).trim() : "";

  switch (action) {
    case "":
    case "menu":
    case "help":
    case "status":
    case "refresh":
      return await renderDashboard(ctx, config, deps);
    case "driver":
      return await renderDriverSummary(ctx, config, deps);
    case "current":
      return await renderCurrentTarget(ctx, config, deps);
    case "targets":
    case "switch-menu":
      return await renderSwitchMenu(ctx, config, deps);
    case "run":
    case "run-once":
      return await runOnceAndRender(ctx, config, deps);
    case "switch":
      return await switchTargetAndRender(ctx, config, remainder, deps);
    default:
      return buildReply(ctx, [
        "网络代理看门狗",
        "",
        `未知子命令：${action}`,
        "可用子命令：menu、status、driver、current、targets、switch-menu、run-once、switch <序号|名称>",
      ].join("\n"), buildMainButtons());
  }
}

async function renderDashboard(ctx: PluginCommandContext, config: RuntimeConfig, deps: CommandDeps): Promise<ReplyPayload> {
  const driver = createDriver(config.driver, deps.logger);
  const state = loadState(config);
  const currentTarget = await safeCurrentTarget(driver, state.currentTarget);
  const targets = await safeListTargets(driver);
  const lines = [
    "网络代理看门狗",
    "",
    `驱动类型：${config.driver.type}`,
    `健康检查：${config.healthCheck.kind}`,
    `当前线路：${currentTarget ?? "<未知>"}`,
    `连续失败：${state.failureCount}/${config.switchPolicy.failureThreshold}`,
    `最近探测：${formatLastProbe(state)}`,
    `最近切线：${formatLastSwitch(state)}`,
    `可切线路：${targets.length}`,
    `管理员控制：${formatAdminSummary(config)}`,
  ];

  if (state.lastError) {
    lines.push(`最近错误：${truncate(state.lastError, 220)}`);
  }

  return buildReply(ctx, lines.join("\n"), buildMainButtons());
}

async function renderDriverSummary(ctx: PluginCommandContext, config: RuntimeConfig, deps: CommandDeps): Promise<ReplyPayload> {
  const driver = createDriver(config.driver, deps.logger);
  const summary = await driver.describe();
  const lines = [
    "驱动摘要",
    "",
    `驱动类型：${summary.type}`,
    ...formatDriverDetail(summary),
  ];
  return buildReply(ctx, lines.join("\n"), buildMainButtons());
}

async function renderCurrentTarget(ctx: PluginCommandContext, config: RuntimeConfig, deps: CommandDeps): Promise<ReplyPayload> {
  const driver = createDriver(config.driver, deps.logger);
  const currentTarget = await safeCurrentTarget(driver, loadState(config).currentTarget);
  return buildReply(ctx, [
    "当前线路",
    "",
    `当前线路：${currentTarget ?? "<未知>"}`,
    `驱动类型：${config.driver.type}`,
  ].join("\n"), buildMainButtons());
}

async function renderSwitchMenu(ctx: PluginCommandContext, config: RuntimeConfig, deps: CommandDeps): Promise<ReplyPayload> {
  const driver = createDriver(config.driver, deps.logger);
  const targets = await driver.listTargets();
  const currentTarget = await safeCurrentTarget(driver, loadState(config).currentTarget);
  const lines = [
    "切线面板",
    "",
    `当前线路：${currentTarget ?? "<未知>"}`,
  ];

  if (targets.length === 0) {
    lines.push("没有读取到可切换线路。");
    return buildReply(ctx, lines.join("\n"), buildMainButtons());
  }

  for (const [index, target] of targets.entries()) {
    const mark = target === currentTarget ? "✅" : "·";
    lines.push(`${mark} ${index + 1}. ${target}`);
  }
  lines.push("", "点击下方按钮可直接切换。\n文本命令也支持：/proxywd switch 2");

  return buildReply(ctx, lines.join("\n"), buildSwitchButtons(targets, currentTarget));
}

async function runOnceAndRender(ctx: PluginCommandContext, config: RuntimeConfig, deps: CommandDeps): Promise<ReplyPayload> {
  const result = await runWatchdogIteration({
    config,
    openclawConfig: deps.openclawConfig,
    logger: deps.logger,
  });

  const lines = [
    "即时巡检结果",
    "",
    `探测结果：${result.probe.ok ? "成功" : "失败"}`,
    `探测摘要：${result.probe.summary}`,
    `已切线：${result.switched ? "是" : "否"}`,
    `当前线路：${result.state.currentTarget ?? "<未知>"}`,
    `连续失败：${result.state.failureCount}/${config.switchPolicy.failureThreshold}`,
  ];
  if (result.switchResult) {
    lines.push(`切线结果：${result.switchResult.from ?? "<未知>"} -> ${result.switchResult.to}`);
  }
  return buildReply(ctx, lines.join("\n"), buildMainButtons());
}

async function switchTargetAndRender(
  ctx: PluginCommandContext,
  config: RuntimeConfig,
  rawTarget: string,
  deps: CommandDeps,
): Promise<ReplyPayload> {
  const normalizedArg = rawTarget.trim();
  if (!normalizedArg) {
    return buildReply(ctx, [
      "切线失败",
      "",
      "缺少目标参数。",
      "用法：/proxywd switch <序号|名称>",
    ].join("\n"), buildMainButtons(), true);
  }

  const driver = createDriver(config.driver, deps.logger);
  const targets = await driver.listTargets();
  const target = resolveSwitchTarget(targets, normalizedArg);
  if (!target) {
    return buildReply(ctx, [
      "切线失败",
      "",
      `未找到目标：${normalizedArg}`,
      `可用目标数：${targets.length}`,
      "先执行 /proxywd switch-menu 查看可用线路。",
    ].join("\n"), buildSwitchButtons(targets, await safeCurrentTarget(driver, loadState(config).currentTarget)), true);
  }

  const result = await driver.switchTarget(target);
  const state = loadState(config);
  const now = new Date().toISOString();
  state.lastSwitchAt = now;
  state.lastSwitchFrom = result.from;
  state.lastSwitchTo = result.to;
  state.currentTarget = result.to;
  state.lastError = null;
  saveState(config, state);
  const lines = [
    "切线完成",
    "",
    `切换结果：${result.from ?? "<未知>"} -> ${result.to}`,
    `是否变更：${result.changed ? "是" : "否"}`,
    `最近探测：${formatLastProbe(state)}`,
  ];
  return buildReply(ctx, lines.join("\n"), buildMainButtons());
}

function resolveSwitchTarget(targets: string[], raw: string): string | null {
  if (/^\d+$/.test(raw)) {
    const index = Number.parseInt(raw, 10) - 1;
    return targets[index] ?? null;
  }

  return targets.find((target) => target === raw) ?? null;
}

function formatDriverDetail(summary: DriverDescribeResult): string[] {
  const detail = summary.detail ?? {};
  const lines: string[] = [];

  if (typeof detail.controllerUrl === "string") {
    lines.push(`控制地址：${detail.controllerUrl}`);
  }
  if (typeof detail.groupName === "string") {
    lines.push(`代理组：${detail.groupName}`);
  }
  if (typeof detail.current === "string") {
    lines.push(`当前线路：${detail.current}`);
  }
  const targets = Array.isArray(detail.targets) ? detail.targets.map((item) => String(item)) : [];
  if (targets.length > 0) {
    lines.push(`线路数量：${targets.length}`);
    lines.push(`线路预览：${truncate(targets.slice(0, 6).join("、"), 220)}`);
  }

  const fallback = truncate(JSON.stringify(detail, null, 2), 700);
  if (lines.length === 0 && fallback) {
    lines.push(`详情：${fallback}`);
  }

  return lines;
}

function formatLastProbe(state: WatchdogState): string {
  if (!state.lastProbeAt) {
    return "暂无";
  }
  return `${state.lastProbeOk ? "成功" : "失败"} · ${state.lastProbeAt}`;
}

function formatLastSwitch(state: WatchdogState): string {
  if (!state.lastSwitchAt) {
    return "暂无";
  }
  return `${state.lastSwitchFrom ?? "<未知>"} -> ${state.lastSwitchTo ?? "<未知>"} · ${state.lastSwitchAt}`;
}

function formatAdminSummary(config: RuntimeConfig): string {
  if (config.commandAccess.adminSenderIds.length === 0) {
    return "继承平台授权";
  }
  return `${config.commandAccess.adminSenderIds.length} 个管理员`;
}

function buildMainButtons(): TelegramButton[][] {
  return [
    [
      { text: "概览", callback_data: "/proxywd" },
      { text: "巡检", callback_data: "/proxywd run-once" },
    ],
    [
      { text: "当前线路", callback_data: "/proxywd current" },
      { text: "驱动摘要", callback_data: "/proxywd driver" },
    ],
    [
      { text: "切线面板", callback_data: "/proxywd switch-menu" },
    ],
  ];
}

function buildSwitchButtons(targets: string[], currentTarget: string | null): TelegramButton[][] {
  const rows: TelegramButton[][] = [];
  let currentRow: TelegramButton[] = [];

  for (const [index, target] of targets.entries()) {
    const text = `${target === currentTarget ? "✅" : "🔀"}${index + 1}`;
    currentRow.push({ text, callback_data: `/proxywd switch ${index + 1}` });
    if (currentRow.length === 3) {
      rows.push(currentRow);
      currentRow = [];
    }
  }
  if (currentRow.length > 0) {
    rows.push(currentRow);
  }
  rows.push([{ text: "返回概览", callback_data: "/proxywd" }]);
  return rows;
}

function buildReply(ctx: PluginCommandContext, text: string, buttons: TelegramButton[][], isError = false): ReplyPayload {
  if (ctx.channel === "telegram") {
    return {
      text,
      isError,
      channelData: {
        telegram: {
          buttons,
        },
      },
    };
  }

  return {
    text,
    isError,
  };
}

function isAdminAuthorized(ctx: PluginCommandContext, config: RuntimeConfig): boolean {
  if (!ctx.isAuthorizedSender) {
    return false;
  }

  const admins = config.commandAccess.adminSenderIds.map(normalizeIdentity).filter(Boolean);
  if (admins.length === 0) {
    return true;
  }

  const candidates = new Set<string>();
  for (const value of [ctx.senderId, ctx.from]) {
    const normalized = normalizeIdentity(value);
    if (!normalized) continue;
    candidates.add(normalized);
    if (!normalized.includes(":")) {
      candidates.add(normalizeIdentity(`${ctx.channel}:${normalized}`));
    }
  }

  return [...candidates].some((candidate) => admins.includes(candidate));
}

function normalizeIdentity(value: string | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

async function safeCurrentTarget(driver: ReturnType<typeof createDriver>, fallback: string | null): Promise<string | null> {
  try {
    return await driver.getCurrentTarget();
  } catch {
    return fallback;
  }
}

async function safeListTargets(driver: ReturnType<typeof createDriver>): Promise<string[]> {
  try {
    return await driver.listTargets();
  } catch {
    return [];
  }
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, maxLength - 1)}…`;
}
