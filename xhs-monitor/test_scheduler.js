const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// 必须先把配置目录指向临时目录，再 require——否则动的是用户真实的 data/schedule.json。
// 这个测试以前会把真实文件改名再删掉，用户的定时设置因此丢过两次。
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'xhs-sched.'));
process.env.XHS_DATA_DIR = TMP;

const sched = require('./scheduler');
const SF = sched.scheduleFile;
if (!SF.startsWith(TMP)) {
  console.error('✗ 隔离失败，scheduleFile 不在临时目录：' + SF);
  process.exit(1);
}

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); console.log('  ✓ ' + name); pass++; }
  catch (e) { console.log('  ✗ ' + name + '\n      ' + e.message); fail++; }
};

console.log('\n[默认值]');
t('默认开启定时', () => assert.equal(sched.load().enabled, true));
t('默认两个时间点', () => assert.deepEqual(sched.load().times, ['09:00', '21:00']));
t('默认不在启动时采集', () => assert.equal(sched.load().runOnStart, false));

console.log('\n[保存与读取]');
t('保存后可读回', () => {
  sched.save({ ...sched.DEFAULTS, enabled: false, times: ['08:30'], runOnStart: true });
  const c = sched.load();
  assert.equal(c.enabled, false);
  assert.deepEqual(c.times, ['08:30']);
  assert.equal(c.runOnStart, true);
});
t('缺失字段回落默认值', () => {
  fs.writeFileSync(SF, JSON.stringify({ enabled: true }));
  const c = sched.load();
  assert.deepEqual(c.times, ['09:00', '21:00'], 'times 应回落默认');
  assert.equal(c.runOnStart, false);
});
t('损坏文件不抛异常', () => {
  fs.writeFileSync(SF, '{坏掉的 json');
  assert.doesNotThrow(() => sched.load());
});

console.log('\n[下次执行时间]');
t('09:00 未过时，下次是今天 09:00', () => {
  const c = { ...sched.DEFAULTS, times: ['09:00'] };
  const n = sched.nextRun(c);
  assert.ok(n instanceof Date);
  const hm = n.getHours() * 100 + n.getMinutes();
  if (hm > 900) assert.equal(hm, 900, '未来应指向最近一个 09:00，实际' + n.toLocaleString());
});
t('时间已过，下次是明天', () => {
  const c = { ...sched.DEFAULTS, times: ['07:31'] };
  const n = sched.nextRun(c);
  const now = new Date();
  if (new Date(now.getFullYear(), now.getMonth(), now.getDate(), 7, 31) < now) {
    assert.ok(n > now, '应指向明天');
    assert.equal(n.getDate() !== now.getDate(), true);
  }
});
t('窗口外的时间点不会出现在"下次执行"里', () => {
  const c = { ...sched.DEFAULTS, times: ['00:00', '00:30'] };
  assert.equal(sched.nextRun(c), null, '凌晨槽位永远不触发，不该显示成下次执行');
});
t('关闭时返回 null', () => assert.equal(sched.nextRun({ ...sched.DEFAULTS, enabled: false }), null));
t('空时间数组返回 null', () => assert.equal(sched.nextRun({ ...sched.DEFAULTS, times: [] }), null));
t('下次时间一定在未来', () => {
  const c = { ...sched.DEFAULTS, times: ['09:00', '21:00'] };
  const n = sched.nextRun(c);
  assert.ok(n.getTime() > Date.now() - 1000, '应指向未来');
});

/*
下面这些用例都注入一个固定时刻 AT，而不是用 sched.nowHM()。
原因：加了可信时段之后，"测试跑在几点"会直接影响结果——
凌晨跑测试时一堆用例会红，白天跑又全绿，这种随机失败最难查。
*/
const AT = new Date(2026, 9, 21, 12, 0, 0);   // 2026-10-21 12:00，落在 07:30–23:50 内
const AT_HM = '12:00';
const AT_DAY = '2026-10-21';

console.log('\n[到点触发判定]');
t('未到点不触发', () => {
  const c = { ...sched.DEFAULTS, times: ['03:33'], ranSlots: [] };
  assert.equal(sched.shouldRunNow(c, AT), false, '12:00 不应命中 03:33');
});
t('到点且未跑过 → 触发', () => {
  const c = { ...sched.DEFAULTS, times: [AT_HM], ranSlots: [] };
  assert.equal(sched.shouldRunNow(c, AT), true);
});
t('到点但已跑过 → 不重复触发', () => {
  const c = { ...sched.DEFAULTS, times: [AT_HM], ranSlots: [AT_DAY + ' ' + AT_HM] };
  assert.equal(sched.shouldRunNow(c, AT), false, '同一时间槽不应重复采集');
});
t('关闭时不触发', () => {
  const c = { ...sched.DEFAULTS, enabled: false, times: [AT_HM], ranSlots: [] };
  assert.equal(sched.shouldRunNow(c, AT), false);
});
t('多时间点中任一命中即触发', () => {
  const c = { ...sched.DEFAULTS, times: ['01:11', AT_HM], ranSlots: [] };
  assert.equal(sched.shouldRunNow(c, AT), true);
});

console.log('\n[执行标记]');
t('标记后写入槽位', () => {
  const c = sched.load();
  sched.markRun(c, sched.nowHM());
  const after = sched.load();
  assert.ok(after.ranSlots.includes(`${sched.today()} ${sched.nowHM()}`), '槽位应被记录');
  assert.ok(after.lastRunAt, '应记录执行时间');
});
t('标记后不再重复触发', () => {
  const c = sched.load();
  c.times = [AT_HM];
  c.ranSlots = [AT_DAY + ' ' + AT_HM];
  sched.save(c);
  assert.equal(sched.shouldRunNow(sched.load(), AT), false);
});
t('槽位数组不无限增长', () => {
  const c = sched.load();
  for (let i = 0; i < 30; i++) sched.markRun(c, '10:0' + (i % 10));
  assert.ok(sched.load().ranSlots.length <= 10, '实际 ' + sched.load().ranSlots.length);
});
t('跨天不同槽位不冲突', () => {
  const c = { ...sched.DEFAULTS, times: [AT_HM], ranSlots: ['2026-10-19 ' + AT_HM] };
  assert.equal(sched.shouldRunNow(c, AT), true, '昨天的槽位记录不该把今天的同一时刻跳过');
});

console.log('\n[可信时段 07:30–23:50]');
const at = (h, m) => new Date(2026, 9, 21, h, m, 0);
t('边界前 1 分钟在窗口外', () => assert.equal(sched.inTrustWindow(at(7, 29)), false));
t('下边界 07:30 生效', () => assert.equal(sched.inTrustWindow(at(7, 30)), true));
t('上边界 23:50 生效', () => assert.equal(sched.inTrustWindow(at(23, 50)), true));
t('边界后 1 分钟在窗口外', () => assert.equal(sched.inTrustWindow(at(23, 51)), false));
t('凌晨 00:15 在窗口外', () => assert.equal(sched.inTrustWindow(at(0, 15)), false));
t('凌晨 06:00 在窗口外', () => assert.equal(sched.inTrustWindow(at(6, 0)), false));
t('凌晨到点也不采集', () => {
  const c = { ...sched.DEFAULTS, times: ['00:15'], ranSlots: [] };
  assert.equal(sched.shouldRunNow(c, at(0, 15)), false, '窗口外的槽位一律不触发');
});
t('23:49 末采可触发', () => {
  const c = { ...sched.DEFAULTS, times: ['23:49'], ranSlots: [] };
  assert.equal(sched.shouldRunNow(c, at(23, 49)), true);
});
t('23:55 的槽位永不触发', () => {
  const c = { ...sched.DEFAULTS, times: ['23:55'], ranSlots: [] };
  assert.equal(sched.shouldRunNow(c, at(23, 55)), false);
});
t('时段常量本身合法', () => {
  assert.equal(sched.TRUST_WINDOW.start, '07:30');
  assert.equal(sched.TRUST_WINDOW.end, '23:50');
});

console.log('\n[时间格式校验]');
t('合法格式通过', () => {
  const re = /^([01]\d|2[0-3]):[0-5]\d$/;
  assert.ok(re.test('00:00') && re.test('09:30') && re.test('23:59'));
});
t('非法格式被拒', () => {
  const re = /^([01]\d|2[0-3]):[0-5]\d$/;
  assert.ok(!re.test('24:00') && !re.test('9:30') && !re.test('09:60') && !re.test('abc'));
});

// 清理：只删临时目录，绝不碰项目里的 data/
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}

console.log(`\n结果: ${pass} 通过, ${fail} 失败\n`);
process.exit(fail ? 1 : 0);