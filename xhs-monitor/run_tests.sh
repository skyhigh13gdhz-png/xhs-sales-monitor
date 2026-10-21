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

CORE="test_core test_groups_explicit test_groups test_price test_scheduler test_shop_aggregate test_today test_share_text test_chartkit test_period test_rollback"
API="test_api test_schedule_api test_share_api"
UI="test_ui_charts test_ui_price test_ui_shopgroup test_ui_dissolve test_ui_manage test_ui_jobposition test_ui_lastnext test_ui_layout test_ui_overview test_ui_today test_ui_todayhot test_ui_stale test_ui_daycut test_ui_share test_ui_period"

case "${1:-all}" in
  core) LIST=$CORE ;;
  api)  LIST=$API ;;
  ui)   LIST=$UI ;;
  *)    LIST="$CORE $API $UI" ;;
esac

echo
OVERALL=0
for t in $LIST; do
  [ -f "$t.js" ] || continue
  OUT=$("$NODE" "$t.js" 2>&1)
  LINE=$(echo "$OUT" | grep -E "结果:" | tail -1)
  if [ -z "$LINE" ]; then
    printf '  %-26s 无法运行（可能需要临时端口被占用）\n' "$t"
    echo "$OUT" | tail -3 | sed 's/^/      /'
    OVERALL=1
  else
    printf '  %-26s %s\n' "$t" "$LINE"
    echo "$OUT" | grep -E '✗' | sed 's/^/      /'
    echo "$LINE" | grep -qE "0 失败" || OVERALL=1
  fi
done

# 2) 跑后校验：真实数据是否被改动
echo
D1=$(md5sum "$DATA")
S1=$(md5sum "$SCHED")
if [ "$D0" != "$D1" ]; then
  echo "⚠️  真实数据被测试改动了！"
  echo "    跑前快照在 $BK/snapshots.json"
  echo "    还原：cp $BK/snapshots.json $DATA"
  OVERALL=1
fi
if [ "$S0" != "$S1" ]; then
  echo "⚠️  定时配置被测试改动了！"
  echo "    还原：cp $BK/schedule.json $SCHED"
  OVERALL=1
fi
if [ "$D0" = "$D1" ] && [ "$S0" = "$S1" ]; then
  echo "✓ 真实数据与定时配置完好，未被测试污染"
fi

exit $OVERALL
