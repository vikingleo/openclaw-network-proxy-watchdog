# Changelog

## Unreleased

- 自动切线策略改为在 `mihomo + telegram-bot-api` 模式下优先选择 Telegram 可用且延迟最低的线路。
- `mihomo` 驱动新增候选线路 Telegram 延迟测试能力，并在失败时回退到顺序切线。
- Telegram 面板与 CLI 输出新增自动策略说明，统一展示当前选线策略。

## 0.4.0

- 将 Telegram 控制面板改为原地编辑模式，不再每次按钮点击都新发一条消息。
- 新增面板状态存储与面板实例 ID 路由。
- `/proxywd` 在 Telegram 中改为插件自发消息、自编辑消息。
- 保留管理员权限控制，按钮回调与文本命令继续统一受限。

## 0.3.0

- 新增 `/proxywd` 管理命令，提供交互式按钮面板。
- 插件文本命令与按钮回调统一走管理员权限控制。
- 新增 `commandAccess.adminSenderIds` 配置项。
- 补充 Telegram 交互式控制说明、运行配置模板与 webhook 适配示例。

## 0.2.0

- 新增 `custom-webhook` 驱动。
- 支持通过 HTTP 接口列出目标、读取当前线路、执行切换、读取驱动摘要。
- 支持请求头、鉴权令牌、请求体模板与响应路径映射。
- 更新插件文档与脱敏配置示例。

## 0.1.0

- 初始化标准 OpenClaw 网络代理看门狗插件。
- 实现可插拔驱动架构。
- 实现 `mihomo` 驱动与 `custom-command` 驱动。
- 实现健康检查、失败阈值判断、自动切线与状态落盘。
