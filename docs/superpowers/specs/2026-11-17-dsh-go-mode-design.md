# 对接 DSH Go 模式（开关）设计

日期：2026-11-17 · 状态：已批准（用户：开关控制，开=能对接 DSH Go，关=纯 SSH 主机）

## 目标

面板上一个开关。开启后，DSH Go 的「SSH 主机 → 启动命令」填 `dsh desktop` 即可连上
**正在运行的桌面版**；关闭后隧道恢复直连 22，系统 sshd 原样服务 —— 那是纯粹的 SSH 主机。

## 为什么必须由插件当 SSH 入口

DSH 的 `desktop` profile 由 Electron 独占（`dsh --profile desktop` 直接报
"managed exclusively by the Electron application"），CLI 起不来；而 `dsh desktop` 这个
命令原本到不了插件手里 —— SSH 隧道 `local_port=22` 直通系统 sshd（`index.js:1795`），
插件既不在线路上也不解析明文。所以「收到 `dsh desktop`」的前提是：**这条隧道指向插件**。

## 链路（开启时）

```
DSH Go ──SSH 隧道──▶ 插件 SSH 前端（127.0.0.1:<前端端口>）
   │                     ├─ 认证：只用插件那把 ed25519 公钥
   │                     ├─ exec：PATH 前置垫片目录，`dsh` 垫片只拦 desktop
   │                     │        └─ 打印 `dsh web: http://127.0.0.1:<DSH端口>/?token=…`
   │                     │           （真 token，经环境变量传，不落盘）
   │                     └─ direct-tcpip：只放行 127.0.0.1:<DSH端口>
   └──把 127.0.0.1:<DSH端口> 转发到自己──▶ 桌面版 WebServer
```

关闭时：停前端 → 隧道 `local_port` 改回 22 → 重启 frpc。

## 取舍（写进面板文案）

- 开启期间 **Termius 连这条隧道会被前端拒绝**（前端只服务 DSH Go 的 exec 与
  direct-tcpip；交互 shell 会明确回一句「请连原来的 SSH 隧道（端口 22）」）。
- 这是模式切换而不是叠加：一条隧道只能有一个 `local_port`。要同时在线，就同时开两条隧道
  （本版本不做，属后续可选项）。

## 安全边界

- 前端只绑 `127.0.0.1`；host key 每次启动在内存生成，不落盘。
- 认证只接受插件那把公钥（逐字节比 32 字节原始公钥），不引入第二套凭据。
- `direct-tcpip` 只放行回环 + DSH 端口，其余一律 `reject`（前端不是跳板机）。
- 桌面版 launch token 经 `DSH_ATTACH_LINE` 环境变量传进会话，不写文件、不进 state.json。

## 接口

- `POST /ssh-host/api/ssh/dsh-go` `{enabled: true|false}` → `{ok, enabled, port, error}`
- `GET /ssh-host/api/ssh/state` 新增 `dshGo {enabled, running, port, attachedAt, attachCount}`
  —— `attachCount` 只在**真的收到 desktop 启动请求**时增长，红绿灯以它为准。
- `state.json` 记录 `dshGo`（重启后保持用户选择）。
