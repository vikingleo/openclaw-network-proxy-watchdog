export interface LoggerLike {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  debug?(message: string): void;
}

export interface HealthCheckConfig {
  kind: "telegram-bot-api" | "http";
  url: string | null;
  method: "GET" | "HEAD";
  timeoutMs: number;
  intervalMs: number;
  expectedStatusCodes: number[];
  proxyUrl: string | null;
  telegramApiBaseUrl: string;
}

export interface SwitchPolicyConfig {
  failureThreshold: number;
  switchCooldownMs: number;
  candidates: string[];
}

export interface MihomoDriverConfig {
  type: "mihomo";
  controllerUrl: string;
  secret: string | null;
  secretEnv: string | null;
  groupName: string;
}

export interface CustomCommandDriverConfig {
  type: "custom-command";
  shell: string;
  listCommand: string;
  currentCommand: string;
  switchCommand: string;
  describeCommand: string | null;
  env: Record<string, string>;
}

export type DriverConfig = MihomoDriverConfig | CustomCommandDriverConfig;

export interface RuntimeConfig {
  enabled: boolean;
  stateFile: string;
  healthCheck: HealthCheckConfig;
  switchPolicy: SwitchPolicyConfig;
  driver: DriverConfig;
}

export interface ProbeResult {
  ok: boolean;
  countsAsFailure: boolean;
  summary: string;
  statusCode?: number | null;
}

export interface DriverDescribeResult {
  type: string;
  detail: Record<string, unknown>;
}

export interface DriverSwitchResult {
  from: string | null;
  to: string;
  changed: boolean;
}

export interface NetworkProxyDriver {
  readonly type: DriverConfig["type"];
  describe(): Promise<DriverDescribeResult>;
  listTargets(): Promise<string[]>;
  getCurrentTarget(): Promise<string | null>;
  switchTarget(target: string): Promise<DriverSwitchResult>;
}

export interface WatchdogState {
  failureCount: number;
  lastProbeAt: string | null;
  lastProbeSummary: string | null;
  lastProbeOk: boolean | null;
  lastSwitchAt: string | null;
  lastSwitchFrom: string | null;
  lastSwitchTo: string | null;
  currentTarget: string | null;
  lastError: string | null;
}

export interface RunIterationResult {
  probe: ProbeResult;
  switched: boolean;
  switchResult: DriverSwitchResult | null;
  state: WatchdogState;
}
