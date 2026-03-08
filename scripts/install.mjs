#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const pluginId = "network-proxy-watchdog";
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

main();

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  if (!options.openclawDir) {
    fail("缺少必填参数：--openclaw-dir <path>");
  }

  const openclawDir = resolvePath(options.openclawDir);
  const extensionsDir = path.join(openclawDir, ".openclaw", "extensions");
  if (!pathExists(extensionsDir) || !fs.statSync(extensionsDir).isDirectory()) {
    fail(`未找到扩展目录：${extensionsDir}\n请先确认 OpenClaw 宿主目录下存在 .openclaw/extensions。`);
  }

  const configPath = resolvePath(options.configPath ?? path.join(openclawDir, "openclaw.json"));
  const extTarget = path.join(extensionsDir, pluginId);
  const installMode = options.mode;
  const backupDir = path.join(openclawDir, ".openclaw", "backups", pluginId, formatTimestamp(new Date()));

  const existingConfig = readExistingConfig(configPath);
  const pluginEntry = buildPluginEntry(options);
  const nextConfig = {
    ...(existingConfig ?? {}),
    [pluginId]: pluginEntry[pluginId],
  };

  if (!options.skipBuild) {
    ensureBuilt(repoRoot);
  }

  const sourceManifest = readPluginManifest(path.join(repoRoot, "openclaw.plugin.json"));
  const extensionState = inspectExtensionTarget({
    targetPath: extTarget,
    expectedSourceDir: repoRoot,
    expectedManifest: sourceManifest,
    mode: installMode,
  });
  const configState = inspectConfigState({ existingConfig, desiredConfig: nextConfig, configPath });
  const action = decideAction({ extensionState, configState, force: options.force });

  if (action.kind === "no-op") {
    printNoopSummary({
      openclawDir,
      configPath,
      extTarget,
      installMode,
      extensionState,
      configState,
    });
    return;
  }

  fs.mkdirSync(backupDir, { recursive: true });

  const extensionBackupPath = action.reinstallExtension
    ? backupExistingPath(extTarget, path.join(backupDir, "extension-backup"))
    : null;
  const configBackupPath = action.rewriteConfig
    ? backupConfig(configPath, backupDir)
    : null;

  if (action.reinstallExtension) {
    installExtension({ mode: installMode, sourceDir: repoRoot, targetDir: extTarget });
  }

  if (action.rewriteConfig) {
    writeJson(configPath, nextConfig);
  }

  const restoreScriptPath = path.join(backupDir, "restore.sh");
  writeRestoreScript({
    restoreScriptPath,
    extTarget,
    extensionBackupPath,
    configPath,
    configBackupPath,
    configPreviouslyExisted: existingConfig !== null,
    removeConfigOnRestore: existingConfig === null && action.rewriteConfig,
  });

  writeJson(path.join(backupDir, "install-report.json"), {
    pluginId,
    repoRoot,
    openclawDir,
    configPath,
    extensionsDir,
    extTarget,
    installMode,
    backupDir,
    action,
    extensionState,
    configState,
    extensionBackupPath,
    configBackupPath,
    restoreScriptPath,
  });

  printSummary({
    openclawDir,
    configPath,
    extTarget,
    installMode,
    backupDir,
    restoreScriptPath,
    options,
    action,
    extensionState,
    configState,
  });
}

function parseArgs(argv) {
  const options = {
    help: false,
    openclawDir: null,
    configPath: null,
    mode: "symlink",
    skipBuild: false,
    force: false,
    driver: "mihomo",
    stateFile: "~/.local/state/openclaw-network-proxy-watchdog/state.json",
    healthKind: "telegram-bot-api",
    healthUrl: "https://example.invalid/healthz",
    healthMethod: "GET",
    timeoutMs: 15000,
    intervalMs: 60000,
    expectedStatusCodes: [200],
    healthProxyUrl: "http://127.0.0.1:7890",
    telegramApiBaseUrl: "https://api.telegram.org",
    failureThreshold: 3,
    switchCooldownMs: 300000,
    candidates: [],
    adminSenderIds: [],
    controllerUrl: "http://127.0.0.1:9090",
    secret: null,
    secretEnv: "MIHOMO_CONTROLLER_SECRET",
    groupName: "专项代理",
    baseUrl: "http://127.0.0.1:18795/api",
    webhookTimeoutMs: 15000,
    token: null,
    tokenEnv: "PROXY_CONTROL_TOKEN",
    tokenHeaderName: "Authorization",
    tokenPrefix: "Bearer ",
    shell: "/bin/bash",
    listCommand: "printf 'primary\\nbackup\\n'",
    currentCommand: "printf 'primary\\n'",
    switchCommand: "echo switching-to {{target}}",
    describeCommand: "printf 'custom-command driver\\n'",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "-h":
      case "--help":
        options.help = true;
        break;
      case "--openclaw-dir":
        options.openclawDir = readNext(argv, ++index, arg);
        break;
      case "--config-path":
        options.configPath = readNext(argv, ++index, arg);
        break;
      case "--copy":
        options.mode = "copy";
        break;
      case "--symlink":
        options.mode = "symlink";
        break;
      case "--skip-build":
        options.skipBuild = true;
        break;
      case "--force":
        options.force = true;
        break;
      case "--driver":
        options.driver = readNext(argv, ++index, arg);
        break;
      case "--state-file":
        options.stateFile = readNext(argv, ++index, arg);
        break;
      case "--health-kind":
        options.healthKind = readNext(argv, ++index, arg);
        break;
      case "--health-url":
        options.healthUrl = readNext(argv, ++index, arg);
        break;
      case "--health-method":
        options.healthMethod = readNext(argv, ++index, arg);
        break;
      case "--timeout-ms":
        options.timeoutMs = readNumberArg(readNext(argv, ++index, arg), arg);
        break;
      case "--interval-ms":
        options.intervalMs = readNumberArg(readNext(argv, ++index, arg), arg);
        break;
      case "--expected-status":
        options.expectedStatusCodes.push(readNumberArg(readNext(argv, ++index, arg), arg));
        break;
      case "--health-proxy-url":
        options.healthProxyUrl = readNext(argv, ++index, arg);
        break;
      case "--telegram-api-base-url":
        options.telegramApiBaseUrl = readNext(argv, ++index, arg);
        break;
      case "--failure-threshold":
        options.failureThreshold = readNumberArg(readNext(argv, ++index, arg), arg);
        break;
      case "--switch-cooldown-ms":
        options.switchCooldownMs = readNumberArg(readNext(argv, ++index, arg), arg);
        break;
      case "--candidate":
        options.candidates.push(readNext(argv, ++index, arg));
        break;
      case "--admin-sender":
        options.adminSenderIds.push(readNext(argv, ++index, arg));
        break;
      case "--controller-url":
        options.controllerUrl = readNext(argv, ++index, arg);
        break;
      case "--secret":
        options.secret = readNext(argv, ++index, arg);
        break;
      case "--secret-env":
        options.secretEnv = readNext(argv, ++index, arg);
        break;
      case "--group-name":
        options.groupName = readNext(argv, ++index, arg);
        break;
      case "--base-url":
        options.baseUrl = readNext(argv, ++index, arg);
        break;
      case "--webhook-timeout-ms":
        options.webhookTimeoutMs = readNumberArg(readNext(argv, ++index, arg), arg);
        break;
      case "--token":
        options.token = readNext(argv, ++index, arg);
        break;
      case "--token-env":
        options.tokenEnv = readNext(argv, ++index, arg);
        break;
      case "--token-header-name":
        options.tokenHeaderName = readNext(argv, ++index, arg);
        break;
      case "--token-prefix":
        options.tokenPrefix = readNext(argv, ++index, arg);
        break;
      case "--shell":
        options.shell = readNext(argv, ++index, arg);
        break;
      case "--list-command":
        options.listCommand = readNext(argv, ++index, arg);
        break;
      case "--current-command":
        options.currentCommand = readNext(argv, ++index, arg);
        break;
      case "--switch-command":
        options.switchCommand = readNext(argv, ++index, arg);
        break;
      case "--describe-command":
        options.describeCommand = readNext(argv, ++index, arg);
        break;
      default:
        fail(`未知参数：${arg}\n可使用 --help 查看帮助。`);
    }
  }

  options.driver = normalizeDriver(options.driver);
  options.healthKind = normalizeHealthKind(options.healthKind);
  options.healthMethod = normalizeHealthMethod(options.healthMethod);
  options.expectedStatusCodes = Array.from(new Set(options.expectedStatusCodes.filter((item) => Number.isFinite(item))));
  return options;
}

function printHelp() {
  const lines = [
    "OpenClaw Network Proxy Watchdog 一键安装脚本",
    "",
    "用法：",
    "  ./scripts/install.sh --openclaw-dir /path/to/openclaw [options]",
    "",
    "当前模式：",
    "  - 自动识别 fresh-install / upgrade / repair / no-op",
    "  - 检查 .openclaw/extensions、当前安装目标与 openclaw.json 是否已处于期望状态",
    "  - 若发现软链接、复制安装或配置不正确，会先备份，再只修复有问题的部分",
    "  - 若一切已正确，默认不重复安装；可用 --force 强制重装",
    "",
    "常用参数：",
    "  --openclaw-dir <path>        OpenClaw 宿主目录（必填）",
    "  --config-path <path>         指定 openclaw.json 路径，默认是 <openclaw-dir>/openclaw.json",
    "  --driver <name>              mihomo / custom-webhook / custom-command，默认 mihomo",
    "  --copy                       改为复制安装，默认软链接安装",
    "  --symlink                    显式指定软链接安装",
    "  --skip-build                 跳过 npm install / npm run build",
    "  --force                      即使状态正确也强制重装和重写配置",
    "  --admin-sender <id>          可重复传入，例如 telegram:123456",
    "  --candidate <name>           可重复传入候选线路",
    "",
    "Mihomo 常用参数：",
    "  --controller-url <url>",
    "  --group-name <name>",
    "  --secret <value>",
    "  --secret-env <name>",
    "",
    "Custom Webhook 常用参数：",
    "  --base-url <url>",
    "  --token <value>",
    "  --token-env <name>",
    "  --token-header-name <name>",
    "  --token-prefix <prefix>",
    "",
    "Custom Command 常用参数：",
    "  --shell <path>",
    "  --list-command <cmd>",
    "  --current-command <cmd>",
    "  --switch-command <cmd>",
    "  --describe-command <cmd>",
    "",
    "示例：",
    "  ./scripts/install.sh --openclaw-dir /srv/openclaw --driver mihomo --controller-url http://127.0.0.1:9090 --group-name 专项代理 --candidate 香港A --candidate 日本B --admin-sender telegram:123456",
    "  ./scripts/install.sh --openclaw-dir /srv/openclaw --driver custom-webhook --base-url http://127.0.0.1:18795/api --admin-sender telegram:123456",
  ];
  console.log(lines.join("\n"));
}

function buildPluginEntry(options) {
  const adminSenderIds = options.adminSenderIds.length ? options.adminSenderIds : ["telegram:YOUR_USER_ID"];
  return {
    [pluginId]: {
      enabled: true,
      config: {
        enabled: true,
        stateFile: options.stateFile,
        healthCheck: {
          kind: options.healthKind,
          url: options.healthUrl,
          method: options.healthMethod,
          timeoutMs: options.timeoutMs,
          intervalMs: options.intervalMs,
          expectedStatusCodes: options.expectedStatusCodes,
          proxyUrl: options.healthProxyUrl,
          telegramApiBaseUrl: options.telegramApiBaseUrl,
        },
        switchPolicy: {
          failureThreshold: options.failureThreshold,
          switchCooldownMs: options.switchCooldownMs,
          candidates: options.candidates,
        },
        commandAccess: {
          adminSenderIds,
        },
        driver: buildDriverConfig(options),
      },
    },
  };
}

function buildDriverConfig(options) {
  if (options.driver === "custom-command") {
    return {
      type: "custom-command",
      shell: options.shell,
      listCommand: options.listCommand,
      currentCommand: options.currentCommand,
      switchCommand: options.switchCommand,
      describeCommand: options.describeCommand,
      env: {},
    };
  }

  if (options.driver === "custom-webhook") {
    return {
      type: "custom-webhook",
      baseUrl: options.baseUrl,
      timeoutMs: options.webhookTimeoutMs,
      token: options.token,
      tokenEnv: options.tokenEnv,
      tokenHeaderName: options.tokenHeaderName,
      tokenPrefix: options.tokenPrefix,
      headers: {
        "x-client": pluginId,
      },
      listRequest: {
        method: "GET",
        path: "/targets",
        resultPath: "data.targets",
      },
      currentRequest: {
        method: "GET",
        path: "/targets/current",
        resultPath: "data.current",
      },
      switchRequest: {
        method: "POST",
        path: "/targets/switch",
        body: "{\"target\":\"{{target}}\",\"current\":\"{{current}}\"}",
        fromPath: "data.from",
        toPath: "data.to",
        changedPath: "data.changed",
      },
      describeRequest: {
        method: "GET",
        path: "/describe",
        resultPath: "data",
      },
    };
  }

  return {
    type: "mihomo",
    controllerUrl: options.controllerUrl,
    secret: options.secret,
    secretEnv: options.secretEnv,
    groupName: options.groupName,
  };
}

function ensureBuilt(rootDir) {
  const nodeModulesDir = path.join(rootDir, "node_modules");
  if (!pathExists(nodeModulesDir)) {
    runCommand(getNpmCommand(), ["install"], rootDir);
  }
  runCommand(getNpmCommand(), ["run", "build"], rootDir);
}

function inspectExtensionTarget(params) {
  const exists = pathExists(params.targetPath, { includeBrokenSymlink: true });
  if (!exists) {
    return {
      exists: false,
      ok: false,
      status: "missing",
      detail: "未安装扩展目标",
    };
  }

  const stat = fs.lstatSync(params.targetPath);
  if (params.mode === "symlink") {
    if (!stat.isSymbolicLink()) {
      return {
        exists: true,
        ok: false,
        status: "wrong-type",
        detail: "当前安装不是软链接",
      };
    }
    const linkTarget = safeReadLink(params.targetPath);
    const resolvedTarget = linkTarget ? path.resolve(path.dirname(params.targetPath), linkTarget) : null;
    const expectedTarget = path.resolve(params.expectedSourceDir);
    const ok = resolvedTarget === expectedTarget;
    return {
      exists: true,
      ok,
      status: ok ? "ok" : "wrong-target",
      detail: ok ? "软链接目标正确" : `软链接目标异常：${resolvedTarget ?? "<unknown>"}`,
      linkTarget,
      resolvedTarget,
    };
  }

  if (stat.isSymbolicLink()) {
    return {
      exists: true,
      ok: false,
      status: "wrong-type",
      detail: "当前安装是软链接，但期望复制目录",
    };
  }

  const manifestPath = path.join(params.targetPath, "openclaw.plugin.json");
  if (!pathExists(manifestPath)) {
    return {
      exists: true,
      ok: false,
      status: "missing-manifest",
      detail: "扩展目录缺少 openclaw.plugin.json",
    };
  }

  try {
    const manifest = readPluginManifest(manifestPath);
    if (manifest.id !== pluginId) {
      return {
        exists: true,
        ok: false,
        status: "invalid-manifest",
        detail: "扩展目录存在，但不是当前插件",
      };
    }

    const installedVersion = manifest.version;
    const expectedVersion = params.expectedManifest.version;
    const ok = installedVersion === expectedVersion;
    return {
      exists: true,
      ok,
      status: ok ? "ok" : "outdated-copy",
      detail: ok
        ? "复制目录安装正确"
        : `复制目录版本过旧：已安装 ${installedVersion}，仓库版本 ${expectedVersion}`,
      installedVersion,
      expectedVersion,
    };
  } catch (error) {
    return {
      exists: true,
      ok: false,
      status: "invalid-manifest",
      detail: `扩展清单解析失败：${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function readPluginManifest(manifestPath) {
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    if (!isPlainObject(manifest) || typeof manifest.id !== "string" || typeof manifest.version !== "string") {
      throw new Error("插件清单缺少 id 或 version");
    }
    return manifest;
  } catch (error) {
    fail(`${manifestPath} 解析失败：${error instanceof Error ? error.message : String(error)}`);
  }
}

function inspectConfigState(params) {
  if (params.existingConfig === null) {
    return {
      exists: false,
      ok: false,
      status: "missing",
      detail: "openclaw.json 不存在，将创建并写入插件配置",
    };
  }

  const currentPluginConfig = params.existingConfig[pluginId];
  const desiredPluginConfig = params.desiredConfig[pluginId];
  const ok = deepEqual(currentPluginConfig, desiredPluginConfig);
  return {
    exists: true,
    ok,
    status: ok ? "ok" : (currentPluginConfig === undefined ? "missing-plugin-entry" : "drifted"),
    detail: ok
      ? "插件配置已是期望状态"
      : (currentPluginConfig === undefined ? "openclaw.json 存在，但缺少插件条目" : "插件配置与期望值不一致"),
  };
}

function decideAction(params) {
  if (params.force) {
    return {
      kind: "repair",
      reinstallExtension: true,
      rewriteConfig: true,
      reason: "已指定 --force，强制重装并重写配置",
    };
  }

  const reinstallExtension = !params.extensionState.ok;
  const rewriteConfig = !params.configState.ok;
  if (!reinstallExtension && !rewriteConfig) {
    return {
      kind: "no-op",
      reinstallExtension: false,
      rewriteConfig: false,
      reason: "扩展安装与配置均已正确",
    };
  }

  let kind = "repair";
  if (!params.extensionState.exists && !params.configState.exists) {
    kind = "fresh-install";
  } else if (params.extensionState.ok && !params.configState.ok) {
    kind = params.configState.status === "missing-plugin-entry" ? "upgrade" : "repair";
  } else if (!params.extensionState.ok && params.configState.ok) {
    kind = ["missing", "outdated-copy"].includes(params.extensionState.status) ? "upgrade" : "repair";
  } else if (!params.extensionState.exists || !params.configState.exists) {
    kind = "upgrade";
  }

  return {
    kind,
    reinstallExtension,
    rewriteConfig,
    reason: buildActionReason({ kind, extensionState: params.extensionState, configState: params.configState }),
  };
}

function buildActionReason(params) {
  const issues = [];
  if (!params.extensionState.ok) issues.push(`扩展目标：${params.extensionState.detail}`);
  if (!params.configState.ok) issues.push(`配置状态：${params.configState.detail}`);
  return `${params.kind}，${issues.join("；")}`;
}

function installExtension(params) {
  if (params.mode === "copy") {
    fs.cpSync(params.sourceDir, params.targetDir, {
      recursive: true,
      dereference: false,
      filter: (source) => shouldCopyPath(params.sourceDir, source),
    });
    return;
  }
  fs.symlinkSync(params.sourceDir, params.targetDir, "dir");
}

function shouldCopyPath(rootDir, source) {
  const relativePath = path.relative(rootDir, source);
  if (!relativePath) return true;
  const firstSegment = relativePath.split(path.sep)[0];
  return firstSegment !== ".git";
}

function backupExistingPath(targetPath, backupPath) {
  if (!pathExists(targetPath, { includeBrokenSymlink: true })) {
    return null;
  }
  fs.renameSync(targetPath, backupPath);
  return backupPath;
}

function backupConfig(configPath, backupDir) {
  if (!pathExists(configPath)) {
    return null;
  }
  const backupPath = path.join(backupDir, `${path.basename(configPath)}.bak`);
  fs.copyFileSync(configPath, backupPath);
  return backupPath;
}

function readExistingConfig(configPath) {
  if (!pathExists(configPath)) {
    return null;
  }
  try {
    const raw = fs.readFileSync(configPath, "utf8");
    const parsed = JSON.parse(raw);
    if (!isPlainObject(parsed)) {
      fail(`${configPath} 不是 JSON 对象，当前安装脚本无法自动合并。`);
    }
    return parsed;
  } catch (error) {
    fail(`${configPath} 解析失败：${error instanceof Error ? error.message : String(error)}\n当前安装脚本仅支持严格 JSON 格式的 openclaw.json。`);
  }
}

function writeRestoreScript(params) {
  const lines = [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    `EXT_TARGET=${shellQuote(params.extTarget)}`,
    `CONFIG_PATH=${shellQuote(params.configPath)}`,
    `EXT_BACKUP=${shellQuote(params.extensionBackupPath ?? "")}`,
    `CONFIG_BACKUP=${shellQuote(params.configBackupPath ?? "")}`,
    "if [ -e \"$EXT_TARGET\" ] || [ -L \"$EXT_TARGET\" ]; then rm -rf \"$EXT_TARGET\"; fi",
    params.extensionBackupPath
      ? "if [ -e \"$EXT_BACKUP\" ] || [ -L \"$EXT_BACKUP\" ]; then mv \"$EXT_BACKUP\" \"$EXT_TARGET\"; fi"
      : "true",
    params.configBackupPath
      ? "cp \"$CONFIG_BACKUP\" \"$CONFIG_PATH\""
      : (params.removeConfigOnRestore ? "rm -f \"$CONFIG_PATH\"" : "true"),
    "echo \"已恢复 network-proxy-watchdog 安装前备份。\"",
  ];
  fs.writeFileSync(params.restoreScriptPath, `${lines.join("\n")}\n`, "utf8");
  fs.chmodSync(params.restoreScriptPath, 0o755);
}

function printSummary(params) {
  const lines = [
    "安装完成。",
    `- 执行动作：${params.action.kind}`,
    `- 原因：${params.action.reason}`,
    `- OpenClaw 目录：${params.openclawDir}`,
    `- 安装方式：${params.installMode}`,
    `- 扩展位置：${params.extTarget}`,
    `- 配置文件：${params.configPath}`,
    `- 扩展处理：${params.action.reinstallExtension ? "已重装/修复" : "无需改动"}`,
    `- 配置处理：${params.action.rewriteConfig ? "已重写/修复" : "无需改动"}`,
    `- 备份目录：${params.backupDir}`,
    `- 恢复脚本：${params.restoreScriptPath}`,
    `- 驱动类型：${params.options.driver}`,
    `- 健康检查：${params.options.healthKind}`,
  ];
  if (params.options.adminSenderIds.length === 0) {
    lines.push("- 管理员：使用默认占位值 telegram:YOUR_USER_ID，请记得改成真实 ID");
  }
  if (params.options.driver === "custom-webhook" && params.options.baseUrl === "http://127.0.0.1:18795/api") {
    lines.push("- Webhook 地址仍是示例值，请确认已改成你的实际控制接口");
  }
  if (params.options.driver === "custom-command" && params.options.switchCommand === "echo switching-to {{target}}") {
    lines.push("- custom-command 仍是示例命令，请替换成真实切线命令");
  }
  lines.push("- 如需回滚，可执行上面的 restore.sh");
  console.log(lines.join("\n"));
}

function printNoopSummary(params) {
  const lines = [
    "无需变更。",
    "- 执行动作：no-op",
    "- 原因：扩展安装与配置均已正确",
    `- OpenClaw 目录：${params.openclawDir}`,
    `- 安装方式：${params.installMode}`,
    `- 扩展位置：${params.extTarget}`,
    `- 配置文件：${params.configPath}`,
    `- 扩展状态：${params.extensionState.detail}`,
    `- 配置状态：${params.configState.detail}`,
    "- 如需强制重装，请追加 --force",
  ];
  console.log(lines.join("\n"));
}

function normalizeDriver(value) {
  switch ((value ?? "").trim()) {
    case "custom-command":
    case "custom-webhook":
      return value.trim();
    case "mihomo":
    default:
      return "mihomo";
  }
}

function normalizeHealthKind(value) {
  return value === "http" ? "http" : "telegram-bot-api";
}

function normalizeHealthMethod(value) {
  return String(value ?? "GET").trim().toUpperCase() === "HEAD" ? "HEAD" : "GET";
}

function resolvePath(inputPath) {
  if (!inputPath) return inputPath;
  if (inputPath === "~") return os.homedir();
  if (inputPath.startsWith("~/")) return path.join(os.homedir(), inputPath.slice(2));
  return path.resolve(inputPath);
}

function readNumberArg(value, flagName) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    fail(`${flagName} 需要数值参数，收到：${value}`);
  }
  return parsed;
}

function readNext(argv, index, flagName) {
  const value = argv[index];
  if (!value) {
    fail(`${flagName} 缺少参数值。`);
  }
  return value;
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function runCommand(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    stdio: "inherit",
    env: process.env,
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function getNpmCommand() {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

function formatTimestamp(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  const seconds = String(date.getSeconds()).padStart(2, "0");
  return `${year}${month}${day}_${hours}${minutes}${seconds}`;
}

function pathExists(targetPath, options = { includeBrokenSymlink: false }) {
  try {
    if (options.includeBrokenSymlink) {
      fs.lstatSync(targetPath);
      return true;
    }
    fs.accessSync(targetPath);
    return true;
  } catch {
    return false;
  }
}

function safeReadLink(targetPath) {
  try {
    return fs.readlinkSync(targetPath);
  } catch {
    return null;
  }
}

function deepEqual(left, right) {
  return JSON.stringify(sortObject(left)) === JSON.stringify(sortObject(right));
}

function sortObject(value) {
  if (Array.isArray(value)) {
    return value.map((item) => sortObject(item));
  }
  if (!isPlainObject(value)) {
    return value;
  }
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortObject(value[key])]));
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
