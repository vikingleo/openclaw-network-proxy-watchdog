import type { LoggerLike, MihomoDriverConfig, NetworkProxyDriver, DriverDescribeResult, DriverSwitchResult } from "../types.js";

export class MihomoDriver implements NetworkProxyDriver {
  readonly type = "mihomo" as const;

  constructor(
    private readonly config: MihomoDriverConfig,
    private readonly logger: LoggerLike,
  ) {}

  async describe(): Promise<DriverDescribeResult> {
    const group = await this.fetchGroup();
    return {
      type: this.type,
      detail: {
        controllerUrl: this.config.controllerUrl,
        groupName: this.config.groupName,
        current: readString(group.now),
        targets: Array.isArray(group.all) ? group.all : [],
      },
    };
  }

  async listTargets(): Promise<string[]> {
    const group = await this.fetchGroup();
    if (!Array.isArray(group.all)) {
      return [];
    }
    return group.all.map((item) => String(item));
  }

  async getCurrentTarget(): Promise<string | null> {
    const group = await this.fetchGroup();
    return readString(group.now);
  }

  async switchTarget(target: string): Promise<DriverSwitchResult> {
    const current = await this.getCurrentTarget();
    if (current === target) {
      return { from: current, to: target, changed: false };
    }

    const response = await fetch(`${this.config.controllerUrl}/proxies/${encodeURIComponent(this.config.groupName)}`, {
      method: "PUT",
      headers: this.headers({ "content-type": "application/json" }),
      body: JSON.stringify({ name: target }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Mihomo 切换失败 (${response.status}): ${body || response.statusText}`);
    }

    this.logger.info(`[proxy-watchdog] mihomo 已切换 ${this.config.groupName}: ${current ?? "<unknown>"} -> ${target}`);
    return { from: current, to: target, changed: true };
  }

  private async fetchGroup(): Promise<Record<string, unknown>> {
    const response = await fetch(`${this.config.controllerUrl}/proxies/${encodeURIComponent(this.config.groupName)}`, {
      headers: this.headers(),
    });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Mihomo 读取代理组失败 (${response.status}): ${body || response.statusText}`);
    }
    return await response.json() as Record<string, unknown>;
  }

  private headers(extra?: Record<string, string>) {
    const secret = resolveSecret(this.config);
    return {
      ...(secret ? { Authorization: `Bearer ${secret}` } : {}),
      ...(extra ?? {}),
    };
  }
}

function resolveSecret(config: MihomoDriverConfig): string | null {
  if (config.secretEnv && process.env[config.secretEnv]?.trim()) {
    return process.env[config.secretEnv]?.trim() ?? null;
  }
  return config.secret;
}

function readString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed || null;
}
