# 反馈：桌面端所有会话同时卡在「载入历史…」且不自愈 —— loading 缺少失败态、渲染进程诊断信息不足

- 提交对象：DeepSeek Harness 桌面端（`@deepseek-ai/dsh-desktop`）
- 提交人视角：插件开发者+ 重度用户
- 日期：2026-11-16
- 版本与环境（全部取自崩溃日志原文，非推测）
  - `app: @deepseek-ai/dsh-desktop 0.2.2-rc.3`
  - `electron: 44.7.0` / `node: 24.21.0` / `platform: darwin arm64` / `locale: zh-CN`
  - 机器：iMac（arm64），16 GB（`The system has 17179869184 (1048576 pages with a page size of 16384)`）
  - 另有 npm 侧 `@deepseek-ai/dsh` 0.2.2-rc.1（与本问题无关，仅列版本）

---

## 0. 一句话版（可直接粘贴）

> `0.2.2-rc.3`（macOS / Electron 44.7.0）：打开一个第三方插件面板后，**全部会话同时**长期停在「载入历史…」，关面板不自愈、等几分钟不自愈，只能强杀进程。已实测排除宿主事件循环阻塞（插件路由 0.8 ms）、双实例抢会话锁（另一实例 `lsof` 打开会话文件 0 个）、渲染进程满载（子进程 CPU 全 0）。复现时刻**没有**产生新崩溃日志，即渲染进程是活的 —— 所以问题在"请求发出去了但永远排不回来"这一层，而 loading 态既没有超时/失败态，框架也没有 `unresponsive` 监听，用户和开发者都无法从现场判断发生了什么。
> 请求（详见 §6）：**P0** 给历史加载加超时 + 「加载失败 · 重试」出口；**P1** 让插件客户端流量不占应用主体的同源连接池（独立 origin / HTTP/2 / 或 SDK 提供带超时与限流的 fetch）；**P2** 渲染进程被终止后自动 reload 而不只是落日志；**P3** 崩溃日志补 `details.exitCode` 与内存快照（现在只有一句 `killed`，无法区分强杀与 OOM）；**P4** 监听 `unresponsive`。
> 我这边已修完自己插件的无超时 fetch 与无去重轮询，并给宿主侧读路由加了短于前端的超时预算（§5，含 57 项实测）；因此若再复现，插件占池这条已收窄。§6 的诉求与插件写法无关，独立成立。

---

## 1. 现象（用户可见层）

**侧边栏里所有会话同时**长期停留在「载入历史…」，不自己恢复：

- 不是某一个会话的问题，是全部；
- 关闭插件面板不恢复；等待数分钟不恢复；
- 只有强制结束进程才恢复；
- 重启后该会话额外显示：
  > DSH 进程在本轮完成前退出（例如被强制结束、崩溃或关闭超时），重新启动后本轮已中止。未完成的工具调用结果未知。

  这条文案是应用内置 key `message.failure.interrupted`，见 `Contents/Resources/app.asar` 内 `message.failure.interrupted` 字符串。

**用户抱怨的核心不是"卡住"，而是"卡住时界面没有任何可理解的说明，也没有可点的动作"。** 用户唯一能做的动作是杀进程，而杀进程又会制造第二条"本轮已中止"的假故障，进一步误导排查方向。

## 2. 已经排除的可能性（附取证命令，第三方可重跑）

| 结论 | 依据 |
|---|---|
| 宿主（node 侧）事件循环**没有**被阻塞 | 复现时刻直接打点各插件路由：`state 0.000996s` / `logs 0.000495s` / `user 0.209s` / `tunnels 0.112s` / `nodes 0.062s` / `ssh/state 0.064s`。<br>`curl -s -o /dev/null -m 3 -w '%{time_total}' http://127.0.0.1:<guiPort>/ssh-host/api/state` |
| 没有双实例抢会话锁 | 机器上确有两个宿主（桌面 `pid 52474` → `127.0.0.1:59500`；远程 `pid 54627` → `127.0.0.1:62830`），但 `lsof -nP -a -p 54627 \| grep -c "/.dsh/sessions"` = **0**，只有桌面宿主 `lsof -nP -a -p 52474` 持有 4 个 `sessions/*/session.lock` |
| 渲染进程**没有**死循环 / 没有满载 | `ps -Ao pid,ppid,%cpu,etime,command \| awk '$2==52474'` 全部子进程 CPU ≈ 0.0 |
| 未找到系统内存判杀（jetsam）针对本 app 的记录 | 18:00 前后 `log show` 只有 `memorystatus: killing (idle) softwareupdated`，无 Harness 相关条目；当前 `memory_pressure -Q` = 66% free。**但这不能排除 OOM** —— 崩溃日志没有退出码也没有内存读数（见 P3） |

## 3. 时间线：请特别区分"渲染进程死掉"与"全量卡在 loading"这两件事

`log show` 显示 **17:50–18:20 这 30 分钟内该 app 被 launchd 启动 10 次**（pid 依次 30174 / 33212 / 35319 / 37434 / 40045 / 42596 / 44536 / 45745 / 47261 / 51732），`loginwindow` 也记录了 10 次 `appDeath for com.deepseek.dsh`。这段是用户在症状下反复重启尝试恢复，**但请注意 10 次启停只有 1 次留下崩溃日志**：

```
17:59:30  appDeath；同时刻 CoreAnalytics 记录 pid 30918 与 30174 进入 exit handler
18:00:07  launchd: Successfully spawned DeepSeek Harness[35319] "because launch job demand"
18:00:30  崩溃日志 crash-…-renderer.log：source: renderer / shell pid: 35319
          Error: Desktop renderer exited: killed
18:00:33  appDeath for com.deepseek.dsh
18:12:37  上一个实例 appDeath
18:12:46  当前实例的宿主子进程 52474 启动（app 主进程 51732；此后不再重启）
18:2x–18:3x 症状复现（全部会话卡在载入历史）——此刻没有产生任何新的崩溃日志
```

（pid 语义说明，便于对号：崩溃日志的 `shell pid` = Electron 主进程；`lsof` 监听 GUI 端口的是它的子进程 —— 本次即 `ps -o pid,ppid -p 52474` → ppid `51732`。）

由此得到三条对定位关键的结论：

1. **留下日志的那个实例只活了 23 秒**（18:00:07 → 18:00:30），也就是主窗口刚建立渲染进程就没了；它**不是**"用户杀掉一个跑了很多分钟的实例"会产生的形状。
2. 但 `reason === "killed"` **无法区分**外部信号终止与系统资源终止 —— 因为 `render-process-gone` 的 `details.exitCode` 没有被写进日志（见 P3）。同时 18:00 前后 `log show` 里**没有任何 Harness 相关的 `memorystatus`/jetsam 记录**（只有 `killing (idle) softwareupdated`），所以我也**不能**替官方排除 OOM。这条正是 P3 想要消除的歧义。
3. **复现那一刻渲染进程是活着的**（无新崩溃日志）＋**宿主健康**（路由 0.8 ms）＋**CPU 空闲** ⇒ 症状不在"进程死亡"这一层，而在"请求已发出但永远不返回 / 永远排不上"这一层。
   ⇒ 也就是说：**代码里存在一条"渲染进程活着、但全量会话永远停在 loading"的路径，而这条路径没有任何用户可见的降级提示，也没有任何日志。** 这是本反馈的主要议题（P0 + P4）。

换句话说：**"本轮已中止"那条文案是 18:00 那次渲染进程死亡的后果，它和 18:30 的"全部会话卡在载入历史"很可能是两个独立问题**；但因为没有 exitCode、没有 `unresponsive` 监听、loading 也没有失败态，用户和我都无法从现场证据上把它们分开——这本身就是可报告的产品缺陷。

## 4. 最强假设（明确标注：未证实，需要官方确认）

浏览器对单一 origin（`http://127.0.0.1:59500`）的并发连接数在 HTTP/1.1 下只有 6 条。会话历史加载、SSE 事件流、以及**插件面板自己的 fetch** 共用这一条队伍。

复现时刻的实测：`lsof -nP -p 52474 -iTCP:59500 | grep -c ESTABLISHED` = 13 条 socket / 7 个不同 peer 端口 —— 与"池被打满"量级一致，但我**无法**据此证明因果。

如果确实如此，责任在我这边（插件写得不合规），但**框架层也应当保证一个插件不可能把整个应用的会话视图饿死**。下面第 5 节即使全部由我修掉，第 6 节的诉求仍然独立成立。

## 5. 我这边定位到的自身缺陷 —— 已修复（列出以便官方判断是否有同类插件）

**这一节的意义在于收窄范围**：插件侧这几条现在都有超时上限与去重守卫，
下次复现时若仍出现"全部会话卡 loading"，就更不可能是插件占池造成的，
请把注意力放在 §6 的 P0/P1/P2 上。

### 修复了什么

| 原缺陷 | 现在的边界 | 代码位置 |
|---|---|---|
| 4 处 `fetch` 没有 `AbortSignal`／超时，最坏可无限等 | GET 8 s / POST 20 s，超时抛错并带 `timedOut` 标记 | `client.js:57`（`GET_TIMEOUT_MS`）、`:59`（`POST_TIMEOUT_MS`）、`:79`（唯一 `fetch(` 调用点）、`:83-91`（`rethrowTimeout`） |
| 4 个 `setInterval` 轮询没有 in-flight 去重，慢响应叠请求 | 同一个 GET 在途只发一次，结束后自动清表 | `client.js:103`（`pendingGets`）、`:107`（`sharedGet`） |
| 写操作可能复用"写之前就在途"的快照，界面显示改前数据 | `post` 前后各作废一次在途读 | `client.js` `invalidateSharedGets()` 定义于 `:105` 附近，`post`/`postConfig` 各调两次 |
| 远端抽风时轮询按原频率死磕 | 失败退避 `base × 2^n`，上限 60 s；一次成功立即复位 | `client.js:157`（`createPollGate`） |
| 面板隐藏时仍持续打请求 | 隐藏期间拦轮询，但每 30 s 放行一次探活；**判据不可用时保守放行**（宁可多发一次也不饿死首屏） | `client.js:123`（`docVisible`）、`:135`（`panelVisible`） |
| 宿主侧 `/user` 串行两次远端往返，最坏挂 24 s | 改为 `Promise.all` 并行，最坏 6 s | `index.js:1309` |
| 宿主侧读路由照上游默认 12 s 挂着，前端 8 s 已放弃、连接仍被占 | 4 条 GET 轮询路由统一 6 s 读预算（`readTimeoutMs` 可配，`index.js:175`/`:447`），必须早于前端 8 s | `index.js:987` `/tunnels`、`:1022` `/nodes`、`:1300` `/user`、`:1624` `/ssh/state` |

`natfrp.mjs:27` 的上游默认 12 s **没有改**：写路由（建/删隧道、对齐端口）与开机自启是
用户主动在等的动作，缩短只会把"慢"变成"报错"。只有面板轮询路径收到 6 s。

### 明确没有做什么（免得官方按这个预期去判断）

- **没有加宿主侧结果缓存**：回归测试要求"上游失败 → 502，恢复后立刻 200"
  （`test/fixes-test.mjs` 第 6 节），缓存成功结果会让恢复变慢。
- **没有把"要等外网的路由"改成"立刻返回缓存 + 后台刷新"**：那会牺牲刚做完的操作的可见性。
  现在的做法是让它**在预算内失败**，而不是假装成功。
- **没有加 `visibilitychange` 唤醒**：靠 30 s 探活兜底，代价是回前台后最多等一个轮询周期。

### 这些边界是可复核的

`npm test`（950 项 / 26 个套件）里有 57 项专测这一节，且**不是正则看字面**：
`test/fixes-test.mjs` 第 10–13 节把 `client.js` 里真实的函数体抽出来执行（超时是否真的中止、
并发同名 GET 是否只打一次网络、写后是否作废、退避阶梯与 60 s 上限、隐藏节流、
无 DOM 时是否保守放行），并用假上游实测后端
（挂死 → 300 ms 内 502 且 `AbortSignal` 真的中止了上游；`/user` 并行成立 —— 串行会超预算变 502；
`data_plans` 接口 500 时 `/user` 仍 200 并降级为 `dataPlans:null` + `plansError`）。

## 6. 请求官方处理的 6 件事（按优先级）

**(P0) 全量 loading 要有可理解的状态和出口。**
UI 文案「载入历史」位于 `Contents/Resources/app.asar`（2 处命中）。请给历史加载加**超时 + 失败态**：超过 N 秒未返回就把该会话从 loading 切到「加载失败 · 重试 · 查看原因」，而不是无限期占住 loading。这是本反馈唯一必须解决的一条——它决定用户是"看到故障"还是"以为程序坏了然后杀进程"。

**(P1) 插件客户端流量不应与应用主体共用同源连接池。**
建议三选一：
- 为插件面板的 API 提供独立 origin（例如 `http://127.0.0.1:<otherPort>` 或自定义 privileged scheme——代码里已有 `protocol.registerSchemesAsPrivileged([{ scheme: SCHEME, privileges: { supportFetchAPI: true, corsEnabled: true, ... } }])`，看起来具备条件）；
- 或在宿主上启用 HTTP/2 / 多路复用，取消 6 连接上限；
- 或在插件 SDK 层提供**带默认超时、并发上限、请求去重的 fetch 包装**，并在文档里写明"面板轮询必须使用它"。（现有 `@deepseek-ai/dsh-client-*` 注入项里有 `webServer`、`connection`，但据我所见没有一个提供受限流保护的 fetch。）

**(P2) 渲染进程被终止后要有自动恢复动作，而不只是落日志。**
崩溃处理原文（由崩溃日志给出的堆栈定位到 `Contents/Resources/app.asar/lib/main.js:21509`）：

```js
window.webContents.on("render-process-gone", (_event, details) => {
  navigation = void 0;
  if (!quitting && !window.isDestroyed() && details.reason !== "clean-exit")
    reportFatal(new Error(`Desktop renderer exited: ${details.reason}`), "renderer");
});
```

`reportFatal` 只做 `console.error` + `recovery.report(...)`（失败则 `app.exit(1)`），**没有任何 reload / 重建窗口**。用户面对的是"窗口还开着但内容不再更新"。建议 `reason === "killed" | "crashed" | "oom"` 时自动 `webContents.reload()`（或至少弹一个「界面已异常退出 · 点击重载」的覆盖层）。

**(P3) 崩溃日志请补上退出码，并在记录时抓一份内存快照。**
现在日志只有一句 `reason`（`Desktop renderer exited: killed`）：`render-process-gone` 回调里 `details.exitCode` 没有被读取（asar 中搜 `details.exitCode` = 0 命中；上面贴出的处理函数原文也只有 `details.reason`）。少了退出码/信号，就**无法区分"外部强杀"与"系统资源终止/OOM"**——这正是本次排查里最容易误判、也是我在 §3 结论 2 里不得不承认"不能替官方排除 OOM"的直接原因。
另外 asar 中 `app.getAppMetrics` = 0 命中，即崩溃报告目前**完全不包含任何内存读数**。建议 `reportFatal` 组装 header 时顺带 `app.getAppMetrics()` 取各进程 `memory.workingSetSize`，让"是不是 OOM"这类问题在事后仍可回答。

**(P4) 请监听 `BrowserWindow`/`webContents` 的 `unresponsive`。**
在 `Contents/Resources/app.asar` 中搜事件名 `"unresponsive"` / `'unresponsive'` / `` `unresponsive` `` 均为 **0 命中**（另有 13 处 `unresponsive` 字样属于 iOS 原生代码、k8s 注释、目录选择器 worker，均与本议题无关）。目前"渲染进程活着但界面不再更新"这种状态**没有任何日志、没有任何 UI 提示**。本次 18:30 的复现就落在这个盲区里：因为缺少该监听（也缺少 P0 的失败态），我**无法区分**"渲染主线程被长时间阻塞"与"主线程空闲、只是历史请求永远排不上"这两种解释——这正是本反馈最需要官方数据才能定案的一点。

**(P5) 客户端模块合并 bundle 的"连坐跳过"请在 UI 上可见。**
崩溃日志（2026-11-09，`source: web-boot`）显示单个请求 URL 一次合并了 **23 个** `*/client.js`，而宿主文案 `skipped after an earlier failure of this bundle`（同一 asar 内，`this.failedBundleUrls.has(preferred)` 分支）说明：这批里任何一个失败，其余全部被跳过。
本次至少排查掉一种误读：合并 URL 里的 rev 相同**不导致**同批互相失效（条目级 `reload(id, rev)` / `invalidateForReplacement` 是按 id 的），所以这条只在"启动期一个插件拖死全部 UI"这个层面成立。建议：按条目隔离失败，或至少在界面显示「N 个插件界面未能加载」而不是静默白屏。

## 7. 可提供的附件

- `~/Library/Logs/DeepSeek Harness/crash-2026-11-16T10-00-30-530Z-renderer.log`（30 KB，含 `recent plugin operations` 台账；注意该台账自身声明「context, not proof of cause」，且 `truncated:true, bytesRead:33274, filesRead:1`）
- `~/Library/Logs/DeepSeek Harness/crash-2026-11-09T02-59-59-232Z-web-boot.log`（31 KB，P5 的 batch URL 证据）
- 复现时刻的 `lsof` / `ps` / 路由打点原始输出

**关于取证的一个建议**：崩溃日志目录 `~/Library/Logs/DeepSeek Harness/` 是在排查后期才发现的（此前我误判"桌面端不写任何日志"，只有远程宿主有 `~/.dsh-app-remote/web.log`）。请在应用内「设置 · 关于」或崩溃提示里给出这个目录路径与一条「复制诊断信息」按钮——用户能自己附上日志，能省下这类反馈里一半的来回。

## 8. 复现步骤（供官方验证）

1. 桌面端 `0.2.2-rc.3`（macOS，HTTP 面板，非 gate 反代）；
2. 安装一个客户端插件，其面板用 `setInterval` 轮询宿主上**响应慢/挂起**的路由，且 fetch 不带超时（可用一个返回 20 s 后 body 的测试路由复现，不需要 SakuraFrp）；
3. 打开 ≥ 5 个会话，切换到该插件面板；
4. 观察：全部会话停在「载入历史…」，宿主 `curl -o /dev/null -m 3 -w '%{time_total}' http://127.0.0.1:<guiPort>/api/health` 依然 0.8 ms 内应答（未带 cookie 时返回 401，但能应答本身就说明事件循环健康），`~/Library/Logs/DeepSeek Harness/` 无新日志。

若第 4 步成立，则 P1 是根因；若不成立，请把第 6 节 P0 当作独立缺陷保留（**用户无论如何都应该看到一个失败态，而不是无限 loading**）。
