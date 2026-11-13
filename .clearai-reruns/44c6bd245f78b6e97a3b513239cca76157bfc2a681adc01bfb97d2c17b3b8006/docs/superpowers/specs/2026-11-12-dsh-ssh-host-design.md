# dsh-ssh-host 设计:基于 dsh-sakurafrp 的 SSH 主机插件

- 日期:2026-11-12(重写;原「纯完善上游」设计并入为阶段一)
- 工作副本:`/Users/mac/Project/dsh-ssh-host`
- 上游:`https://github.com/MentholTea/dsh-sakurafrp`(2.4.0,master)
- 目标:**本机作为 SSH 主机,远方手机用 SSH 客户端经公网隧道控制本机**

## 已确认的三个决策

1. **形态:标准 SSH** —— 手机装任意 SSH 客户端(Termius 等),连 SakuraFrp 公网隧道地址;
   不做内置 Web 终端(避免 node-pty 原生编译风险)。
2. **服务端:系统自带 sshd**(macOS「远程登录」)—— 插件负责检测、引导、密钥、隧道;
   不内嵌 ssh2 服务端。
3. **认证:密钥为主** —— 插件生成专用 ed25519 密钥对,公钥写入 `~/.ssh/authorized_keys`,
   私钥导出给手机导入;系统密码登录作为 sshd 自带行为保留,插件不引导。

## 流量路径(SSH 与 DSH 两条隧道并存)

```
手机 SSH 客户端 → <节点host>:<remote_port>(SSH 隧道,SakuraFrp TCP)
                → frpc(本插件托管,NATFRP_TARGET="dshId,sshId" 逗号多值)
                → 127.0.0.1:22(sshd)          ← SSH 流量不经过插件网关
手机/浏览器     → DSH 隧道 → 网关(密码门) → 127.0.0.1:<dshPort>  ← 现有功能原样保留
```

关键点:SSH 隧道是纯 TCP 直连 sshd,**不经过 HTTP 网关与密码门**——SSH 协议自带认证,
且现有 autoAlign/adoptTunnelPort/网关重启逻辑只作用于 DSH 隧道,互不干扰。

## 阶段一:地基(沿用已批准的上游同步方案)

1. git 基础设施已完成(init + origin + `.git/info/exclude` 排除 `clear/`)。
2. `git fetch origin master` → 检出 2.4.0 全部文件 → commit。
3. `npm test` 建 700 项基线(25 套件,离线),全绿才进入阶段二。
4. 顺手修复上游 2.4.0 仍存在的两个缺陷(作为新插件的起点质量):
   - `natfrp.mjs:9` UA 硬编码 2.2.0 → `createClient(token, { version })`,
     `index.js` 传入现读的 `PLUGIN_VERSION`;
   - `index.js:843` Windows 无 `uid` → 提取纯函数 `ownerNoteFor(stat)`,
     `Number.isFinite` 才拼属主注记。
   - 各配新断言。

## 阶段二:SSH 主机能力(新插件的核心)

### 宿主半侧:新模块 `ssh.mjs`

| 函数 | 职责 |
|---|---|
| `checkSshd()` | TCP connect 探测 `127.0.0.1:22`(只看事实,跨平台;不依赖 root 权限的系统设置查询) |
| `generateHostKey()` | `node:crypto` `generateKeyPairSync('ed25519')`;导出 OpenSSH authorized_keys 单行公钥 + PEM 私钥 |
| `installPublicKey(pubKey)` | 幂等追加到 `~/.ssh/authorized_keys`(按注释标记 `dsh-ssh-host` 去重);目录 0700、文件 0600(sshd StrictModes 硬要求) |
| `fingerprintOf(pubKey)` | SHA256 指纹,界面展示比对用 |
| `buildConnectCommand(user, host, port)` | `ssh <user>@<host> -p <port>`;`user` 取 `os.userInfo().username`(宿主进程运行用户 = sshd 的合法登录用户) |

- 私钥落 `DATA_DIR/ssh-host-key`(0600),**永不进 state.json**(与 gatePassword 同纪律)。
- `~/.ssh/authorized_keys` 是用户目录操作,无需 sudo;写入失败给出与 diagnoseWriteFailure
  同风格的诊断。

### `index.js` 改动

- 新增状态:`sshTunnelId`(state.json)、`hostKey`(内存缓存,读盘)。
- `frpc.start` 的 `NATFRP_TARGET` 从 `[tunnelId]` 变为去重后的 `[tunnelId, sshTunnelId]`
  (frpc 支持逗号多值;`frpc.mjs` 现有 join(',') 语义不变)。
- SSH 隧道的 `local_port` 恒为 22:不参与 autoAlign/adoptTunnelPort;创建时若 sshd 未在听,
  直接拒绝并提示先开「远程登录」。
- 新管理路由(挂在现有鉴权模型:本机直连免密,公网过密码门):
  - `GET  /natfrp/api/ssh/state` — sshdUp / key 指纹 / sshTunnelId / 隧道 online /
    remotePort / nodeHost / connectCmd
  - `POST /natfrp/api/ssh/key/create` — 生成密钥对 + 写 authorized_keys
  - `GET  /natfrp/api/ssh/key/private` — 返回私钥文本(界面复制给手机导入)
  - `POST /natfrp/api/ssh/tunnel/create` — 建 TCP 隧道(local_ip=127.0.0.1,
    local_port=22,remote 交官方分配)并落 `sshTunnelId`
  - `POST /natfrp/api/ssh/tunnel/remove` — 删除 SSH 隧道(复用 2.4.0 的 tunnelDelete
    语义:deleted 才算成功,failed 时停 frpc)
- **信任边界说明**:私钥经 API 返回给「已过密码门或本机」的请求者。这个边界不扩大
  攻击面——能过密码门者已拥有 DSH 全部控制权(含 AI 执行命令能力),SSH 私钥不新增
  越权路径。

### 客户端半侧:`client.js` 新增「SSH 远程访问」区块

位置:设置页/主面板的 DSH 连接设置之后。内容:

1. **就绪四态提示**(渐进解锁,与现有四步风格一致):
   sshd 未开(给 macOS「系统设置 → 通用 → 共享 → 远程登录」指引 + 重新检测按钮)
   → 未生成密钥(一键生成)→ 未建 SSH 隧道(一键建)→ 就绪(显示连接命令 + 公网地址)。
2. **连接信息卡**:`ssh <user>@<nodeHost> -p <remotePort>` 一键复制;私钥「查看/复制」
   折叠区(默认折叠,点击展开,提示导入 Termius 的方式)。
3. **密钥指纹**展示(手机端导入后可比对)。
4. 不改侧边栏三色状态点的现有语义(第一期 SSH 状态只在面板内;避免过度设计)。

### 平台边界

- 第一阶段仅 macOS(`systemsetup`/远程登录开启需用户手动或 sudo,插件只引导)。
- Windows(OpenSSH Server 可选功能)列为后续;`checkSshd()` 本身跨平台,先到先用。

## 阶段三:收尾

- 版本号:fork 起点,建议 `0.1.0`(开放问题,见下)。
- README 重写:dsh-ssh-host 定位、SSH 使用四步、与上游的关系声明(基于 dsh-sakurafrp 2.4.0)。
- 全量回归 + 新增 SSH 套件全绿 → 提交 → 推送(推送目标见开放问题)。

## 已定案的开放问题

1. **包名策略**(2026-11-12 定):`package.json` name 改为 `dsh-ssh-host`;连带
   client.js module id、cordis.patch.yml id/name、DATA_DIR、UA、插件路由前缀等改名,
   测试断言同步更新。推荐已获批准。
2. **推送目标**(2026-11-12 定):`git@github.com:harde1/dsh-ssh-host.git`;
   origin 语义调整:上游仓库另设 remote `upstream`(拉取上游更新用),`origin`
   指向用户自己的仓库,推送推 origin/master。

## 错误处理与回滚

- 阶段一基线不绿不进阶段二;每步可 `git reset` 回滚;无不可逆操作。
- authorized_keys 只追加不删改用户已有条目;幂等标记防重复。
- 私钥生成失败不落半成品(先写内存、后落盘,落盘失败即丢弃)。

## 测试

- 阶段一:700 项基线 + 2 个修复的新断言。
- 阶段二新增套件 `test/ssh-host-test.mjs`(离线,不连官方 API):
  密钥生成/authorized_keys 格式与幂等/权限位、sshd 探测(mock socket)、
  NATFRP_TARGET 多隧道拼接、connectCmd 拼装、SSH 隧道创建的 local_port 恒 22 校验、
  sshd 未开时创建被拒。
- 完成态:全部套件绿 + `git status` 干净 + 连接命令手工 smoke(可选,真机)。
