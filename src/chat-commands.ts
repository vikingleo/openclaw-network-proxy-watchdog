import type { OpenClawPluginApi, PluginCommandContext, ReplyPayload } from "openclaw/plugin-sdk";

import { buildRuntimeConfigFromPlugin } from "./config.js";
import { createDriver } from "./driver-factory.js";
import { derivePanelStorePath, WatchdogPanelStore } from "./panel-store.js";
import { loadState, saveState } from "./state-store.js";
import { runWatchdogIteration } from "./service.js";
import {
  parseTelegramTarget,
  TelegramPanelDelivery,
  type TelegramInlineKeyboardButton,
  type TelegramPanelMessage,
} from "./telegram-panel-delivery.js";
import type { DriverDescribeResult, LoggerLike, RuntimeConfig, WatchdogState } from "./types.js";

type CommandDeps = {
  openclawConfig: Record<string, unknown>;
  pluginConfig?: Record<string, unknown>;
  logger: LoggerLike;
};

type PanelAction = "home" | "driver" | "current" | "switch-menu" | "run-once" | "switch";

type PanelResponse = {
  text: string;
  buttons: TelegramInlineKeyboardButton[][];
};

const SILENT_REPLY_TOKEN = "NO_REPLY";

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

  const parsed = parseCommandArgs(ctx.args ?? "");
  if (ctx.channel === "telegram") {
    return await handleTelegramCommand(ctx, config, parsed, deps);
  }
  return await handleGenericCommand(ctx, config, parsed, deps);
}

async function handleTelegramCommand(
  ctx: PluginCommandContext,
  config: RuntimeConfig,
  parsed: ParsedCommand,
  deps: CommandDeps,
): Promise<ReplyPayload> {
  const telegramRuntime = resolveTelegramRuntime(deps.openclawConfig);
  if (!telegramRuntime) {
    return {
      text: "网络代理看门狗\n\n缺少 Telegram 机器人配置，无法打开交互面板。",
      isError: true,
    };
  }

  const target = parseTelegramTarget(ctx.to ?? ctx.from, ctx.messageThreadId);
  if (!target && !parsed.panelId) {
    return {
      text: "网络代理看门狗\n\n当前会话未解析出 Telegram 目标，无法打开交互面板。",
      isError: true,
    };
  }

  const store = new WatchdogPanelStore(derivePanelStorePath(config.stateFile));
  const delivery = new TelegramPanelDelivery(telegramRuntime);

  if (parsed.panelId) {
    const panel = store.get(parsed.panelId);
    if (!panel) {
      return {
        text: "网络代理看门狗\n\n控制面板已过期，请重新发送 /proxywd 打开新面板。",
        isError: true,
      };
    }
    const response = await renderPanel(config, deps, parsed.action, parsed.arg, parsed.panelId);
    await delivery.editMessage(
      { chatId: panel.chatId, threadId: panel.threadId },
      panel.messageId,
      { text: response.text, replyMarkup: { inline_keyboard: response.buttons } },
    );
    store.update(parsed.panelId, (current) => current);
    return silentReply();
  }

  const panel = store.create({
    chatId: target?.chatId ?? "",
    threadId: target?.threadId ?? null,
    ownerSenderId: normalizeIdentity(ctx.senderId ?? ctx.from),
  });
  const response = await renderPanel(config, deps, parsed.action, parsed.arg, panel.panelId);
  const sent = await delivery.sendMessage(
    { chatId: panel.chatId, threadId: panel.threadId },
    { text: response.text, replyMarkup: { inline_keyboard: response.buttons } },
  );
  store.update(panel.panelId, (current) => ({ ...current, messageId: sent.messageId }));
  return emptyReply();
}

async function handleGenericCommand(
  ctx: PluginCommandContext,
  config: RuntimeConfig,
  parsed: ParsedCommand,
  deps: CommandDeps,
): Promise<ReplyPayload> {
  switch (parsed.action) {
    case "home":
      return buildReply(await renderDashboard(config, deps), false);
    case "driver":
      return buildReply(await renderDriverSummary(config, deps), false);
    case "current":
      return buildReply(await renderCurrentTarget(config, deps), false);
    case "switch-menu":
      return buildReply((await renderSwitchMenu(config, deps, undefined)).text, false);
    case "run-once":
      return buildReply(await renderRunOnce(config, deps), false);
    case "switch":
      return buildReply(await renderSwitchResult(config, deps, parsed.arg, undefined), false);
  }
}

async function renderPanel(
  config: RuntimeConfig,
  deps: CommandDeps,
  action: PanelAction,
  arg: string,
  panelId: string,
): Promise<PanelResponse> {
  switch (action) {
    case "driver":
      return withButtons(await renderDriverSummary(config, deps), buildMainButtons(panelId));
    case "current":
      return withButtons(await renderCurrentTarget(config, deps), buildMainButtons(panelId));
    case "switch-menu":
      return await renderSwitchMenu(config, deps, panelId);
    case "run-once":
      return withButtons(await renderRunOnce(config, deps), buildMainButtons(panelId));
    case "switch":
      return withButtons(await renderSwitchResult(config, deps, arg, panelId), buildMainButtons(panelId));
    case "home":
    default:
      return withButtons(await renderDashboard(config, deps), buildMainButtons(panelId));
  }
}

async function renderDashboard(config: RuntimeConfig, deps: CommandDeps): Promise<string> {
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
  return lines.join("\n");
}

async function renderDriverSummary(config: RuntimeConfig, deps: CommandDeps): Promise<string> {
  const driver = createDriver(config.driver, deps.logger);
  const summary = await driver.describe();
  return [
    "驱动摘要",
    "",
    `驱动类型：${summary.type}`,
    ...formatDriverDetail(summary),
  ].join("\n");
}

async function renderCurrentTarget(config: RuntimeConfig, deps: CommandDeps): Promise<string> {
  const driver = createDriver(config.driver, deps.logger);
  const currentTarget = await safeCurrentTarget(driver, loadState(config).currentTarget);
  return [
    "当前线路",
    "",
    `当前线路：${currentTarget ?? "<未知>"}`,
    `驱动类型：${config.driver.type}`,
  ].join("\n");
}

async function renderSwitchMenu(config: RuntimeConfig, deps: CommandDeps, panelId: string | undefined): Promise<PanelResponse> {
  const driver = createDriver(config.driver, deps.logger);
  const targets = await driver.listTargets();
  const currentTarget = await safeCurrentTarget(driver, loadState(config).currentTarget);
  const lines = [
    "切线面板",
    "",
    `当前线路：${currentTarget ?? "<未知>"}`,
  ];

  if (targets.length === 0) {
    lines.push("没有读取到可切换线路。", "", "请检查驱动配置或稍后重试。");
    return withButtons(lines.join("\n"), buildMainButtons(panelId ?? randomFallbackPanelId()));
  }

  for (const [index, target] of targets.entries()) {
    const mark = target === currentTarget ? "✅" : "·";
    lines.push(`${mark} ${index + 1}. ${target}`);
  }
  lines.push("", "点击下方按钮可直接切换。", "可用“返回概览”回到主面板。");

  return withButtons(lines.join("\n"), buildSwitchButtons(panelId ?? randomFallbackPanelId(), targets, currentTarget));
}

async function renderRunOnce(config: RuntimeConfig, deps: CommandDeps): Promise<string> {
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
  return lines.join("\n");
}

async function renderSwitchResult(
  config: RuntimeConfig,
  deps: CommandDeps,
  rawTarget: string,
  panelId: string | undefined,
): Promise<string> {
  const normalizedArg = rawTarget.trim();
  if (!normalizedArg) {
    return [
      "切线失败",
      "",
      "缺少目标参数。",
      panelId ? "请返回切线面板后重新选择。" : "用法：/proxywd switch <序号|名称>",
    ].join("\n");
  }

  const driver = createDriver(config.driver, deps.logger);
  const targets = await driver.listTargets();
  const target = resolveSwitchTarget(targets, normalizedArg);
  if (!target) {
    return [
      "切线失败",
      "",
      `未找到目标：${normalizedArg}`,
      `可用目标数：${targets.length}`,
      panelId ? "请返回切线面板重新选择。" : "先执行 /proxywd switch-menu 查看可用线路。",
    ].join("\n");
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

  return [
    "切线完成",
    "",
    `切换结果：${result.from ?? "<未知>"} -> ${result.to}`,
    `是否变更：${result.changed ? "是" : "否"}`,
    `最近探测：${formatLastProbe(state)}`,
  ].join("\n");
}

function withButtons(text: string, buttons: TelegramInlineKeyboardButton[][]): PanelResponse {
  return { text, buttons };
}

function buildReply(text: string, isError: boolean): ReplyPayload {
  return { text, isError };
}

function emptyReply(): ReplyPayload {
  return {};
}

function silentReply(): ReplyPayload {
  return { text: SILENT_REPLY_TOKEN };
}

function buildMainButtons(panelId: string): TelegramInlineKeyboardButton[][] {
  return [
    [
      { text: "概览", callback_data: buildPanelCallback(panelId, "h") },
      { text: "巡检", callback_data: buildPanelCallback(panelId, "r") },
    ],
    [
      { text: "当前线路", callback_data: buildPanelCallback(panelId, "c") },
      { text: "驱动摘要", callback_data: buildPanelCallback(panelId, "d") },
    ],
    [
      { text: "切线面板", callback_data: buildPanelCallback(panelId, "s") },
    ],
  ];
}

function buildSwitchButtons(panelId: string, targets: string[], currentTarget: string | null): TelegramInlineKeyboardButton[][] {
  const rows: TelegramInlineKeyboardButton[][] = [];
  let currentRow: TelegramInlineKeyboardButton[] = [];
  for (const [index, target] of targets.entries()) {
    currentRow.push({
      text: `${target === currentTarget ? "✅" : "🔀"}${index + 1}`,
      callback_data: buildPanelCallback(panelId, "x", String(index + 1)),
    });
    if (currentRow.length === 3) {
      rows.push(currentRow);
      currentRow = [];
    }
  }
  if (currentRow.length > 0) {
    rows.push(currentRow);
  }
  rows.push([{ text: "返回概览", callback_data: buildPanelCallback(panelId, "h") }]);
  return rows;
}

function buildPanelCallback(panelId: string, action: "h" | "r" | "c" | "d" | "s" | "x", arg?: string): string {
  return arg ? `/proxywd p ${panelId} ${action} ${arg}` : `/proxywd p ${panelId} ${action}`;
}

function parseCommandArgs(rawArgs: string): ParsedCommand {
  const tokens = rawArgs.trim().split(/\s+/).filter(Boolean);
  if (tokens[0] === "p" && tokens[1]) {
    return {
      panelId: tokens[1],
      action: decodePanelAction(tokens[2]),
      arg: tokens.slice(3).join(" "),
    };
  }
  return {
    panelId: null,
    action: decodePanelAction(tokens[0]),
    arg: tokens.slice(1).join(" "),
  };
}

function decodePanelAction(raw: string | undefined): PanelAction {
  switch ((raw ?? "").trim().toLowerCase()) {
    case "d":
    case "driver":
      return "driver";
    case "c":
    case "current":
      return "current";
    case "s":
    case "switch-menu":
    case "targets":
      return "switch-menu";
    case "r":
    case "run":
    case "run-once":
      return "run-once";
    case "x":
    case "switch":
      return "switch";
    case "h":
    case "menu":
    case "home":
    case "status":
    case "refresh":
    default:
      return "home";
  }
}

function resolveSwitchTarget(targets: string[], raw: string): string | null {
  if (/^\d+$/.test(raw)) {
    return targets[Number.parseInt(raw, 10) - 1] ?? null;
  }
  return targets.find((target) => target === raw) ?? null;
}

function formatDriverDetail(summary: DriverDescribeResult): string[] {
  const detail = summary.detail ?? {};
  const lines: string[] = [];
  if (typeof detail.controllerUrl === "string") lines.push(`控制地址：${detail.controllerUrl}`);
  if (typeof detail.groupName === "string") lines.push(`代理组：${detail.groupName}`);
  if (typeof detail.current === "string") lines.push(`当前线路：${detail.current}`);
  const targets = Array.isArray(detail.targets) ? detail.targets.map((item) => String(item)) : [];
  if (targets.length > 0) {
    lines.push(`线路数量：${targets.length}`);
    lines.push(`线路预览：${truncate(targets.slice(0, 6).join("、"), 220)}`);
  }
  if (lines.length === 0) {
    lines.push(`详情：${truncate(JSON.stringify(detail, null, 2), 700)}`);
  }
  return lines;
}

function formatLastProbe(state: WatchdogState): string {
  if (!state.lastProbeAt) return "暂无";
  return `${state.lastProbeOk ? "成功" : "失败"} · ${state.lastProbeAt}`;
}

function formatLastSwitch(state: WatchdogState): string {
  if (!state.lastSwitchAt) return "暂无";
  return `${state.lastSwitchFrom ?? "<未知>"} -> ${state.lastSwitchTo ?? "<未知>"} · ${state.lastSwitchAt}`;
}

function formatAdminSummary(config: RuntimeConfig): string {
  if (config.commandAccess.adminSenderIds.length === 0) return "继承平台授权";
  return `${config.commandAccess.adminSenderIds.length} 个管理员`;
}

function isAdminAuthorized(ctx: PluginCommandContext, config: RuntimeConfig): boolean {
  if (!ctx.isAuthorizedSender) return false;
  const admins = config.commandAccess.adminSenderIds.map(normalizeIdentity).filter(Boolean);
  if (admins.length === 0) return true;
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

function resolveTelegramRuntime(openclawConfig: Record<string, unknown>): {
  botToken: string;
  apiBaseUrl?: string;
  proxyUrl?: string | null;
} | null {
  const channels = asRecord(openclawConfig.channels);
  const telegram = asRecord(channels.telegram);
  const botToken = readString(telegram.botToken);
  if (!botToken) {
    return null;
  }
  return {
    botToken,
    apiBaseUrl: readString(telegram.apiBaseUrl) ?? undefined,
    proxyUrl: readString(telegram.proxy),
  };
}

function asRecord(value: unknown): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};
}

function readString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed || null;
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
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 1)}…`;
}

function randomFallbackPanelId(): string {
  return "temp0000";
}

type ParsedCommand = {
  panelId: string | null;
  action: PanelAction;
  arg: string;
};
