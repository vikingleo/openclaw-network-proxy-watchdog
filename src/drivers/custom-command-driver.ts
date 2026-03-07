import { execShell, renderTemplate } from "../shell.js";
import type { CustomCommandDriverConfig, DriverDescribeResult, DriverSwitchResult, NetworkProxyDriver } from "../types.js";

export class CustomCommandDriver implements NetworkProxyDriver {
  readonly type = "custom-command" as const;

  constructor(private readonly config: CustomCommandDriverConfig) {}

  async describe(): Promise<DriverDescribeResult> {
    if (!this.config.describeCommand) {
      return {
        type: this.type,
        detail: {
          shell: this.config.shell,
          listCommand: this.config.listCommand,
          currentCommand: this.config.currentCommand,
        },
      };
    }

    const result = await execShell({
      shell: this.config.shell,
      command: this.config.describeCommand,
      env: this.config.env,
      timeoutMs: 30_000,
    });
    if (result.exitCode !== 0) {
      throw new Error(`describeCommand 执行失败: ${result.stderr || result.stdout}`);
    }
    return {
      type: this.type,
      detail: {
        output: result.stdout.trim(),
      },
    };
  }

  async listTargets(): Promise<string[]> {
    const result = await execShell({
      shell: this.config.shell,
      command: this.config.listCommand,
      env: this.config.env,
      timeoutMs: 30_000,
    });
    if (result.exitCode !== 0) {
      throw new Error(`listCommand 执行失败: ${result.stderr || result.stdout}`);
    }
    return result.stdout.split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
  }

  async getCurrentTarget(): Promise<string | null> {
    const result = await execShell({
      shell: this.config.shell,
      command: this.config.currentCommand,
      env: this.config.env,
      timeoutMs: 30_000,
    });
    if (result.exitCode !== 0) {
      throw new Error(`currentCommand 执行失败: ${result.stderr || result.stdout}`);
    }
    return result.stdout.split(/\r?\n/).map((item) => item.trim()).find(Boolean) ?? null;
  }

  async switchTarget(target: string): Promise<DriverSwitchResult> {
    const current = await this.getCurrentTarget();
    const command = renderTemplate(this.config.switchCommand, { target, current: current ?? "" });
    const result = await execShell({
      shell: this.config.shell,
      command,
      env: this.config.env,
      timeoutMs: 60_000,
    });
    if (result.exitCode !== 0) {
      throw new Error(`switchCommand 执行失败: ${result.stderr || result.stdout}`);
    }
    return { from: current, to: target, changed: current !== target };
  }
}
