# L3 独立评估 · 复核卡（评估者 9dd958a9，两轮）

> 来源：本会话后台子代理 9dd958a9 的两次 closing message（第二轮为对本轮材料变化的复核）。
> 复跑环境：一次性副本 .clearai-reruns/44c6…b8006，入场时逐文件 sha256 与 HEAD 一致；全部只读，未向任何全局目录写文件。

## 第一轮（HEAD=origin/master=66c03f7）

- **h-d173ro = support**：加载自愈只换封装，公钥与 authorized_keys 双路复跑未动。
- **h-tlz0tt = support**：五套件复跑全绿零失败，遗留项锁在折叠区内，日志/安装卡在区外保底。
- **h-itrupt = inconclusive**（当时）：零点击链（密钥自动生成）只存在于未提交工作区，推送版仍需手动点「生成 SSH 密钥」。
- **h-lgytg4 = inconclusive**（当时）：ssh-keygen 半边硬支持，「Termius 可导入」半边无本机可复跑证据，归 L4。
- **holds = yes**。另开两条新异常：① 版本分叉（自动化引擎未提交）；② 报告 §3 陈旧窗口。

## 第二轮（HEAD=origin/master=2cb04b5，材料变化后复核）

材料变化：4cd081e（自动化引擎提交推送）→ f2f88ee（报告 §3 重测）→ 2cb04b5（报告 §1/§2 刷新）。

复跑读数（全部 exit 0，在 git show HEAD: 提取的 2cb04b5 副本内）：
- `npm test` → **884/884、26 个套件 + README 一致行**，与 reports/l3-evidence.md:40-41 逐字吻合；
- `node test/order-test.mjs` → **121/121**，§15b 自动化 11 条全 PASS；
- `./test/realmachine-keycheck.sh` → **六组全 PASS、exit=0**（seed SAME、标记行 94 字节逐字节一致、指纹一致）；
- §3 锚点：SshHero=2174、双字面量计数 1、hero 全函数体 2174-2521「密码」=0。

### 最终裁决

| 主张 | 结果 | 证据要点 | scope_limit |
|---|---|---|---|
| h-d173ro | **support** | keycheck 六组 PASS（备份 seed SAME）；离线 (f) 块 659-682 复跑绿；index.js:200-207 换封装不触碰 authorized_keys（唯一写入点 :1607-1628） | — |
| h-itrupt | **support**（由 inconclusive 升格） | 4cd081e 已上交付树；链路四环：密钥自动生成 client.js:2217-2220、三级回退 index.js:1670-1719、端口恒 22 index.js:1726、建好自动开启 index.js:1738-1746；HEAD 字节复跑 884/884+order 121/121 | 客户端 effect 真浏览器实fire行为只有结构断言+服务端路由执行测试支撑，无浏览器级执行证据——已登记，不降级 |
| h-lgytg4 | **inconclusive**（维持） | ssh-keygen 半边两轮硬支持；Termius 半边零证据，归 L4（本体 verification-loop.md:113） | Termius 导入半边挂 L4 task 12，不因本轮升格 |
| h-tlz0tt | **support**（维持） | 五套件 HEAD 复跑全绿零失败；§16 折叠结构复跑绿（①②③④/保存/版本条在折叠头与日志锚之间，安装卡与日志在区外） | density 两条像素预算 SKIP（无 Edge/Chrome）；真浏览器折叠点击无执行证据——已登记缺口，不构成推翻 |

**推翻条件核对**：四条登记主张的推翻条件在本轮复跑均未触发。

### 反常处置

- u-163aif / u-6onejm（density SKIP 重复登记）：maintain
- u-kniy6z（夹具惰性 useState）：maintain，已修 slotOf + adv 变体
- u-qnf13x（核对只在成功分支记 actual）：maintain，已移出分支并人为改 999 复现
- 上轮新异常#1 版本分叉：**resolved**（4cd081e 提交推送，HEAD==origin/master）
- 上轮新异常#2 报告 §3 陈旧窗口：**resolved**（f2f88ee 按 HEAD 重测）
- 本轮新异常：报告 §3 折叠头行号印 1443，HEAD 实际 1444（差一行，锚点存在、实质不受影响）→ 已由 82c32fc 修复

### 结论

**holds = yes**：交付成立，四条推翻条件未触发；目标不因此关闭。两条登记缺口（Termius 导入 L4、真浏览器折叠行为）随卡保留。
