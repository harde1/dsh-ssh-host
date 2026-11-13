#!/usr/bin/env bash
# realmachine-keycheck.sh —— 真机私钥格式复核（评估者可自己跑，不需要访问密钥、不联网）
#
# 判什么：插件落盘的私钥是不是系统 OpenSSH 认得的封装，以及它推出的公钥
# 是否就是本机 authorized_keys 里那一条 —— 也就是「这把私钥能不能真的连进来」。
#
# 为什么需要它：`npm test` 全离线，用临时目录里的假密钥，能证明 *编码逻辑* 自洽，
# 但证明不了 *这台机器上那把真密钥* 处于修好后的状态（自愈是否真发生过、
# authorized_keys 是否被改动过）。这两件事只有真机跑得出来。
#
# 只读：不写任何文件，不改 authorized_keys，不重启任何服务。
# Termius 能不能导入这一半，脚本无法回答 —— 那是手机端的行为，见 README「安全说明」。
set -uo pipefail

KEY="${DSH_SSH_KEY:-$HOME/.dsh/dsh-ssh-host/ssh-host-key}"
AK="$HOME/.ssh/authorized_keys"
fail=0
ok()   { printf '  PASS  %s\n' "$1"; }
bad()  { printf '  FAIL  %s\n' "$1"; fail=1; }
say()  { printf '\n== %s ==\n' "$1"; }

say "1) 私钥封装"
if [[ ! -f "$KEY" ]]; then
  bad "私钥不存在：$KEY（先在面板生成 SSH 密钥）"
  exit 1
fi
head1=$(head -1 "$KEY")
[[ "$head1" == "-----BEGIN OPENSSH PRIVATE KEY-----" ]] \
  && ok "PEM 头是 authkey 封装（BEGIN OPENSSH PRIVATE KEY）" \
  || bad "PEM 头是「$head1」——PKCS8 会被 Termius 报 Unsupported key type: PRIVATE KEY"
perm=$(stat -f '%Lp' "$KEY" 2>/dev/null || stat -c '%a' "$KEY" 2>/dev/null)
[[ "$perm" == "600" ]] && ok "权限 0600" || bad "权限是 $perm，应为 0600"

say "2) 系统 ssh-keygen 能不能读这把私钥（格式的权威判据）"
derived=$(ssh-keygen -y -f "$KEY" 2>/dev/null)
if [[ -z "$derived" ]]; then
  bad "ssh-keygen -y 读不出来：$(ssh-keygen -y -f "$KEY" 2>&1 | tail -1)"
  exit 1
fi
ok "ssh-keygen -y 成功推出公钥：${derived:0:40}…"

say "3) 推出的公钥 vs 本机 authorized_keys 的标记行（整行逐字节）"
if [[ ! -f "$AK" ]]; then
  bad "~/.ssh/authorized_keys 不存在"
else
  marker=$(grep -c 'dsh-ssh-host' "$AK")
  [[ "$marker" == "1" ]] && ok "标记行恰好 1 条" || bad "标记行有 $marker 条，应为 1"
  line=$(grep 'dsh-ssh-host' "$AK" | head -1)
  if [[ "$line" == "$derived" ]]; then
    ok "authorized_keys 标记行 == ssh-keygen -y 输出（$(printf '%s\n' "$derived" | wc -c | tr -d ' ') 字节，逐字节一致）"
  else
    bad "两边不同：\n        盘上 = $line\n        推出 = $derived"
  fi
fi

say "4) 三处公钥收敛（.pub / 私钥反推 / authorized_keys）"
body() { awk '{print $1" "$2}'; }
uniq=$( { body "$KEY.pub"; printf '%s\n' "$derived" | body; printf '%s\n' "${line:-}" | body; } 2>/dev/null | sort -u | grep -c . )
[[ "$uniq" == "1" ]] && ok "三处公钥是同一把（唯一值 1 个）" \
  || bad "三处公钥出现 $uniq 个不同值"

say "5) 指纹（两条独立路径算同一个数）"
fp_pub=$(ssh-keygen -lf "$KEY.pub" 2>/dev/null | awk '{print $2}')
fp_der=$(printf '%s\n' "$derived" | ssh-keygen -lf - 2>/dev/null | awk '{print $2}')
[[ -n "$fp_pub" && "$fp_pub" == "$fp_der" ]] && ok "指纹一致：$fp_pub" \
  || bad "指纹不一致：.pub=$fp_pub 私钥反推=$fp_der（面板显示的是后者）"

say "6) 自愈留下的备份：同一把密钥，只换了封装"
if [[ -f "$KEY.pkcs8.bak" ]]; then
  bk=$(head -1 "$KEY.pkcs8.bak")
  ok "存在备份：$KEY.pkcs8.bak（头为 ${bk}）"
  # 这里不能用 ssh-keygen -y 比两边：PKCS8 那份它本来就读不动 —— 那正是当年
  # Termius 拒收的同一个原因。改比最硬的东西：ed25519 的 32 字节 seed。
  # seed 一致 = 自愈只换了外层封装，没换密钥本身（公钥与 authorized_keys 才可能不变）。
  if command -v python3 >/dev/null && command -v openssl >/dev/null; then
    seedout=$(python3 - "$KEY" "$KEY.pkcs8.bak" <<'PYEOF'
import base64, re, subprocess, sys
cur, bak = sys.argv[1], sys.argv[2]
der = subprocess.run(['openssl', 'pkey', '-inform', 'PEM', '-in', bak, '-outform', 'DER'],
                     capture_output=True).stdout
if len(der) < 32:
    print('SKIP  openssl 解析不了备份，跳过 seed 比对'); raise SystemExit
seed_bak = der[-32:]
b = base64.b64decode(re.search(r'BEGIN OPENSSH PRIVATE KEY-----(.+?)-----END',
                               open(cur).read(), re.S).group(1))
i = len(b'openssh-key-v1\x00')
def u32(buf, off): return int.from_bytes(buf[off:off + 4], 'big'), off + 4
def rs(buf, off):
    n, off = u32(buf, off); return buf[off:off + n], off + n
for _ in range(3): _, i = rs(b, i)      # ciphername / kdfname / kdfoptions
_, i = u32(b, i)                        # nkeys
_, i = rs(b, i)                         # public key blob
priv, i = rs(b, i)                      # private section
j = 8                                   # 跳过两个 checkuint32
_, j = rs(priv, j)                      # key type
_, j = rs(priv, j)                      # pub (32)
pv, j = rs(priv, j)                     # priv = seed||pub (64)
if pv[:32] == seed_bak:
    print('SAME 32 字节 seed 完全一致：', seed_bak.hex())
else:
    print('DIFFERENT 自愈换掉了密钥本身：备份', seed_bak.hex(), '现私钥', pv[:32].hex())
PYEOF
)
    case "$seedout" in
      SAME*)      ok "$seedout" ;;
      DIFFERENT*) bad "$seedout" ;;
      *)          say "   $seedout" ;;
    esac
  else
    say "   没有 python3/openssl，跳过 seed 比对（前 5 项不受影响）"
  fi
else
  say "   没有 .pkcs8.bak —— 这把密钥是修复之后新建的，属正常"
fi

printf '\n%s\n' "$([[ $fail == 0 ]] && echo '真机私钥复核：全部通过' || echo '真机私钥复核：有失败')"
exit $fail
