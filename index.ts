import type { OpenClawPluginApi, OpenClawPluginServiceContext } from "openclaw/plugin-sdk";

import { buildRuntimeConfigFromPlugin } from "./src/config.js";
import { registerProxyWatchdogCli } from "./src/plugin-cli.js";
import { NetworkProxyWatchdogService } from "./src/service.js";
import type { LoggerLike } from "./src/types.js";

let runtimeService: NetworkProxyWatchdogService | null = null;

const plugin = {
  id: "network-proxy-watchdog",
  name: "网络代理看门狗",
  description: "代理健康检查与自动切线插件，支持可插拔驱动。",
  register(api: OpenClawPluginApi) {
    const logger: LoggerLike = {
      info: (message) => api.logger.info(message),
      warn: (message) => api.logger.warn(message),
      error: (message) => api.logger.error(message),
      debug: (message) => api.logger.debug?.(message),
    };

    api.registerCli(
      ({ program }) => {
        registerProxyWatchdogCli({
          program,
          openclawConfig: api.config as Record<string, unknown>,
          pluginConfig: api.pluginConfig,
          logger,
        });
      },
      { commands: ["proxy-watchdog"] },
    );

    api.registerService({
      id: "network-proxy-watchdog",
      start: async (_ctx: OpenClawPluginServiceContext) => {
        if (runtimeService) {
          return;
        }
        const config = buildRuntimeConfigFromPlugin({
          openclawConfig: api.config as Record<string, unknown>,
          pluginConfig: api.pluginConfig,
        });
        runtimeService = new NetworkProxyWatchdogService({ config, openclawConfig: api.config as Record<string, unknown>, logger });
        await runtimeService.start();
      },
      stop: async () => {
        await runtimeService?.stop();
        runtimeService = null;
      },
    });
  },
};

export default plugin;
