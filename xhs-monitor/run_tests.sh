#!/bin/bash
# 统一测试入口：跑前自动备份真实数据，跑后校验有没有被测试污染。
#
# 为什么需要它：test_api.js 早期直接连 7788 生产实例，一上来就清空商品表，
# 把用户真实的监控数据全删了（2026-10-20 事故）。靠"记得先备份"不靠谱，
# 所以把备份和校验固化进脚本。
#
# 用法：bash run_tests.sh          跑全部
#       bash run_tests.sh core     只跑不需要浏览器的那一批
#       bash run_tests.sh ui       只跑界面测试

set -u
cd "$(dirname "$0")"

NODE=${NODE:-/Users/weizhenliang/.workbuddy/binaries/node/versions/22.22.2-6/bin/node}
export NODE_PATH=/Users/weizhenliang/.workbuddy/binaries/node/workspace/node_modules

DATA=data/snapshots.json
SCHED=data/schedule.json

# 1) 跑前备份（只增不删）
STAMP=$(date +%Y%m%d-%H%M%S)
BK=backups/$STAMP
mkdir -p "$BK"
cp "$DATA"  "$BK/snapshots.json" 2>/dev/null
cp "$SCHED" "$BK/schedule.json"  2>/dev/null
echo "已备份真实数据 → $BK"

md5sum() { command md5 -q "$1" 2>/dev/null || echo missing; }
D0=$(md5sum "$DATA")
S0=$(md5sum "$SCHED")

CORE="test_core test_groups_explicit test_groups test_price test_scheduler test_shop_aggregate test_today test_share_text test_chartkit test_period test_rollback test_cart"
API="test_api test_schedule_api test_share_api"
UI="test_ui_charts test_ui_price test_ui_shopgroup test_ui_dissolve test_ui_manage test_ui_collectmgr test_ui_lastnext test_ui_layout test_ui_overview test_ui_today test_ui_todayhot test_ui_stale test_ui_daycut test_ui_shopdelta test_ui_share test_ui_period test_ui_cartsort test_ui_stalemark test_ui_nocart"

case "${1:-all}" in
  core) LIST=$CORE ;;
  api)  LIST=$API ;;
  ui)   LIST=$UI ;;
  *)    LIST="$CORE $API $UI" ;;
esac

echo
OVERALL=0

# 有些界面测试是「只读 + 连真实服务」的（默认打 127.0.0.1:7788），
# 服务没起来时它们会报 ERR_CONNECTION_REFUSED，同样表现为「没有结果行」。
# 这种要跟「测试真的挂了」区分开，否则排查时会被引到错方向
# （这里踩过：nohup 起的服务被沙箱回收，全量回归里 4 个测试集体「无法运行」，
#   实际只是服务中途没了，代码没问题）。
NEED_SERVER=0
if printf '%s ' $LIST | grep -q "test_ui_lastnext\|test_ui_overview\|test_ui_today\|test_ui_period"; then
  if curl -s --max-time 5 "http://127.0.0.1:7788/api/state?days=1" -o /dev/null; then
    echo "✓ 真实服务在 7788 运行中，只读界面测试将直接连它"
  else
    echo "⚠️  7788 上没有服务在跑，只读界面测试会连接失败（先把 server.js 起起来）"
    NEED_SERVER=1
  fi
fi
echo

for t in $LIST; do
  [ -f "$t.js" ] || continue
  OUT=$("$NODE" "$t.js" 2>&1)
  LINE=$(echo "$OUT" | grep -E "结果:" | tail -1)
  if [ -z "$LINE" ]; then
    if echo "$OUT" | grep -q "ERR_CONNECTION_REFUSED"; then
      printf '  %-26s 跳过（连不上 7788 服务，服务没起）\n' "$t"
    else
      printf '  %-26s 无法运行（脚本异常退出，看下面的输出）\n' "$t"
    fi
    echo "$OUT" | tail -3 | sed 's/^/      /'
    OVERALL=1
  else
    printf '  %-26s %s\n' "$t" "$LINE"
    echo "$OUT" | grep -E '✗' | sed 's/^/      /'
    echo "$LINE" | grep -qE "0 失败" || OVERALL=1
  fi
done
[ "$NEED_SERVER" = "1" ] && OVERALL=1

# 2) 跑后校验：真实数据是否被改动
#
# 只比 MD5 不够用：服务在跑的时候，脚本执行期间它自己会采到新快照（甚至因为
# 「启动即采集」一下写 8 条），MD5 必然变。一律判红会把正常采集误报成污染，
# 反过来也让人对真事故麻木。所以 MD5 不同时再做一次结构比对：
#   - 丢商品 / 丢快照 / 已有快照的已售值或时间被改写 → 判定污染，报错
#   - 只是追加了新快照、lastRunAt 变了 → 正常的真实采集，放行但打印出来
echo
D1=$(md5sum "$DATA")
S1=$(md5sum "$SCHED")

check_append_only() {
  "$NODE" - "$1" "$2" <<'JS'
const fs = require('fs');
const before = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const after = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));
const bad = [];

const bp = before.products || [], ap = after.products || [];
for (const p of bp) {
  const q = ap.find(x => x.id === p.id);
  if (!q) { bad.push('商品被删：' + (p.name || p.id)); continue; }
  for (const k of ['name', 'shop', 'group', 'itemId', 'archived']) {
    if (String(p[k]) !== String(q[k])) bad.push(`商品 ${p.name || p.id} 的 ${k} 被改：${p[k]} → ${q[k]}`);
  }
}
const bs = before.snapshots || [], as = after.snapshots || [];
const idx = new Map(as.map(s => [s.id, s]));
for (const s of bs) {
  const t = idx.get(s.id);
  if (!t) { bad.push('快照被删：' + s.id); continue; }
  if (s.soldTotal !== t.soldTotal) bad.push(`快照 ${s.id} 的已售被改：${s.soldTotal} → ${t.soldTotal}`);
  if (s.ts !== t.ts) bad.push(`快照 ${s.id} 的时间被改`);
}
const added = as.filter(s => !bs.some(x => x.id === s.id));

if (bad.length) {
  console.log('⚠️  真实数据被改动了（不是单纯追加）：');
  for (const b of bad.slice(0, 10)) console.log('    · ' + b);
  if (bad.length > 10) console.log(`    · …另有 ${bad.length - 10} 处`);
  process.exit(1);
}
console.log(`✓ 真实数据只被追加：商品 ${bp.length}→${ap.length}、快照 ${bs.length}→${as.length}`
  + `（期间服务自己采了 ${added.length} 条，属正常采集，非测试污染）`);
JS
}

check_schedule() {
  "$NODE" - "$1" "$2" <<'JS'
const fs = require('fs');
const a = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const b = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));
const bad = [];
if (JSON.stringify(a.times) !== JSON.stringify(b.times))
  bad.push(`采集时间被改：${JSON.stringify(a.times)} → ${JSON.stringify(b.times)}`);
if (!!a.enabled !== !!b.enabled) bad.push(`开关被改：${a.enabled} → ${b.enabled}`);
if (!!a.runOnStart !== !!b.runOnStart) bad.push(`启动即采集被改：${a.runOnStart} → ${b.runOnStart}`);
if (bad.length) { console.log('⚠️  定时配置被测试改动了：'); bad.forEach(x => console.log('    · ' + x)); process.exit(1); }
console.log('✓ 定时配置的设置项未变（仅执行记录 lastRunAt 更新，属正常）');
JS
}

if [ "$D0" = "$D1" ] && [ "$S0" = "$S1" ]; then
  echo "✓ 真实数据与定时配置完好，未被测试污染"
else
  [ "$D0" = "$D1" ] || { check_append_only "$BK/snapshots.json" "$DATA" || OVERALL=1; }
  [ "$S0" = "$S1" ] || { check_schedule "$BK/schedule.json" "$SCHED" || OVERALL=1; }
  # 花括号不能省：bash 会把紧跟在变量名后的全角「）」当成名字的一部分，
  # 配合 set -u 直接 unbound variable（这里踩过）
  echo "    （跑前快照留在 ${BK}）"
fi

exit $OVERALL
