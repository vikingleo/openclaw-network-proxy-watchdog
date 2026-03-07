# OpenClaw Network Proxy Watchdog

一个标准、可移植的 OpenClaw 网络代理看门狗插件：负责健康检查、失败计数、自动切线，并通过可插拔驱动控制不同代理软件。

## 为什么要做成插件

很多人“跑 Clash / 跑 Mihomo / 跑代理”的方式都五花八门。
如果把看门狗直接写死成某一种代理软件的专属脚本，后面就会越来越像祖传补丁堆。

所以这个插件的设计原则是：

- **插件只负责看门狗逻辑**
- **具体代理怎么控制，交给 driver**
- **驱动可以按环境扩展，不把实现写死**

这样既能落地，也能保持可移植性。

## 当前能力

### 已实现

- OpenClaw 标准插件入口
- 后台 service，跟随 OpenClaw 启停
- CLI 工具集
- 健康检查主循环
- 连续失败计数
- 失败到阈值后自动切线
- `mihomo` 驱动
- `custom-command` 驱动
- `custom-webhook` 驱动
- JSON 状态落盘

### 暂未实现

- Telegram 告警推送
- 更细粒度的通知/恢复策略
- 多驱动联动编排

## 架构

### 1. 插件层

插件层负责：

- 周期性健康检查
- 失败阈值判断
- 切线决策
- 状态记录
- CLI 与 OpenClaw service 生命周期接入

### 2. 驱动层

驱动层负责：

- 列出可切换目标
- 读取当前目标
- 执行切换
- 返回驱动状态摘要

当前已有三个驱动：

- `mihomo`
- `custom-command`
- `custom-webhook`

## 驱动说明

### `mihomo`

适用于 Mihomo / Clash Meta 这一类带 controller API 的实现。

依赖能力：

- `external-controller`
- controller secret（可选）
- 代理组查询
- 代理组切换

配置示例：

```json5
{
  driver: {
    type: "mihomo",
    controllerUrl: "http://127.0.0.1:9090",
    secretEnv: "MIHOMO_CONTROLLER_SECRET",
    groupName: "专项代理"
  }
}
```

### `custom-command`

最通用的本地命令驱动。

你只要能用 shell 命令做到这三件事，就能接入：

- 列出目标
- 读当前目标
- 切到新目标

配置示例：

```json5
{
  driver: {
    type: "custom-command",
    shell: "/bin/bash",
    listCommand: "printf 'primary\\nbackup\\n'",
    currentCommand: "cat /path/to/current-target.txt",
    switchCommand: "/usr/local/bin/switch-line {{target}}",
    describeCommand: "/usr/local/bin/show-proxy-status",
    env: {
      PROFILE: "production"
    }
  }
}
```

注意：

- `switchCommand` 支持模板变量 `{{target}}` 与 `{{current}}`
- 这是高权限执行能力，只能给可信环境使用

### `custom-webhook`

适用于“代理控制能力不在本地命令，而在一个 HTTP 接口里”的场景。

这个驱动可以：

- 通过接口列出可切换目标
- 通过接口读取当前目标
- 通过接口执行切换
- 通过接口读取驱动状态摘要

适合：

- 远端主机上的代理管理服务
- 路由器或面板暴露的控制接口
- 你自己写的代理适配层服务
- 不希望插件直接执行本地 shell 的环境

配置示例：

```json5
{
  driver: {
    type: "custom-webhook",
    baseUrl: "https://proxy-control.example.invalid/api",
    timeoutMs: 15000,
    tokenEnv: "PROXY_CONTROL_TOKEN",
    tokenHeaderName: "Authorization",
    tokenPrefix: "Bearer ",
    headers: {
      "x-client": "openclaw-network-proxy-watchdog"
    },
    listRequest: {
      method: "GET",
      path: "/targets",
      resultPath: "data.targets"
    },
    currentRequest: {
      method: "GET",
      path: "/targets/current",
      resultPath: "data.current"
    },
    switchRequest: {
      method: "POST",
      path: "/targets/switch",
      body: "{\"target\":\"{{target}}\",\"current\":\"{{current}}\"}",
      fromPath: "data.from",
      toPath: "data.to",
      changedPath: "data.changed"
    },
    describeRequest: {
      method: "GET",
      path: "/describe",
      resultPath: "data"
    }
  }
}
```

请求模板支持：

- `{{target}}`
- `{{current}}`

可以使用在：

- `path`
- `body`
- 各请求的 `headers`

响应提取支持简单路径映射，例如：

- `data.targets`
- `data.current`
- `data.result.current`
- `items[0].name`

默认约定是：

- `listRequest` 读取字符串数组
- `currentRequest` 读取单个字符串
- `switchRequest` 默认仍以当前切换目标为准；若接口返回了 `from/to/changed`，则按映射覆盖
- `describeRequest` 可选；未配置时返回驱动自身摘要

## 健康检查说明

插件支持两种健康检查模式：

### `telegram-bot-api`

- 默认模式
- 自动读取宿主 OpenClaw 的 `channels.telegram.botToken`
- 通过 `https://api.telegram.org/bot<TOKEN>/getMe` 探测 Telegram Bot API
- 若返回 `401/404`，认为更像 token 配置问题，不触发切线

### `http`

- 你自己指定 URL
- 可配置请求方法与预期状态码
- 适合任何自定义健康检查地址

## 状态存储

插件状态存成一份 JSON：

- `failureCount`
- `lastProbeAt`
- `lastProbeSummary`
- `lastProbeOk`
- `lastSwitchAt`
- `lastSwitchFrom`
- `lastSwitchTo`
- `currentTarget`
- `lastError`

默认示例路径：

- `~/.local/state/openclaw-network-proxy-watchdog/state.json`

## 常用命令

### 查看状态

```bash
openclaw proxy-watchdog status
```

### 查看驱动详情

```bash
openclaw proxy-watchdog describe-driver
```

### 列出目标

```bash
openclaw proxy-watchdog list-targets
```

### 查看当前目标

```bash
openclaw proxy-watchdog current-target
```

### 手动切线

```bash
openclaw proxy-watchdog switch --target backup
```

### 立即跑一轮检测

```bash
openclaw proxy-watchdog run-once
```

### 插件烟测

```bash
openclaw proxy-watchdog self-test
```

## 配置示例

脱敏示例见：

- `config/plugin-config.example.json5:1`

## 文件结构

- `index.ts`：插件入口
- `openclaw.plugin.json`：插件声明与配置模式
- `src/config.ts`：配置归一化
- `src/service.ts`：健康检查与自动切线主循环
- `src/health-check.ts`：健康检查实现
- `src/driver-factory.ts`：驱动工厂
- `src/drivers/mihomo-driver.ts`：Mihomo 驱动
- `src/drivers/custom-command-driver.ts`：通用命令驱动
- `src/drivers/custom-webhook-driver.ts`：通用 Webhook 驱动
- `src/plugin-cli.ts`：CLI 命令注册
- `src/state-store.ts`：状态落盘
- `src/shell.ts`：shell 执行与模板替换

## 构建

```bash
npm install
npm run build
```

## 设计边界

这个插件负责：

- 检测
- 决策
- 切换
- 记录

这个插件不负责：

- 安装代理软件
- 发行第三方二进制
- 接管整个系统的网络栈
- 替你保存真实密钥和本机私有路径

别什么都往插件里塞，塞多了就又长成一坨运维泥石流。
