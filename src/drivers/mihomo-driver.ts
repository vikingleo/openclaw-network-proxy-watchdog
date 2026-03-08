import type {
  DriverDelayProbeParams,
  DriverDescribeResult,
  DriverSwitchResult,
  DriverTargetDelayResult,
  LoggerLike,
  MihomoDriverConfig,
  NetworkProxyDriver,
} from "../types.js";

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

  async measureTargets(params: DriverDelayProbeParams): Promise<DriverTargetDelayResult[]> {
    const targets = Array.from(new Set(params.targets.map((item) => item.trim()).filter(Boolean)));
    return await Promise.all(targets.map(async (target) => await this.measureTargetDelay(target, params.url, params.timeoutMs)));
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

  private async measureTargetDelay(target: string, url: string, timeoutMs: number): Promise<DriverTargetDelayResult> {
    const search = new URLSearchParams({
      url,
      timeout: String(Math.max(1, Math.floor(timeoutMs))),
    });

    try {
      const response = await fetch(`${this.config.controllerUrl}/proxies/${encodeURIComponent(target)}/delay?${search.toString()}`, {
        headers: this.headers(),
      });

      if (!response.ok) {
        const body = (await response.text()).trim();
        return {
          target,
          ok: false,
          delayMs: null,
          summary: body ? `HTTP ${response.status}: ${truncate(body, 160)}` : `HTTP ${response.status}`,
        };
      }

      const payload = await response.json() as Record<string, unknown>;
      const delayMs = readDelay(payload.delay);
      if (delayMs === null) {
        return { target, ok: false, delayMs: null, summary: "未返回有效延迟" };
      }

      return {
        target,
        ok: delayMs > 0,
        delayMs: delayMs > 0 ? delayMs : null,
        summary: delayMs > 0 ? `${delayMs}ms` : "延迟测试未通过",
      };
    } catch (error) {
      return {
        target,
        ok: false,
        delayMs: null,
        summary: error instanceof Error ? error.message : String(error),
      };
    }
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

function readDelay(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  return Math.max(0, Math.round(value));
}

function truncate(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, Math.max(0, maxLength - 1))}…` : value;
}
