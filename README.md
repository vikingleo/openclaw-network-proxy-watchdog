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
- Telegram 原地编辑控制面板
- 插件文本命令与按钮回调统一权限控制
- 健康检查主循环
- 连续失败计数
- 失败到阈值后自动切线
- `mihomo + telegram-bot-api` 模式下优先选择 Telegram 可用且延迟最低的线路
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
- 交互式管理命令

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

## Telegram 交互控制

插件新增管理员命令：

```bash
/proxywd
```

该命令会打开一个单独的控制面板消息，后续按钮操作会直接原地编辑这张面板，支持：

- 查看概览
- 查看当前线路
- 查看驱动摘要
- 打开切线面板
- 立即执行一轮巡检
- 通过按钮直接切线
- 返回上一级面板而不刷屏

在 `mihomo + telegram-bot-api` 模式下，面板会明确展示当前自动策略为“Telegram 可用且最低延迟优先”；
手动按钮切线依旧可用，但不会改变自动巡检时的选线策略。

### 权限模型

插件命令遵循两层控制：

1. **平台授权**：调用者必须先通过 OpenClaw 命令授权检查。
2. **插件管理员**：调用者还必须命中 `commandAccess.adminSenderIds`。

也就是说：

- 文本命令只能管理员执行
- Telegram 按钮回调同样只能管理员执行
- 面板本身由插件直接调用 Telegram API 发送与编辑，不再依赖普通回复消息

如果 `commandAccess.adminSenderIds` 为空，插件会退回到平台已有授权结果。

### 推荐配置

```json5
{
  commandAccess: {
    adminSenderIds: [
      "telegram:YOUR_USER_ID",
      "vocechat:user:YOUR_USER_ID"
    ]
  }
}
```

## 驱动说明

### `mihomo`

适用于 Mihomo / Clash Meta 这一类带 controller API 的实现。

依赖能力：

- `external-controller`
- controller secret（可选）
- 代理组查询
- 代理组切换
- 单节点延迟测试 API（用于自动挑选 Telegram 延迟最低的可用线路）

自动切线策略：

- 当 `healthCheck.kind = telegram-bot-api` 且驱动为 `mihomo` 时，达到失败阈值后会对候选线路做 Telegram 连通性/延迟测试
- 只在“Telegram 可用”的候选里排序，并优先切到延迟最低的那条
- `switchPolicy.candidates` 不为空时，只会在这些候选里选；为空时则在驱动返回的全部目标里选
- 若延迟测试不可用或全部失败，则回退到原来的顺序切线策略

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

## 健康检查说明

插件支持两种健康检查模式：

### `telegram-bot-api`

- 默认模式
- 自动读取宿主 OpenClaw 的 `channels.telegram.botToken`
- 通过 `https://api.telegram.org/bot<TOKEN>/getMe` 探测 Telegram Bot API
- 若返回 `401/404`，认为更像 token 配置问题，不触发切线
- 在 `mihomo` 驱动下，自动切线时也会复用这个 Telegram 目标地址做候选线路延迟测试

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

### 聊天控制台

在 Telegram 中，`/proxywd` 会创建一张独立面板；后续按钮点击会原地更新，不再反复新增消息。


```bash
/proxywd
/proxywd status
/proxywd current
/proxywd driver
/proxywd switch-menu
/proxywd run-once
/proxywd switch 2
```

### CLI 查看状态

```bash
openclaw proxy-watchdog status
```

### CLI 查看驱动详情

```bash
openclaw proxy-watchdog describe-driver
```

### CLI 列出目标

```bash
openclaw proxy-watchdog list-targets
```

### CLI 查看当前目标

```bash
openclaw proxy-watchdog current-target
```

### CLI 手动切线

```bash
openclaw proxy-watchdog switch --target backup
```

### CLI 立即跑一轮检测

```bash
openclaw proxy-watchdog run-once
```

### CLI 插件烟测

```bash
openclaw proxy-watchdog self-test
```

## 配置示例

脱敏示例见：

- `config/plugin-config.example.json5:1`
- `config/plugin-config.custom-webhook.example.json5:1`
- `config/runtime-templates/openclaw-entry.mihomo.example.json:1`
- `config/runtime-templates/openclaw-entry.custom-webhook.example.json:1`

## Webhook 适配示例

仓库内附带了一个可直接运行的演示适配器：

- `examples/custom-webhook-adapter-demo.mjs:1`

启动示例：

```bash
DEMO_TOKEN=demo-token node examples/custom-webhook-adapter-demo.mjs
```

然后把插件配置指向：

- `baseUrl = http://127.0.0.1:18795/api`
- `tokenEnv = PROXY_CONTROL_TOKEN`

如果只是想切换当前运行配置，不建议直接覆盖在线配置；更稳的方式是先参考：

- `config/runtime-templates/openclaw-entry.custom-webhook.example.json:1`

把其中的 `network-proxy-watchdog` 条目合并进 `openclaw.json`，再重启网关验证。

## 文件结构

- `index.ts`：插件入口
- `openclaw.plugin.json`：插件声明与配置模式
- `src/config.ts`：配置归一化
- `src/chat-commands.ts`：聊天命令与按钮交互
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

## 一键安装

仓库内附带一套一键安装脚本：

- `scripts/bootstrap.sh:1`
- `scripts/install.sh:1`
- `scripts/install.mjs:1`

远程一条命令示例：

```bash
curl -fsSL https://raw.githubusercontent.com/vikingleo/openclaw-network-proxy-watchdog/master/scripts/bootstrap.sh | bash -s -- \
  --openclaw-dir /path/to/openclaw \
  --driver mihomo \
  --controller-url http://127.0.0.1:9090 \
  --group-name 专项代理 \
  --candidate 香港A \
  --candidate 日本B \
  --admin-sender telegram:YOUR_USER_ID
```

`bootstrap.sh` 会先执行 `git clone`/`git fetch`，再调用本地 `install.sh`。

脚本会执行这些动作：

- 先检查目标宿主目录下的 `.openclaw/extensions` 是否存在
- 自动识别当前属于 `fresh-install`、`upgrade`、`repair` 还是 `no-op`
- 默认以软链接方式安装到 `.openclaw/extensions/network-proxy-watchdog`
- 若发现已有安装、软链接错误、目录类型不符或配置漂移，会先创建可恢复备份，再只修复有问题的部分
- 将插件配置写入或覆盖到 `openclaw.json` 的 `network-proxy-watchdog` 条目
- 在备份目录里生成 `restore.sh` 回滚脚本
- 默认自动执行 `npm install` 与 `npm run build`，也可用 `--skip-build` 跳过
- 如果状态已经正确，默认不重复安装；如需强制重走，可追加 `--force`

默认备份目录：

- `<OPENCLAW_DIR>/.openclaw/backups/network-proxy-watchdog/<timestamp>/`

Mihomo 一键安装示例：

```bash
./scripts/install.sh \
  --openclaw-dir /path/to/openclaw \
  --driver mihomo \
  --controller-url http://127.0.0.1:9090 \
  --group-name 专项代理 \
  --candidate 香港A \
  --candidate 日本B \
  --admin-sender telegram:YOUR_USER_ID
```

Custom Webhook 一键安装示例：

```bash
./scripts/install.sh \
  --openclaw-dir /path/to/openclaw \
  --driver custom-webhook \
  --base-url http://127.0.0.1:18795/api \
  --admin-sender telegram:YOUR_USER_ID
```

远程 bootstrap 默认使用 HTTPS clone；如果你明确要走 SSH，可额外传入：

```bash
--ssh
```

如需固定到某个 tag / 分支 / commit，可额外传入：

```bash
--ref v0.5.0
```

如需复制安装而不是软链接，可额外传入：

```bash
--copy
```

如需回滚，直接执行安装输出里的：

- `<backup-dir>/restore.sh`

## 设计边界

这个插件负责：

- 检测
- 决策
- 切换
- 记录
- 提供管理员控制面板

这个插件不负责：

- 安装代理软件
- 发行第三方二进制
- 接管整个系统的网络栈
- 替你保存真实密钥和本机私有路径

别什么都往插件里塞，塞多了就又长成一坨运维泥石流。
