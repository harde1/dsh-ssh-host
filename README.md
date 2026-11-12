# dsh-ssh-host

[![CI](https://github.com/harde1/dsh-ssh-host/actions/workflows/ci.yml/badge.svg)](https://github.com/harde1/dsh-ssh-host/actions/workflows/ci.yml)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

**本机作为 SSH 主机,远方手机用 SSH 客户端(Termius 等)经公网隧道控制本机。**
基于 [MentholTea/dsh-sakurafrp](https://github.com/MentholTea/dsh-sakurafrp) 2.4.0 fork,
同时完整保留 DSH 界面的公网穿透与密码门——frpc 全托管、隧道面板、流量面板、
Host 围栏反代、DSH 二次认证等上游能力原样可用(相关说明见文末保留章节)。

> [!WARNING]
> **本插件是「与 AI 对话协作」的产物。** 代码与文档由作者与 AI(DeepSeek Harness 会话)
> 多轮对话生成并反复迭代而来,**没有经过人工逐行审计**,实测环境也仅限于作者本机的
> macOS。请自行审阅源码后再使用;涉及安全敏感场景时请格外谨慎。
> 代码按 MIT「按原样(AS IS)」提供,不附带任何担保,风险自负。
>
> 与「AI 生成即不可靠」无关的部分:**测试是可复核的**。`npm test` 是 26 个套件、807 项
> 全离线的断言(不连 SakuraFrp、不需要访问密钥、不写任何用户目录),其中
> `admin-auth-test.mjs` 专门覆盖网关鉴权(7 种路径花招、WS 同权、改密后旧 cookie 失效),
> `ssh-host-test.mjs` 覆盖 SSH 主机能力与路由(92 项)。数字与结论都能自己跑一遍验证,
> 不必只信这段说明。

---

## 快速开始(四步,约 5 分钟)

前提:一个 SakuraFrp 账号(SSH 隧道和 DSH 隧道一样,都建在 SakuraFrp 上),
并且已在面板 **① 访问密钥** 里配好访问密钥——没有它,创建 SSH 隧道会被拒(400 no-token)。

设置页入口:**设置 → SSH 主机**;侧边栏入口:「SSH 主机」,带三色状态点(🟢🟡🔴)
和一键启停开关。

**1. 装插件**(包名是 `dsh-ssh-host`,不是上游的 `dsh-sakurafrp`)

```bash
dsh plugin --profile desktop add dsh-ssh-host -w
# web / CLI 场景把 --profile 换成你的 profile 名,例如 --profile web
```

重启 DSH。若设置页提示未装 frpc,点一次「一键安装」——插件会按平台/架构自动下载到
`~/.dsh/dsh-ssh-host/frpc-standalone`。

> 首次发布尚未推上 npm 时,可先从源码装:clone 本仓库,把 profile 的
> `dependencies` 指向克隆目录(`"dsh-ssh-host": "link:<克隆目录绝对路径>"`),
> 并把 `"dsh-ssh-host"` 加进 `dsh.profile.bundles`,再 `dsh plugin --profile desktop install`。

**2. 开「远程登录」**

macOS:系统设置 → 通用 → 共享 → **远程登录**,打开。面板每 ≤8 秒真探测一次
`127.0.0.1:22`;没开时 SSH 区块会给出「打开系统设置」深链,点它直达共享面板。

**3. 面板点「生成 SSH 密钥」**

生成一把专用于 SSH 连入的 ed25519 密钥:公钥写进本机 `~/.ssh/authorized_keys`
(带 `dsh-ssh-host` 标记行),私钥落到 `~/.dsh/dsh-ssh-host/ssh-host-key`(0600)。
面板显示 SHA256 指纹,手机端导入私钥后可比对这串指纹。

**4. 面板点「创建 SSH 隧道」→ 手机 Termius 导入私钥 → 连接**

创建的是一条 TCP 隧道:`local_port=22` 直连本机 sshd,远程端口由官方分配,节点复用
当前 DSH 隧道的节点(也可显式传)。创建后 frpc 自动重连,带上这条新隧道。就绪态面板
会显示连接命令 `ssh <user>@<节点host> -p <远程端口>`。

手机端:Termius → Keychain → + → Import,把面板「查看私钥(导入手机)」里整段
(含 BEGIN/END 行)粘贴保存,主机认证选这把钥匙,连上面那条命令即可。

> 四步在界面上是**逐步解锁**的:非 macOS → sshd 未开 → 未生成密钥 → 未建 SSH 隧道 → 就绪,
> 上一步没到位,下一步不出现。重新生成密钥后必须重新导入私钥(见「安全说明」)。

**附:DSH 界面公网穿透的首次使用**(继承上游,同样逐步解锁):
① 访问密钥——SakuraFrp 面板 → 用户信息 → 查看访问密钥,粘贴进设置页保存;
② 隧道——下拉选一条已有的,一条都没有就点「新建」(选节点、填端口,远程端口官方分配);
③ 本机端口——新装是空的,必须自己填,填完立刻检测能不能用;
④ 访问密码——强烈建议 20 位以上随机串,未设密码时外网一律拒绝。
最后打开顶部开关,手机访问隧道公网地址 → 输密码 → 完整 DSH 界面。
frpc 日志默认展开,并且每 2 秒刷新一次,不用收起再展开才看到新内容。

---

## 架构(两条隧道并存)

```
手机 SSH 客户端 → <节点host>:<远程端口>(SSH 隧道,SakuraFrp TCP)
                → frpc(本插件托管,NATFRP_TARGET="dshId,sshId" 单进程双隧道)
                → 127.0.0.1:22 sshd                  ← SSH 流量不经过插件网关
手机 / 浏览器   → DSH 隧道 → 网关(密码门,HMAC cookie)
                → 127.0.0.1:<dshPort> DSH WebServer  ← DSH 界面公网穿透,原样保留
```

两条隧道由**同一个 frpc 进程**承载(环境变量 `NATFRP_TARGET` 逗号多值),DSH 关闭 =
frpc 退出 = 两条隧道同时断开。SSH 隧道是纯 TCP 直连 sshd,不经过 HTTP 网关与密码门
——SSH 协议自带认证;现有 autoAlign / 端口同步 / 网关逻辑只作用于 DSH 隧道,互不干扰。

---

## 配置(cordis.patch.yml → config)

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `false` | 插件启用(设置页可改,持久化到 state.json)。新装默认关闭,避免装完就把 DSH 挂上公网 |
| `frpcPath` | `~/.dsh/dsh-ssh-host/frpc-standalone(.exe)` | frpc 路径(旧 `~/.dsh/bin/` 下的也会被沿用) |
| `tunnelId` | — | DSH 隧道 ID(设置页下拉选择后持久化) |
| `tokenFile` | — | 访问密钥文件(优先级最高;设置页写密钥即写此文件) |
| `tokenRef` | `NATFRP_TOKEN` | tokenFile 为空时走 DSH credentials |
| `gatePort` | — | 网关端口 = DSH 隧道的「本地端口」。留空 = 未设置,网关不监听、frpc 不启动 |
| `gateHost` | `127.0.0.1` | 网关监听地址。frpc 同机时无需对外监听;改成 `0.0.0.0` 会给局域网开一条绕过密码门的入口 |
| `gatePassword` | — | 公网密码;也可用设置页写(落 `~/.dsh/dsh-ssh-host/gate-password.txt`,**不写入 state.json**) |
| `autoAlign` | `true` | 启动前自动把 DSH 隧道「本地端口」改成 `gatePort` |
| `maxLogLines` | `500` | 日志环形缓冲行数 |

**SSH 部分没有新的 config 键**:SSH 隧道状态全部落在 `~/.dsh/dsh-ssh-host/state.json` 的
`sshTunnelId`(创建/删除隧道时由插件维护);SSH 私钥不进 state.json(见「安全说明」)。
历史数据目录会自动迁移:`dsh-natfrp` / `dsh-sakurafrp` → `dsh-ssh-host`(复制不搬走,
旧包不受影响)。

---

## 管理接口(需密码门 cookie)

```
GET  /ssh-host/api/state     全量快照(frpc + 网关 + 隧道)
GET  /ssh-host/api/tunnels   隧道列表(含节点名)
GET  /ssh-host/api/nodes     免费节点(含负载 / 是否可新建;离线、付费已剔除)
GET  /ssh-host/api/port/check?port=N  端口可用性(available / reason)
GET  /ssh-host/api/user      账号信息
GET  /ssh-host/api/logs      frpc 日志
POST /ssh-host/api/start     启用并启动
POST /ssh-host/api/stop      停止
POST /ssh-host/api/align     把 DSH 隧道「本地端口」改成插件正在用的端口
POST /ssh-host/api/tunnel/create  新建一条 TCP 隧道 {name,node,port},本地端口指向插件
POST /ssh-host/api/tunnel/delete  删除一条隧道 {id};删的是当前隧道时会停 frpc 并关闭开关
                                 官方返回的 failed 表示「已删除但没踢下线」,不是删除失败
POST /ssh-host/api/config    更新配置 {enabled,tunnelId,gatePort,gatePassword,token,clearGatePassword}
                             gatePort 传 null / '' = 清空端口(网关随之停止)
GET  /ssh-host/api/frpc/check        本地 frpc 是否存在 / 版本是否合规(不下载)
GET  /ssh-host/api/frpc/update-check 手动对比本地与官方最新版号(无自动检查)
                             结论带 updateAvailable / current / latest;
                             60s 内重复请求带 throttled + retryAfter,不静默复用缓存
POST /ssh-host/api/frpc/install      一键下载安装 / 替换为新版(运行中会先停、完成自动恢复)
POST /ssh-host/api/frpc/dismiss      忽略当前 frpc 提示(按问题类型 + 路径记忆)
POST /ssh-host/api/frpc/undismiss    恢复被忽略的提示
POST /ssh-host/api/frpc/ack-result   确认安装结果提示(落盘,跨会话不再弹)
```

**版本更新是纯手动的**:插件不会在启动、轮询或任何后台时机去查官方清单,
只有用户在面板顶部点「检查更新」才发一次请求;60 秒内重复点击会被节流并提示
「别按太频繁,N 秒后再查」。确认有新版本后,再点「更新到 X」才真正下载替换。

**SSH 主机路由(5 条)**:

```
GET  /ssh-host/api/ssh/state
     快照:sshdUp(真 TCP 探测 127.0.0.1:22)/ key {fingerprint,hasPrivate} /
     sshTunnelId / tunnel {id,online,remote,nodeHost,node} / user / connectCmd
     (隧道上线后给出 `ssh <user>@<节点host> -p <远程端口>`,否则 null)

POST /ssh-host/api/ssh/key/create
     生成专用 ed25519 密钥对:私钥/公钥落 ~/.dsh/dsh-ssh-host/(0600),
     公钥 upsert 进 ~/.ssh/authorized_keys。
     200 {ok, action, file, fingerprint},action 三态:
       created   首次写入 / unchanged 同一把公钥已在 / replaced 重新生成,旧标记行被替换
     失败 500 {error:'ssh-key-failed', message}

GET  /ssh-host/api/ssh/key/private
     200 {privateKey, publicKey, fingerprint}(界面「查看私钥(导入手机)」用)。
     还没生成密钥时 404 {error:'no-key'}

POST /ssh-host/api/ssh/tunnel/create
     body {name?, node?}:name 默认 'SSH'(截 24 字);节点显式传 > 复用当前 DSH 隧道的节点。
     隧道固定 TCP、local_ip=127.0.0.1、local_port=22,远程端口官方分配;成功后 sshTunnelId
     落 state.json,总开关开着时自动重启 frpc。
     200 {ok, id, remote, warning}
     错误:400 unsupported-platform(非 macOS)/ 409 sshd-down(远程登录没开)/
          409 already-created(已有 SSH 隧道)/ 400 no-token / 400 no-node /
          502 api-failed(官方 API 失败,或返回成功但没给隧道 ID)

POST /ssh-host/api/ssh/tunnel/remove
     删除 SSH 隧道(复用上游 tunnel/delete 语义:deleted 才算成功),成功后清空 sshTunnelId
     并重启 frpc。200 {ok}
     错误:400 no-tunnel / 400 no-token / 502 delete-failed(官方没删掉这条隧道)/
          502 api-failed
```

**鉴权边界**:`/ssh-host/*` 只在持有密码门 cookie 时才放行(公网侧),否则返回登录页 / 401。
不能按来源地址判断「本机还是公网」——公网流量是 frpc 从 `127.0.0.1` 转发进来的,
两者来源完全相同。本机设置页打的是 DSH webServer 上的同名路由,不经过网关,
所以本机操作不需要密码。

---

## 安全说明

- **专用密钥对,密钥为主**:插件生成一把专用 ed25519 密钥(私钥是 OpenSSH
  `authkey` 格式,即 `BEGIN OPENSSH PRIVATE KEY`,Termius 可直接导入;0.1.0 之前
  导出的 PKCS8 私钥会在插件加载时原地换封装——同一把密钥,公钥与
  `~/.ssh/authorized_keys` 都不变,手机端只需重新导出一次),不做账号密码引导;
  系统密码登录是 sshd 自带行为,插件不碰。
- **私钥 0600,落插件数据目录,不入 state.json**:私钥/公钥落
  `~/.dsh/dsh-ssh-host/ssh-host-key(.pub)`,权限 0600,重启后从盘上恢复;
  state.json 里永远没有私钥(与 gatePassword 同纪律)。
- **authorized_keys 是 upsert 语义**(行内标记 `dsh-ssh-host`):
  `created` = 首次追加;`unchanged` = 同一把公钥已在,不动文件;`replaced` = 重新生成时
  旧标记行被新公钥整行替换(旧私钥随之失效)。**重新生成密钥后,手机端必须重新导入
  新私钥**,否则 SSH 连不上。你自己已有的其它条目(无标记行)永远原样保留;
  历史脏数据里多余的标记行会收敛为恰好一条。
- **SSH 流量不经过密码门**:SSH 隧道是 TCP 直连 `127.0.0.1:22`,认证与加密由 SSH 协议
  自己完成——能连进来的只有持有私钥的人。
- **信任边界**:私钥经 `/ssh-host/api/ssh/key/private` 返回给「本机或已过密码门」的请求者。
  这个边界不扩大攻击面——能过密码门者已拥有 DSH 全部控制权(含 AI 执行命令能力),
  SSH 私钥不新增越权路径。
- **密码门的既有边界(继承上游,原样保留)**:
  - 失败锁定是**全局**的:公网访客在 frpc 看来同源(都是 `127.0.0.1`),没法按真实 IP
    分开计数,一个人连错 5 次会把登录入口锁 60 秒;已登录会话不受影响
  - cookie 没有 `Secure` 标志(只有 `HttpOnly; SameSite=Lax`):网关上游是
    `http://127.0.0.1`,加 Secure 会让未绑定证书走 http:// 的用户完全登不进去;
    代价是 HTTP 下 cookie 明文传输——**DSH 隧道请务必绑定子域名走 HTTPS**
    (见下文「证书警告与白屏问题」)
  - `?gate=<密码>` 直达会把密码写进浏览器历史 / 地址栏,公共设备上请用登录框输入

---

## 验证

**全部离线**:不连 SakuraFrp、不需要访问密钥、不写任何用户目录(`fresh-install-test`
也是拿一个临时 `DSH_HOME` 跑冷启动)。

```bash
npm test                 # 26 个套件、807 项,串行跑并汇总
npm test -- path         # 只跑名字含关键字的套件
```

`npm test` 等价于 `node test-all.mjs`。单跑某一个:`node test/state-test.mjs`。

> 测试文件随包发布(`files` 里包含 `test-all.mjs` 与 `test/*.mjs`),所以
> `npm install` 之后也能直接跑 `npm test`,不必先 clone 仓库。
> 仓库用 `.gitattributes` 把换行符钉成 LF:部分断言用正则检查源码结构,
> CRLF 检出会让 `\n` 匹配不到 `\r\n`,导致这些断言全线飘红而代码本身无误。

| 套件 | 项 | 覆盖 |
|---|---|---|
| `ssh-host-test.mjs` | 92 | SSH 主机能力:ed25519 密钥 / authorized_keys upsert / 连接命令 / sshd 探测注入点 / SSH 路由 / frpc 多隧道(NATFRP_TARGET) |
| `order-test.mjs` | 68 | 四步解锁顺序、表单排布、按钮文案与出现条件 |
| `paths-test.mjs` | 51 | frpc / DSH home 路径解析(含 `$DSH_HOME` 空白、`PROFILE_DIR` 反推) |
| `installer-test.mjs` | 52 | frpc 资产挑选 / 下载 / 版本校验 / 版本号提取与比较 |
| `progressive-test.mjs` | 59 | 渐进解锁派生状态与提示语 |
| `tunnel-create-test.mjs` | 50 | 新建隧道(端口来源、`extra.auto_https`、官方告警回传) |
| `verify.mjs` | 36 | 模块级 + 网关全链路(API 客户端 / frpc 解析 / 密码门 / 围栏 / WS 透传) |
| `fixes-test.mjs` | 40 | 已修 bug 回归(跨盘路径 / 互踢误判 / 密码迁移 / 清空不复活 / API 自愈 / 登录回跳 / 时间戳本地时区 / 深色输入框) |
| `feedback-test.mjs` | 37 | 操作反馈、错误码与文案 |
| `dismiss-test.mjs` | 29 | 官方提醒的关闭状态机(按路径记忆) |
| `tunnel-delete-test.mjs` | 27 | 删除隧道(`deleted` / `failed` 语义、当前隧道状态清理、失败不误伤) |
| `traffic-test.mjs` | 27 | 流量口径与剩余百分比 |
| `apply-test.mjs` | 26 | `apply()` 装配、路由注册、冷启动默认值 |
| `admin-auth-test.mjs` | 24 | 网关管理接口鉴权(7 种路径花招 / WS 同权 / 改密后旧 cookie 失效 / 未登录删除隧道被拒) |
| `external-test.mjs` | 24 | 外链策略(内置标签 / 退化 / 非绝对地址拒绝) |
| `token-test.mjs` | 24 | 密钥写入、清除、掩码 |
| `diag-test.mjs` | 22 | 诊断信息与状态徽标 |
| `state-test.mjs` | 22 | 数据目录迁移(测 index.js 真实现:两级链 / 优先级 / 已有状态不动 / 无 legacy 不留空目录)+ `state.json` 合并写入 |
| `defaults-test.mjs` | 19 | 配置默认值 |
| `update-check-test.mjs` | 15 | 手动检查更新(结论 / 60s 节流 / 连点拦截 / hooks 规则) |
| `scroll-test.mjs` | 14 | 主面板滚动容器链 |
| `gate-redirect-test.mjs` | 12 | 网关 token 补发与重定向循环(补一次即停 / 存不住 cookie 时给说明页 / 自愈仅一次) |
| `switch-test.mjs` | 11 | 侧边栏开关状态机(乐观更新 / 连点保护) |
| `density-test.mjs` | 11 | 面板信息密度与读屏高度 |
| `fresh-install-test.mjs` | 10 | 全新安装的冷启动形态 |
| `credential-token-test.mjs` | 5 | `tokenRef` → DSH credentials 读写 |

界面走查用 `preview-render.mjs`:它用极简 React 桩把真实的 `Panel` 渲染成静态 HTML,
可导出 `ready` / `fresh` / `create` / `noport` 四种形态,再用无头浏览器截图核对。

```bash
PREVIEW_VARIANT=fresh node preview-render.mjs .preview/fresh.html
```

追加真实 API 冒烟(只读端点,会消耗一次 API 调用):

```bash
NATFRP_TOKEN='你的密钥' node test/verify.mjs
```

---

## 与上游的关系

- fork 自 [MentholTea/dsh-sakurafrp](https://github.com/MentholTea/dsh-sakurafrp) 2.4.0
  (commit `ccf4782`),DSH 穿透半侧与上游保持同一套行为;
- 上游更新经 `upstream` remote 手动同步(`git fetch upstream` 后挑选合并),不自动跟随;
- 起点(相对上游 2.4.0)已修复两处遗留缺陷:
  - API User-Agent 硬编码 `2.2.0` → 现从 package.json 的 `version` 现读派生;
  - Windows 上 `stat` 无 `uid` 时属主注记显示 `undefined` → 无 uid 就不显示这一段。

---

## 已知边界

**SSH 主机(本 fork 新增部分)**

- **第一阶段 macOS only**:SSH 主机功能依赖系统 sshd(macOS「远程登录」)。
  Windows 的 OpenSSH Server 支持在路线图上;非 macOS 面板会明示,创建 SSH 隧道
  直接拒绝(400 unsupported-platform)
- **SSH 隧道依赖本机 sshd 开启**:远程登录没开时,创建 SSH 隧道直接拒绝
  (409 sshd-down),面板给出「打开系统设置」深链
- **frpc 生命周期与 DSH 绑定**:DSH 关闭 = frpc 退出 = SSH 与 DSH 两条隧道同时断开;
  需要 SSH 常驻请另配系统服务
- **重新生成密钥后手机端必须重新导入私钥**(replaced 语义,见「安全说明」)

**DSH 穿透(继承上游)**

- 同一隧道绝不能被两个客户端同时连接(互踢),本插件有检测但无法替你关掉另一端;
  带宽/流量跑满、密钥失效不会被判成互踢,只写日志并指向「密钥或网络」
- 失败锁定全局、cookie 无 Secure、`?gate=` 直达——已在「安全说明」列出
- 界面文案目前只有中文(硬编码在 `client.js` 里)。`locale/*.json` 只提供
  `meta.title` / `meta.description`;界面内的按钮、提示、错误文案不走 i18n
- 免费档:2 隧道 / 每月 5 GB 流量(可结转)/ 10 Mbps 限速;额度用完可通过每日签到
  或购买流量套餐提升
- API 写操作(edit/delete/create)走官方 OpenAPI,但官方对滥用有风控,别高频调用

---

## 证书警告与白屏问题(DSH 隧道,重要)

通过 DSH 隧道默认域名(`xxx.nyat.app`)HTTPS 访问时,浏览器会提示证书不受信任;
部分浏览器在告警页选择继续后仍可能白屏。**解决方法是绑定自己的子域名**,
让 frpc 从服务端自动加载与域名匹配的证书:

1. 到 [子域绑定页面](https://www.natfrp.com/tunnel/domain) 申请/绑定子域名,并关联到你的隧道
2. 详细教程见官方文档:[子域绑定指南](https://doc.natfrp.com/bestpractice/domain-bind.html)
3. 绑定完成后,用 `你的子域名:远程端口` 访问,证书正常加载、无白屏

插件设置页在隧道跑起来后,会把这句话连同两个入口一起显示出来:
「不**绑定证书 ↗** 会出现证书警告、白屏等;绑定子域名后即可消除。 **绑定教程 ↗**」
(「不」不带链接——连成一片蓝色会读成「不去绑定证书」,意思正好反了。)

### 手机端登录后白屏、只有桌宠、侧边栏一滑就收回(上游真机定位与修复,原样保留)

**白屏的真因不是遮罩,是主内容宽度被算成 0。** 真机(Android / Edge 开「桌面版网站」)实测:
`dsh-web-mobile` 的移动端样式把 `grid-template-columns` 覆成 `1fr 0 0 !important`,
它假设「主内容在第 1 列」,而 DSH 新版三列布局里主内容在第 2 列——于是主内容列宽 0,
插件全部加载、桌宠照常绘制,看起来却只有白屏。触发键是 `pointer: coarse`,
**手机必现,桌面鼠标不受影响**。

网关注入一段幂等脚本(`POLYFILL_HTML` 里 `data-natfrp-gridfix`),**只摘除命中该选择器的
那一条声明**,插件其余样式原样保留,并监听样式重插以保持生效;不改第三方插件文件,
重启 DSH 后自动起作用。

| 现象 | 真正的成因 | 处置 |
|---|---|---|
| 白屏,但桌宠正常显示 | 移动端样式把主内容列压成 0(见上) | 网关注入 `data-natfrp-gridfix` 精确摘除;或关掉 Edge「桌面版网站」 |
| 勾选框点不动 | 须知页单选框仅 13px,低于触摸命中下限;且需先滚到文末 | 网关注入 `@media(max-width:768px)` 把勾选框放大到 24px |
| 向右滑出侧边栏,立刻自动收回 | 窄视口 DSH 走 drawer,全屏遮罩与 `dsh-web-mobile` 的边缘手势抢同一次触摸 | 用左上角按钮开关;逐帧拖拽必与遮罩抢事件,属第三方插件与宿主 drawer 的手势冲突 |
| 「重定向次数过多,清 Cookie」 | DSH 会话 cookie 名绑定 `host:port`,端口一变就对不上 | 已修,见下 |

### 「重定向次数过多 / 清 Cookie」的完整成因(已修)

DSH 的会话 cookie 名是 `dsh-auth-<base64url(sha256(host:port))>`,**名字绑定端口**;
`token` 则是每个进程随机生成。旧实现在两侧都可能失手:浏览器没存住 cookie 时每轮补
`?token=` → 303 循环;DSH 重启换端口后「看到 `dsh-auth-*` 就不补」→ 永久 401。

现在两者都有确定行为(`test/gate-redirect-test.mjs` 锁死):

1. 补发过一次就种 `sshhost_tok`(600s),此后**不再补**,从源头断掉 303 循环;
2. 同一路径连续补发超过 2 次仍未拿到页面 → 判定浏览器存不住 cookie,
   **停下来给出明确说明页**,而不是继续重定向;
3. 上游 401 且没有补发标记 → 清掉失效的 `dsh-auth-*` 并重新走一次 token
   (`sshhost_heal` 只允许自愈一次,防止变成另一种循环)。

---

## License

MIT
