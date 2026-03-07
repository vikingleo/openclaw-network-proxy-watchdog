import type {
  CustomWebhookDriverConfig,
  CustomWebhookRequestConfig,
  CustomWebhookSwitchRequestConfig,
  DriverDescribeResult,
  DriverSwitchResult,
  LoggerLike,
  NetworkProxyDriver,
} from "../types.js";

export class CustomWebhookDriver implements NetworkProxyDriver {
  readonly type = "custom-webhook" as const;

  constructor(
    private readonly config: CustomWebhookDriverConfig,
    private readonly logger: LoggerLike,
  ) {}

  async describe(): Promise<DriverDescribeResult> {
    if (!this.config.describeRequest) {
      return {
        type: this.type,
        detail: {
          baseUrl: this.config.baseUrl,
          timeoutMs: this.config.timeoutMs,
          listRequest: summarizeRequest(this.config.listRequest),
          currentRequest: summarizeRequest(this.config.currentRequest),
          switchRequest: summarizeSwitchRequest(this.config.switchRequest),
        },
      };
    }

    const response = await this.sendRequest(this.config.describeRequest, {});
    const detail = this.config.describeRequest.resultPath
      ? readPath(response.body, this.config.describeRequest.resultPath)
      : response.body;

    return {
      type: this.type,
      detail: isPlainObject(detail)
        ? detail
        : {
            value: detail,
          },
    };
  }

  async listTargets(): Promise<string[]> {
    const response = await this.sendRequest(this.config.listRequest, {});
    const rawTargets = this.config.listRequest.resultPath
      ? readPath(response.body, this.config.listRequest.resultPath)
      : response.body;

    if (Array.isArray(rawTargets)) {
      return rawTargets.map((item) => String(item).trim()).filter(Boolean);
    }
    if (typeof rawTargets === "string") {
      return rawTargets.split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
    }
    return [];
  }

  async getCurrentTarget(): Promise<string | null> {
    const response = await this.sendRequest(this.config.currentRequest, {});
    const rawCurrent = this.config.currentRequest.resultPath
      ? readPath(response.body, this.config.currentRequest.resultPath)
      : response.body;
    return readString(rawCurrent);
  }

  async switchTarget(target: string): Promise<DriverSwitchResult> {
    const current = await this.getCurrentTarget();
    const response = await this.sendRequest(this.config.switchRequest, {
      target,
      current: current ?? "",
    });

    const from = readString(readMaybePath(response.body, this.config.switchRequest.fromPath)) ?? current;
    const to = readString(readMaybePath(response.body, this.config.switchRequest.toPath)) ?? target;
    const changed = readBoolean(readMaybePath(response.body, this.config.switchRequest.changedPath)) ?? from !== to;

    this.logger.info(`[proxy-watchdog] custom-webhook 已切换 ${from ?? "<unknown>"} -> ${to}`);
    return { from, to, changed };
  }

  private async sendRequest(requestConfig: CustomWebhookRequestConfig | CustomWebhookSwitchRequestConfig, values: Record<string, string>) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);
    try {
      const url = resolveUrl(this.config.baseUrl, renderTextTemplate(requestConfig.path, values));
      const headers = {
        ...this.config.headers,
        ...renderHeaderMap(requestConfig.headers, values),
      };
      const token = resolveToken(this.config);
      if (token) {
        headers[this.config.tokenHeaderName] = `${this.config.tokenPrefix}${token}`;
      }

      const body = requestConfig.body ? renderTextTemplate(requestConfig.body, values) : undefined;
      if (body && !hasContentType(headers)) {
        headers["content-type"] = "application/json";
      }

      const response = await fetch(url, {
        method: requestConfig.method,
        headers,
        body: allowsRequestBody(requestConfig.method) ? body : undefined,
        signal: controller.signal,
      });

      const parsed = await parseResponseBody(response);
      if (!response.ok) {
        throw new Error(`Webhook 请求失败 (${response.status}): ${stringifyForError(parsed) || response.statusText}`);
      }

      return { status: response.status, body: parsed };
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error(`Webhook 请求超时（${this.config.timeoutMs}ms）`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
}

function summarizeRequest(request: CustomWebhookRequestConfig) {
  return {
    method: request.method,
    path: request.path,
    resultPath: request.resultPath,
  };
}

function summarizeSwitchRequest(request: CustomWebhookSwitchRequestConfig) {
  return {
    ...summarizeRequest(request),
    fromPath: request.fromPath,
    toPath: request.toPath,
    changedPath: request.changedPath,
  };
}

function renderHeaderMap(headers: Record<string, string>, values: Record<string, string>) {
  return Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key, renderTextTemplate(value, values)]),
  );
}

function renderTextTemplate(template: string, values: Record<string, string>): string {
  let output = template;
  for (const [key, value] of Object.entries(values)) {
    output = output.replaceAll(`{{${key}}}`, value);
  }
  return output;
}

function resolveUrl(baseUrl: string, requestPath: string): string {
  if (/^https?:\/\//i.test(requestPath)) {
    return requestPath;
  }
  const normalizedPath = requestPath.replace(/^\/+/, "");
  return new URL(normalizedPath, ensureTrailingSlash(baseUrl)).toString();
}

function ensureTrailingSlash(url: string): string {
  return url.endsWith("/") ? url : `${url}/`;
}

function resolveToken(config: CustomWebhookDriverConfig): string | null {
  if (config.tokenEnv && process.env[config.tokenEnv]?.trim()) {
    return process.env[config.tokenEnv]?.trim() ?? null;
  }
  return config.token;
}

function hasContentType(headers: Record<string, string>): boolean {
  return Object.keys(headers).some((key) => key.toLowerCase() === "content-type");
}

function allowsRequestBody(method: string): boolean {
  return method !== "GET" && method !== "HEAD";
}

async function parseResponseBody(response: Response): Promise<unknown> {
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  const raw = await response.text();
  if (!raw) {
    return null;
  }
  if (contentType.includes("application/json")) {
    try {
      return JSON.parse(raw) as unknown;
    } catch {
      return raw;
    }
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}

function stringifyForError(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value.trim();
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function readMaybePath(value: unknown, path: string | null): unknown {
  if (!path) {
    return null;
  }
  return readPath(value, path);
}

function readPath(value: unknown, path: string): unknown {
  const normalized = path.trim();
  if (!normalized || normalized === "$") {
    return value;
  }

  const segments = normalized
    .replace(/^\$\.?/, "")
    .replace(/\[(\d+)\]/g, ".$1")
    .split(".")
    .map((segment) => segment.trim())
    .filter(Boolean);

  let current: unknown = value;
  for (const segment of segments) {
    if (Array.isArray(current) && /^\d+$/.test(segment)) {
      current = current[Number(segment)];
      continue;
    }
    if (!isPlainObject(current)) {
      return undefined;
    }
    current = current[segment];
  }
  return current;
}

function readString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed || null;
}

function readBoolean(value: unknown): boolean | null {
  if (typeof value === "boolean") {
    return value;
  }
  return null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
