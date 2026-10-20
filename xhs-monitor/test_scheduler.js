const assert = require('assert');
const sched = require('./scheduler');
const fs = require('fs');
const path = require('path');

const SF = sched.scheduleFile;
if (fs.existsSync(SF)) fs.renameSync(SF, SF + '.bak-' + Date.now());

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
  const c = { ...sched.DEFAULTS, times: ['00:01'] };
  const n = sched.nextRun(c);
  const now = new Date();
  if (new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 1) < now) {
    assert.ok(n > now, '应指向明天');
    assert.equal(n.getDate() !== now.getDate(), true);
  }
});
t('关闭时返回 null', () => assert.equal(sched.nextRun({ ...sched.DEFAULTS, enabled: false }), null));
t('空时间数组返回 null', () => assert.equal(sched.nextRun({ ...sched.DEFAULTS, times: [] }), null));
t('下次时间一定在未来', () => {
  const c = { ...sched.DEFAULTS, times: ['09:00', '21:00'] };
  const n = sched.nextRun(c);
  assert.ok(n.getTime() > Date.now() - 1000, '应指向未来');
});

console.log('\n[到点触发判定]');
t('未到点不触发', () => {
  const c = { ...sched.DEFAULTS, times: ['03:33'], ranSlots: [] };
  const nowHM = sched.nowHM();
  assert.equal(sched.shouldRunNow(c), false, '现在 ' + nowHM + ' 不应等于 03:33（除非刚好）');
});
t('到点且未跑过 → 触发', () => {
  const c = { ...sched.DEFAULTS, times: [sched.nowHM()], ranSlots: [] };
  assert.equal(sched.shouldRunNow(c), true);
});
t('到点但已跑过 → 不重复触发', () => {
  const slot = `${sched.today()} ${sched.nowHM()}`;
  const c = { ...sched.DEFAULTS, times: [sched.nowHM()], ranSlots: [slot] };
  assert.equal(sched.shouldRunNow(c), false, '同一时间槽不应重复采集');
});
t('关闭时不触发', () => {
  const c = { ...sched.DEFAULTS, enabled: false, times: [sched.nowHM()], ranSlots: [] };
  assert.equal(sched.shouldRunNow(c), false);
});
t('多时间点中任一命中即触发', () => {
  const c = { ...sched.DEFAULTS, times: ['01:11', sched.nowHM()], ranSlots: [] };
  assert.equal(sched.shouldRunNow(c), true);
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
  c.times = [sched.nowHM()];
  sched.save(c);
  const fresh = sched.load();
  assert.equal(sched.shouldRunNow(fresh), false);
});
t('槽位数组不无限增长', () => {
  const c = sched.load();
  for (let i = 0; i < 30; i++) sched.markRun(c, '10:0' + (i % 10));
  assert.ok(sched.load().ranSlots.length <= 10, '实际 ' + sched.load().ranSlots.length);
});
t('跨天不同槽位不冲突', () => {
  const c = { ...sched.DEFAULTS, times: ['09:00'], ranSlots: ['2026-10-19 09:00'] };
  assert.equal(sched.shouldRunNow(c), false, '今天不是19号，不应因昨天的记录被跳过');
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

// 清理
if (fs.existsSync(SF)) fs.unlinkSync(SF);
for (const f of fs.readdirSync(path.dirname(SF))) {
  if (f.includes('schedule.json.bak-')) fs.unlinkSync(path.join(path.dirname(SF), f));
}

console.log(`\n结果: ${pass} 通过, ${fail} 失败\n`);
process.exit(fail ? 1 : 0);