# L3 核验证据（生成时间 2026-11-13T11:36:41+08:00）

本机 Node v22.23.4，Darwin 25.5.0。以下均为本次实际执行输出，可原样复跑。

## 1) 全量测试
命令：`npm test`

```

> dsh-ssh-host@0.1.0 test
> node test-all.mjs

  ok   admin-auth-test.mjs        24/24
  ok   apply-test.mjs             26/26
  ok   credential-token-test.mjs  5/5
  ok   defaults-test.mjs          19/19
  ok   density-test.mjs           11/11
  ok   diag-test.mjs              22/22
  ok   dismiss-test.mjs           29/29
  ok   external-test.mjs          24/24
  ok   feedback-test.mjs          37/37
  ok   fixes-test.mjs             40/40
  ok   fresh-install-test.mjs     10/10
  ok   gate-redirect-test.mjs     12/12
  ok   installer-test.mjs         52/52
  ok   order-test.mjs             121/121
  ok   paths-test.mjs             51/51
  ok   progressive-test.mjs       59/59
  ok   scroll-test.mjs            14/14
  ok   ssh-host-test.mjs          116/116
  ok   state-test.mjs             22/22
  ok   switch-test.mjs            11/11
  ok   token-test.mjs             24/24
  ok   traffic-test.mjs           27/27
  ok   tunnel-create-test.mjs     50/50
  ok   tunnel-delete-test.mjs     27/27
  ok   update-check-test.mjs      15/15
  ok   verify.mjs                 36/36

全部通过：884/884 项，26 个套件
(README 数字与实跑一致：884 项 / 26 个套件)
```

## 2) 真机私钥复核（只读）
命令：`./test/realmachine-keycheck.sh`

```

== 1) 私钥封装 ==
  PASS  PEM 头是 authkey 封装（BEGIN OPENSSH PRIVATE KEY）
  PASS  权限 0600

== 2) 系统 ssh-keygen 能不能读这把私钥（格式的权威判据） ==
  PASS  ssh-keygen -y 成功推出公钥：ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIKX5…

== 3) 推出的公钥 vs 本机 authorized_keys 的标记行（整行逐字节） ==
  PASS  标记行恰好 1 条
  PASS  authorized_keys 标记行 == ssh-keygen -y 输出（94 字节，逐字节一致）

== 4) 三处公钥收敛（.pub / 私钥反推 / authorized_keys） ==
  PASS  三处公钥是同一把（唯一值 1 个）

== 5) 指纹（两条独立路径算同一个数） ==
  PASS  指纹一致：SHA256:oX1LJ/qBTfFAYug60VC0jdxkZg23KuMOjfRI/eES7+c

== 6) 自愈留下的备份：同一把密钥，只换了封装 ==
  PASS  存在备份：/Users/mac/.dsh/dsh-ssh-host/ssh-host-key.pkcs8.bak（头为 -----BEGIN PRIVATE KEY-----）
  PASS  SAME 32 字节 seed 完全一致： 6c0b077ef6fb79711461a301827bb32c6758c997a7a8f062825294ac42d424c4

真机私钥复核：全部通过
exit=0
```

## 3) 判据锚点（grep 实录，可复跑，已按 HEAD=4cd081e 重测）

`npm test` 全绿之外，目标判据还有四条可 grep 的锚点：

```
$ grep -n "function SshHero" client.js
2174:    function SshHero() {

$ grep -cn "复制连接命令\|打开系统设置" client.js
2

$ grep -n "── 高级（默认收起）" client.js
1443:        // ── 高级（默认收起）：遗留的 DSH 隧道配置整段搬到这里，功能项一个不少 ──

$ grep -cn "收起高级设置\|高级（DSH 隧道 / 端口 / 日志配置）" client.js
1        # 两个字面量是同一个三元的两臂，只占一行

$ grep -c "密码" client.js        # 全文件「含密码的行数」（④ 与口令门逻辑都在高级区）
15

$ sed -n '2174,2521p' client.js | grep -c "密码"   # SSH 卡片函数体（判据要求的区域）
0
```

> §3 曾用 2138/2410 的旧窗口（捕获时点早于最终布局），评估者复跑发现
> `function SshHero` 在 2174、窗口 2138-2410 会罩进 hero 外的注释行（计数 2 非 0）。
> 已按 HEAD 重测：hero 全函数体 2174-2521 内「密码」= 0，实质结论不变。

## 4) 已闭反常（4 条，结案时随交付交给评估者）

| id | 内容 | 处置 |
|---|---|---|
| u-163aif / u-6onejm | density 像素预算 SKIP（本机无 Edge/Chrome）被重复登记了两次 | explained：同一读数重复登记，无第二事实 |
| u-kniy6z | 预览夹具里「高级」区永远展开、①②③④ 全可见 | explained：夹具 mini-React 不支持惰性 useState(fn)，把函数本体当初值（恒真）；已修 slotOf，加 PREVIEW_VARIANT=adv 复验 |
| u-qnf13x | README 声明 873 项 vs 核对报「实跑 763」 | explained：763 = 873 − order-test 的 110（当时 order-test 为 110 项），核对代码只在成功分支记 actual，order-test 自己红时它的项数凭空消失，报出假差值；已移出分支并人为改 999 复现验证 |

