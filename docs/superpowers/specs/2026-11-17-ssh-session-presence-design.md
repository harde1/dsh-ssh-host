# SSH 会话观测（红绿灯）设计

日期：2026-11-17 · 状态：已批准（用户选定方案 A）

## 目标

面板上用一个红绿灯回答「现在有没有 SSH 客户端连着这台 Mac」，不发请求、不弹提示、
不需要复制任何字符串。

## 不做（边界）

- **不做命令级监听**。插件不在 SSH 明文路径上：建隧道时 `local_port` 写死 `SSHD_PORT`
  （`index.js:1795`），SSH 是 TCP 直通 22，不经插件网关（`index.js:514`、`README.md:109-111`）。
  因此插件**取不到**「这条会话跑了 `dsh desktop`」这种信息，更不可能让
  `dsh desktop` 起效；那需要插件自己当 SSH 服务端（独立议题，见对话记录方案 B）。
- 不改 DSH 源码、不改只读系统路径、不写用户 shell profile。
- 不新增前端轮询：复用现有 8s 的 `/ssh-host/api/ssh/state`。

## 数据来源

内核套接字表：`netstat` 里 22 端口上的 `ESTABLISHED` 连接数（服务端那一行；同一会话的
客户端侧一行不计）。macOS 用 `-an -p tcp`，Linux 用 `-an -t`；地址形态同时兼容
`127.0.0.1.22`（BSD）与 `127.0.0.1:22`（Linux）。`sshd` 把探测连接立刻关掉，所以插件
自己的存活探测不会长期贡献 ESTABLISHED，不会把灯点成假的绿。

## 状态

| 灯 | 条件 | 文案 |
| --- | --- | --- |
| 灰 | 通道没开 / frpc 没跑（不采样） | 未观测 |
| 黄 | 采样成功，0 条会话 | 暂无 SSH 会话 |
| 绿 | 采样成功，≥1 条会话 | SSH 已连入 · N 路 |
| 红不用 | 采样失败只降级为「未观测」，绝不报成故障 | — |

理由：一次 `netstat` 失败（PATH 缺、超时）说明「我们看不见」，不是「SSH 坏了」；
把看不见报成红色是撒谎（与 `panelVisible()` fail-open 同一条纪律）。

## 接口

`GET /ssh-host/api/ssh/state` 新增字段：

```json
"remoteSession": { "active": true, "count": 1, "ok": true, "observedAt": 1730000000000 }
```

采样缓存 TTL 8s（与前端轮询同拍），`enabled && frpc.running` 为假时一次都不采样。

## 测试（全离线）

`ssh.mjs` 暴露 `parseEstablishedSessions(text, port)` 纯函数与
`setSshSessionProberForTests(fn)` 注入点；断言覆盖：BSD/Linux 两种地址格式、LISTEN 排除、
同会话的客户端行不重复计数、非 22 端口不计数、空输入为 0、失败降级 `ok:false`。
路由断言进 `test/ssh-host-test.mjs`（复用其宿主 ctx 桩）。
