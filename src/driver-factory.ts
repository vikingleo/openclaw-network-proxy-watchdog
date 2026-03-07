import { CustomCommandDriver } from "./drivers/custom-command-driver.js";
import { MihomoDriver } from "./drivers/mihomo-driver.js";
import type { DriverConfig, LoggerLike, NetworkProxyDriver } from "./types.js";

export function createDriver(driverConfig: DriverConfig, logger: LoggerLike): NetworkProxyDriver {
  if (driverConfig.type === "custom-command") {
    return new CustomCommandDriver(driverConfig);
  }
  return new MihomoDriver(driverConfig, logger);
}
