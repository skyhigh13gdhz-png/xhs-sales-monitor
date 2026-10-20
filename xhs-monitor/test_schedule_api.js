const assert = require('assert');
const B = 'http://127.0.0.1:7788';

async function get(p) { const r = await fetch(B + p); return { status: r.status, body: await r.json().catch(() => ({})) }; }
async function post(p, o) {
  const r = await fetch(B + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(o || {}) });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}

let pass = 0, fail = 0;
const t = async (name, fn) => {
  try { await fn(); console.log('  ✓ ' + name); pass++; }
  catch (e) { console.log('  ✗ ' + name + '\n      ' + e.message); fail++; }
};

(async () => {
  console.log('\n[读取调度]');
  await t('GET /api/schedule 返回默认开启', async () => {
    const r = await get('/api/schedule');
    assert.equal(r.status, 200);
    assert.equal(r.body.enabled, true);
    assert.ok(Array.isArray(r.body.times));
  });
  await t('下次执行时间已计算', async () => {
    const r = await get('/api/schedule');
    assert.ok(r.body.nextRunText, 'nextRunText 应存在');
  });

  console.log('\n[修改调度]');
  await t('设置多个时间点', async () => {
    const r = await post('/api/schedule', { enabled: true, times: ['08:30', '14:00', '22:15'] });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.times, ['08:30', '14:00', '22:15']);
  });
  await t('时间点自动排序去重', async () => {
    const r = await post('/api/schedule', { times: ['22:15', '08:30', '08:30'] });
    assert.deepEqual(r.body.times, ['08:30', '22:15'], '实际 ' + JSON.stringify(r.body.times));
  });
  await t('非法时间被拒绝', async () => {
    const r = await post('/api/schedule', { times: ['25:00'] });
    assert.equal(r.status, 400);
    assert.ok(/时间格式/.test(r.body.error), r.body.error);
  });
  await t('关闭自动采集', async () => {
    const r = await post('/api/schedule', { enabled: false });
    assert.equal(r.body.enabled, false);
    assert.equal(r.body.nextRunText, null, '关闭后不应有下次执行时间');
  });
  await t('开启并设置启动即采集', async () => {
    const r = await post('/api/schedule', { enabled: true, runOnStart: true, times: ['09:00'] });
    assert.equal(r.body.enabled, true);
    assert.equal(r.body.runOnStart, true);
  });
  await t('恢复默认：09:00 与 21:00', async () => {
    const r = await post('/api/schedule', { enabled: true, runOnStart: false, times: ['09:00', '21:00'] });
    assert.deepEqual(r.body.times, ['09:00', '21:00']);
  });

  console.log('\n[状态接口含调度信息]');
  await t('state 返回 schedule 块', async () => {
    const r = await get('/api/state?days=7');
    assert.ok(r.body.schedule, '应含 schedule');
    assert.ok('nextRunText' in r.body.schedule);
    assert.ok(Array.isArray(r.body.autoLog));
  });
  await t('state 含 job.trigger 字段', async () => {
    const r = await get('/api/state');
    assert.ok('trigger' in r.body.job, '应含 trigger 区分手动/自动');
  });

  console.log('\n[收集后端]');
  await t('自动模式无商品时不报错', async () => {
    const st = await get('/api/state');
    if (st.body.totals.products === 0) {
      const r = await post('/api/collect', {});
      assert.ok(r.status === 200 || r.status === 400);
    } else {
      const r = await post('/api/collect', {});
      assert.equal(r.status, 200);
    }
  });

  console.log(`\n结果: ${pass} 通过, ${fail} 失败\n`);
  process.exit(fail ? 1 : 0);
})();