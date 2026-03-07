import { ProxyAgent, fetch as undiciFetch } from "undici";

import type { HealthCheckConfig, ProbeResult } from "./types.js";

export async function runHealthCheck(params: {
  healthCheck: HealthCheckConfig;
  openclawConfig: Record<string, unknown>;
}): Promise<ProbeResult> {
  const { healthCheck, openclawConfig } = params;
  if (healthCheck.kind === "telegram-bot-api") {
    return await runTelegramBotApiProbe(healthCheck, openclawConfig);
  }
  return await runHttpProbe({
    url: healthCheck.url,
    method: healthCheck.method,
    timeoutMs: healthCheck.timeoutMs,
    expectedStatusCodes: healthCheck.expectedStatusCodes,
    proxyUrl: healthCheck.proxyUrl,
  });
}

async function runTelegramBotApiProbe(healthCheck: HealthCheckConfig, openclawConfig: Record<string, unknown>): Promise<ProbeResult> {
  const token = readTelegramBotToken(openclawConfig);
  if (!token) {
    return { ok: false, countsAsFailure: false, summary: "未找到宿主 Telegram bot token，跳过切线。", statusCode: null };
  }
  const base = healthCheck.telegramApiBaseUrl.replace(/\/+$/, "");
  return await runHttpProbe({
    url: `${base}/bot${token}/getMe`,
    method: healthCheck.method,
    timeoutMs: healthCheck.timeoutMs,
    expectedStatusCodes: [200],
    proxyUrl: healthCheck.proxyUrl,
    configErrorStatusCodes: [401, 404],
  });
}

async function runHttpProbe(params: {
  url: string | null;
  method: "GET" | "HEAD";
  timeoutMs: number;
  expectedStatusCodes: number[];
  proxyUrl: string | null;
  configErrorStatusCodes?: number[];
}): Promise<ProbeResult> {
  if (!params.url) {
    return { ok: false, countsAsFailure: false, summary: "未配置健康检查 URL。", statusCode: null };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), params.timeoutMs);
  try {
    const response = await undiciFetch(params.url, {
      method: params.method,
      signal: controller.signal,
      ...(params.proxyUrl ? { dispatcher: new ProxyAgent(params.proxyUrl) } : {}),
    });
    const status = response.status;
    if (params.expectedStatusCodes.includes(status)) {
      return { ok: true, countsAsFailure: false, summary: `探测成功 (${status})`, statusCode: status };
    }
    if ((params.configErrorStatusCodes ?? []).includes(status)) {
      return { ok: false, countsAsFailure: false, summary: `探测返回 ${status}，更像配置错误，不执行切线。`, statusCode: status };
    }
    return { ok: false, countsAsFailure: true, summary: `探测失败，状态码 ${status}`, statusCode: status };
  } catch (error) {
    return {
      ok: false,
      countsAsFailure: true,
      summary: `探测异常：${error instanceof Error ? error.message : String(error)}`,
      statusCode: null,
    };
  } finally {
    clearTimeout(timer);
  }
}

function readTelegramBotToken(openclawConfig: Record<string, unknown>): string | null {
  const channels = isPlainObject(openclawConfig.channels) ? openclawConfig.channels as Record<string, unknown> : {};
  const telegram = isPlainObject(channels.telegram) ? channels.telegram as Record<string, unknown> : {};
  const botToken = readString(telegram.botToken);
  return botToken;
}

function readString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
