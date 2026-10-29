const fs = require('fs');
const path = require('path');
// 相对本文件定位，别写死绝对路径（换台机器就找不到目录了）
const BASE = __dirname;
const DB = path.join(BASE, 'data', 'snapshots.json');
const LOG = path.join(BASE, 'data', 'auto-log.json');
// 要测的槽位可以命令行传，也可以写在 /tmp/test_slot.txt
const SLOT_FILE = '/tmp/test_slot.txt';
const TARGET = process.argv[2] || (fs.existsSync(SLOT_FILE) ? fs.readFileSync(SLOT_FILE, 'utf8').trim() : '');
if (!TARGET) {
  console.error(`用法: node verify_cron.js HH:MM   （或把槽位写进 ${SLOT_FILE}）`);
  process.exit(1);
}

function snapCount() {
  try { return JSON.parse(fs.readFileSync(DB, 'utf8')).snapshots.length; } catch (_) { return -1; }
}
function autoLogCount() {
  try { return JSON.parse(fs.readFileSync(LOG, 'utf8')).length; } catch (_) { return 0; }
}

const startCount = snapCount();
const startLog = autoLogCount();
console.log(`[监视] 测试槽位 ${TARGET}`);
console.log(`[监视] 开始时快照数=${startCount} 自动日志数=${startLog}`);
console.log(`[监视] 当前时间 ${new Date().toLocaleTimeString('zh-CN', { hour12: false })}`);

const [h, m] = TARGET.split(':').map(Number);
const targetTime = new Date();
targetTime.setHours(h, m, 30, 0);   // 到点后 30 秒检查
if (targetTime < new Date()) targetTime.setDate(targetTime.getDate() + 1);

const waitMs = targetTime - new Date();
console.log(`[监视] 等待 ${Math.round(waitMs / 1000)} 秒到 ${targetTime.toLocaleTimeString('zh-CN', { hour12: false })}`);

setTimeout(async () => {
  const nowCount = snapCount();
  const nowLog = autoLogCount();
  console.log(`\n[结果] ${new Date().toLocaleTimeString('zh-CN', { hour12: false })}`);
  console.log(`[结果] 快照数: ${startCount} → ${nowCount}`);
  console.log(`[结果] 自动日志数: ${startLog} → ${nowLog}`);
  console.log(`[结果] 定时器是否触发: ${nowCount > startCount ? '是 ✓' : '否 ✗'}`);
  if (nowLog > startLog) {
    try {
      const logs = JSON.parse(fs.readFileSync(LOG, 'utf8'));
      const last = logs[0];
      console.log(`[结果] 日志内容: 触发=${last.trigger} 槽位=${last.slot} 总数=${last.total} 成功=${last.ok} 变化=${JSON.stringify(last.changes)}`);
    } catch (_) {}
  }
  // 最后再补一次检查（采集可能需要几秒）
  await new Promise(r => setTimeout(r, 12000));
  const finalCount = snapCount();
  console.log(`[结果] 再等12秒后快照数: ${finalCount}（${finalCount > startCount ? '确认已自动采集 ✓' : '仍未采集'}）`);
  if (finalCount > startCount) {
    const db = JSON.parse(fs.readFileSync(DB, 'utf8'));
    const last = db.snapshots[db.snapshots.length - 1];
    console.log(`[结果] 最新快照: ${new Date(last.ts).toLocaleString('zh-CN', { hour12: false })} 已售=${last.soldTotal} 来源=${last.source}`);
  }
  process.exit(0);
}, waitMs);
