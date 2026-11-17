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
   │                     ├─ exec：把 export PATH 塞进 `sh -lc` 脚本体（见下），
   │                     │        垫片 `dsh` 只拦 desktop
   │                     │        └─ 打印 `dsh web: http://127.0.0.1:<外壳端口>/?token=<票>`
   │                     └─ direct-tcpip：只放行 127.0.0.1:<外壳端口>
   └──把 127.0.0.1:<外壳端口> 转发到自己──▶ 「dsh web 外壳」（密码门 + token 注入）
                                            └──▶ 桌面版 WebServer :58920
```

### 握手契约（照抄 DSH Go 的实现，别自己发明）

DSH Go 的 `DshClient.login()`（dsh-go `packages/dsh_client/lib/src/connection.dart:312-336`）是：

1. `GET /?token=<launch token>`，**不跟随重定向**；
2. 401 → 直接报「launch token rejected」；
3. 必须是 **302/303**，且响应里有名为 `dsh-auth-…` 的 `set-cookie`，否则报
   `DshProtocolException: login redirect carried no dsh-auth cookie`；
4. 之后用该 cookie `GET /`（同样不跟随重定向），期望 200。

所以外壳**只能**把票换成真 token 转发、把桌面版的 303 与 `set-cookie` 原样送回；
一旦外壳自己回 302/303（密码门那套就是这么干的），客户端拿不到 dsh-auth 就判死。
真机第二次报错正是这个原因，已按此改。

### 「dsh web 外壳」而不是直接把钥匙递出去

外壳就是一个 `createGateServer` 实例：DSH Go 拿 `/?token=<票>` 来换 cookie（这正是 `dsh web`
自己的首访形态，所以它认得），外壳放行后转发给桌面版并**注入桌面版真正的 launch token**。
手机侧拿到的只是一张外壳票，真 token 不出插件进程 —— 与 ds-harness-remote 那种「中继」一致，
而不是把桌面版的钥匙抄给手机。票据在模式开启期间固定（便于复用），插件重启即换新。

### 真机踩坑：登录 shell 会重建 PATH

第一次真机验收报 `error: profile "desktop" is managed exclusively by the Electron application`。
原因是 DSH Go 用 `sh -lc '<脚本>'` 执行，login shell 会读 `/etc/profile` → `path_helper` 把我们
注入进程环境的 PATH **整个重建**（实测 `PATH=/tmp/shim:$PATH /bin/sh -lc 'echo $PATH'` 前缀被丢）。
因此 PATH 必须写进 `-c` 的**脚本体**（profile 之后执行），由 `withShimPath()` 完成；
只在 spawn 的 env 里 prepend 是无效的。

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
- 桌面版 launch token 经 `DSH_ATTACH_LINE` 环境变量传进会话，不写文件、不进 state.json；
  手机侧只拿外壳票，真 token 只在插件进程与转发请求里存在。
- 垫片打印完启动行即退出（不保活）：保活会让客户端在插件重启后拿着已失效的旧端口/票反复重连。

## 接口

- `POST /ssh-host/api/ssh/dsh-go` `{enabled: true|false}` → `{ok, enabled, port, error}`
- `GET /ssh-host/api/ssh/state` 新增 `dshGo {enabled, running, port, attachedAt, attachCount}`
  —— `attachCount` 只在**真的收到 desktop 启动请求**时增长，红绿灯以它为准。
- `state.json` 记录 `dshGo`（重启后保持用户选择）。
