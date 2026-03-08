import os from "node:os";
import path from "node:path";

import { buildRuntimeConfigFromPlugin } from "./config.js";
import { createDriver } from "./driver-factory.js";
import { loadState } from "./state-store.js";
import type { LoggerLike, RuntimeConfig } from "./types.js";
import { runWatchdogIteration } from "./service.js";

export function registerProxyWatchdogCli(params: {
  program: any;
  openclawConfig: Record<string, unknown>;
  pluginConfig?: Record<string, unknown>;
  logger: LoggerLike;
}) {
  const { program, openclawConfig, pluginConfig, logger } = params;
  const root = program
    .command("proxy-watchdog")
    .description("网络代理看门狗插件工具")
    .addHelpText(
      "after",
      () => [
        "",
        "示例：",
        "  openclaw proxy-watchdog status",
        "  openclaw proxy-watchdog describe-driver",
        "  openclaw proxy-watchdog run-once",
        "  openclaw proxy-watchdog list-targets",
        "  openclaw proxy-watchdog switch --target backup",
      ].join("\n"),
    );

  root
    .command("status")
    .description("显示当前配置摘要与状态")
    .action(() => {
      const config = resolveCliRuntimeConfig({ openclawConfig, pluginConfig });
      const state = loadState(config);
      console.log(JSON.stringify(summarizeConfig(config, state), null, 2));
    });

  root
    .command("describe-driver")
    .description("读取驱动详情")
    .action(async () => {
      const config = resolveCliRuntimeConfig({ openclawConfig, pluginConfig });
      const driver = createDriver(config.driver, logger);
      console.log(JSON.stringify({
        autoSwitchPolicy: formatAutoSwitchPolicy(config),
        describe: await driver.describe(),
      }, null, 2));
    });

  root
    .command("list-targets")
    .description("列出当前驱动可切换目标")
    .action(async () => {
      const config = resolveCliRuntimeConfig({ openclawConfig, pluginConfig });
      const driver = createDriver(config.driver, logger);
      console.log(JSON.stringify({ targets: await driver.listTargets() }, null, 2));
    });

  root
    .command("current-target")
    .description("显示当前目标线路")
    .action(async () => {
      const config = resolveCliRuntimeConfig({ openclawConfig, pluginConfig });
      const driver = createDriver(config.driver, logger);
      console.log(JSON.stringify({ currentTarget: await driver.getCurrentTarget() }, null, 2));
    });

  root
    .command("switch")
    .description("手动切到指定目标")
    .requiredOption("--target <name>", "目标线路名称")
    .action(async (options: { target: string }) => {
      const config = resolveCliRuntimeConfig({ openclawConfig, pluginConfig });
      const driver = createDriver(config.driver, logger);
      console.log(JSON.stringify(await driver.switchTarget(options.target.trim()), null, 2));
    });

  root
    .command("run-once")
    .description("立即执行一次健康检查与必要切线")
    .action(async () => {
      const config = resolveCliRuntimeConfig({ openclawConfig, pluginConfig });
      console.log(JSON.stringify({
        autoSwitchPolicy: formatAutoSwitchPolicy(config),
        result: await runWatchdogIteration({ config, openclawConfig, logger }),
      }, null, 2));
    });

  root
    .command("self-test")
    .description("用临时 custom-command 驱动跑一轮插件烟测")
    .action(async () => {
      const config = buildSmokeConfig(resolveCliRuntimeConfig({ openclawConfig, pluginConfig }));
      const loggerLike: LoggerLike = logger;
      const first = await runWatchdogIteration({ config, openclawConfig, logger: loggerLike });
      const second = await runWatchdogIteration({ config, openclawConfig, logger: loggerLike });
      console.log(JSON.stringify({ ok: true, first, second, stateFile: config.stateFile }, null, 2));
    });
}

function resolveCliRuntimeConfig(params: {
  openclawConfig: Record<string, unknown>;
  pluginConfig?: Record<string, unknown>;
}): RuntimeConfig {
  return buildRuntimeConfigFromPlugin(params);
}

function summarizeConfig(config: RuntimeConfig, state: ReturnType<typeof loadState>) {
  return {
    enabled: config.enabled,
    stateFile: config.stateFile,
    autoSwitchPolicy: formatAutoSwitchPolicy(config),
    healthCheck: {
      kind: config.healthCheck.kind,
      method: config.healthCheck.method,
      intervalMs: config.healthCheck.intervalMs,
      timeoutMs: config.healthCheck.timeoutMs,
      proxyUrl: config.healthCheck.proxyUrl,
      telegramApiBaseUrl: config.healthCheck.telegramApiBaseUrl,
      url: config.healthCheck.url,
    },
    switchPolicy: config.switchPolicy,
    driverType: config.driver.type,
    state,
  };
}

function formatAutoSwitchPolicy(config: RuntimeConfig): string {
  return usesTelegramLowestLatencyPolicy(config)
    ? "Telegram 可用且最低延迟优先"
    : "按候选顺序切线";
}

function usesTelegramLowestLatencyPolicy(config: RuntimeConfig): boolean {
  return config.driver.type === "mihomo" && config.healthCheck.kind === "telegram-bot-api";
}

function buildSmokeConfig(config: RuntimeConfig): RuntimeConfig {
  const root = path.join(os.tmpdir(), "openclaw-network-proxy-watchdog-smoke");
  const targetFile = path.join(root, "current-target.txt");
  return {
    ...config,
    stateFile: path.join(root, "state.json"),
    healthCheck: {
      ...config.healthCheck,
      kind: "http",
      url: "http://127.0.0.1:9/unreachable",
      timeoutMs: 1000,
      intervalMs: 60000,
      expectedStatusCodes: [200],
      proxyUrl: null,
    },
    switchPolicy: {
      failureThreshold: 1,
      switchCooldownMs: 0,
      candidates: ["primary", "backup"],
    },
    driver: {
      type: "custom-command",
      shell: "/bin/bash",
      listCommand: "printf 'primary\\nbackup\\n'",
      currentCommand: `if [ -f ${quoteForShell(targetFile)} ]; then cat ${quoteForShell(targetFile)}; else printf 'primary\\n'; fi`,
      switchCommand: `printf '%s\\n' {{target}} > ${quoteForShell(targetFile)}`,
      describeCommand: "printf 'custom smoke driver\\n'",
      env: {},
    },
  };
}

function quoteForShell(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}
