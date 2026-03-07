import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { CustomCommandDriverConfig, DriverConfig, MihomoDriverConfig, RuntimeConfig } from "./types.js";

type JsonObject = Record<string, unknown>;
type AnyConfig = Record<string, any>;

export function buildRuntimeConfigFromPlugin(params: {
  openclawConfig: AnyConfig;
  pluginConfig?: Record<string, unknown>;
}): RuntimeConfig {
  void params.openclawConfig;
  const raw = (params.pluginConfig ?? {}) as AnyConfig;

  return {
    enabled: readBoolean(raw.enabled, true),
    stateFile: expandHome(readString(raw.stateFile) ?? path.join(os.homedir(), ".local", "state", "openclaw-network-proxy-watchdog", "state.json")),
    healthCheck: {
      kind: normalizeHealthCheckKind(readString(raw.healthCheck?.kind)),
      url: readString(raw.healthCheck?.url),
      method: normalizeMethod(readString(raw.healthCheck?.method)),
      timeoutMs: clamp(readNumber(raw.healthCheck?.timeoutMs) ?? 15_000, 1_000, 120_000),
      intervalMs: clamp(readNumber(raw.healthCheck?.intervalMs) ?? 60_000, 1_000, 86_400_000),
      expectedStatusCodes: normalizeNumberArray(raw.healthCheck?.expectedStatusCodes, [200]),
      proxyUrl: readString(raw.healthCheck?.proxyUrl),
      telegramApiBaseUrl: readString(raw.healthCheck?.telegramApiBaseUrl) ?? "https://api.telegram.org",
    },
    switchPolicy: {
      failureThreshold: clamp(readNumber(raw.switchPolicy?.failureThreshold) ?? 3, 1, 1000),
      switchCooldownMs: clamp(readNumber(raw.switchPolicy?.switchCooldownMs) ?? 300_000, 0, 86_400_000),
      candidates: normalizeStringArray(raw.switchPolicy?.candidates),
    },
    driver: normalizeDriver(raw.driver),
  };
}

export function ensureParentDir(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

export function expandHome(inputPath: string): string {
  if (inputPath === "~") return os.homedir();
  if (inputPath.startsWith("~/")) return path.join(os.homedir(), inputPath.slice(2));
  return inputPath;
}

function normalizeDriver(rawDriver: unknown): DriverConfig {
  const raw = isPlainObject(rawDriver) ? rawDriver as AnyConfig : {};
  const type = readString(raw.type) ?? "mihomo";
  if (type === "custom-command") {
    const config: CustomCommandDriverConfig = {
      type: "custom-command",
      shell: readString(raw.shell) ?? "/bin/bash",
      listCommand: readString(raw.listCommand) ?? "printf 'primary\\nbackup\\n'",
      currentCommand: readString(raw.currentCommand) ?? "printf 'primary\\n'",
      switchCommand: readString(raw.switchCommand) ?? "echo switching-to {{target}}",
      describeCommand: readString(raw.describeCommand),
      env: normalizeStringMap(raw.env),
    };
    return config;
  }

  const config: MihomoDriverConfig = {
    type: "mihomo",
    controllerUrl: readString(raw.controllerUrl) ?? "http://127.0.0.1:9090",
    secret: readString(raw.secret),
    secretEnv: readString(raw.secretEnv),
    groupName: readString(raw.groupName) ?? "专项代理",
  };
  return config;
}

function normalizeHealthCheckKind(value: string | null): RuntimeConfig["healthCheck"]["kind"] {
  return value === "http" ? "http" : "telegram-bot-api";
}

function normalizeMethod(value: string | null): RuntimeConfig["healthCheck"]["method"] {
  return value === "HEAD" ? "HEAD" : "GET";
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => readString(item)).filter((item): item is string => Boolean(item));
}

function normalizeNumberArray(value: unknown, fallback: number[]): number[] {
  if (!Array.isArray(value)) return fallback;
  const normalized = value.map((item) => readNumber(item)).filter((item): item is number => Number.isFinite(item));
  return normalized.length ? normalized : fallback;
}

function normalizeStringMap(value: unknown): Record<string, string> {
  if (!isPlainObject(value)) return {};
  const entries = Object.entries(value)
    .map(([key, val]) => {
      const normalized = readString(val);
      return normalized ? ([key, normalized] as const) : null;
    })
    .filter((entry): entry is readonly [string, string] => Boolean(entry));
  return Object.fromEntries(entries);
}

function readString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function readNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value.trim());
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function readBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  return fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function isPlainObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
