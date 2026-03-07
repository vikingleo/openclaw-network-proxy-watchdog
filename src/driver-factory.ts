import { CustomCommandDriver } from "./drivers/custom-command-driver.js";
import { CustomWebhookDriver } from "./drivers/custom-webhook-driver.js";
import { MihomoDriver } from "./drivers/mihomo-driver.js";
import type { DriverConfig, LoggerLike, NetworkProxyDriver } from "./types.js";

export function createDriver(driverConfig: DriverConfig, logger: LoggerLike): NetworkProxyDriver {
  if (driverConfig.type === "custom-command") {
    return new CustomCommandDriver(driverConfig);
  }
  if (driverConfig.type === "custom-webhook") {
    return new CustomWebhookDriver(driverConfig, logger);
  }
  return new MihomoDriver(driverConfig, logger);
}
