/*
分享文案添加商品的端到端测试（走真实接口，需要联网）
用临时库 + 临时端口，绝不碰 data/snapshots.json
*/
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

// 自启临时实例：原来依赖外部 7792 + 手动传 SHARE_TEST_DB，缺一个就静默跑不起来
const PORT = 7808;
const BASE = 'http://127.0.0.1:' + PORT;
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'xhs-shareapi.'));
const DB = path.join(TMP_DIR, 'db.json');
fs.writeFileSync(DB, JSON.stringify({ products: [], snapshots: [], groups: [] }, null, 2));

let server = null;
async function startServer() {
  server = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
    cwd: __dirname,
    env: { ...process.env, XHS_DB: DB, XHS_DATA_DIR: TMP_DIR, XHS_SCHEDULE: path.join(TMP_DIR, 'schedule.json'), XHS_AUTOLOG: path.join(TMP_DIR, 'auto-log.json'), PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  server.stdout.on('data', () => {});
  server.stderr.on('data', () => {});
  const t0 = Date.now();
  for (;;) {
    try { const r = await fetch(BASE + '/api/state'); if (r.ok) return; } catch (_) {}
    if (Date.now() - t0 > 20000) throw new Error('临时服务启动超时');
    await new Promise(r => setTimeout(r, 300));
  }
}
async function stopServer() { if (server) { try { server.kill(); } catch (_) {} } }

const RAW = '【小红书】猫咪磁吸风铃冰箱贴 😆 nvJRp7r2K6 😆 https://xhslink.com/m/4T71eJQIwpB 点击链接或者复制本条信息打开【小红书app】查看 CZ6526';

let pass = 0, fail = 0;
function t(name, cond, extra) {
  if (cond) { console.log('  ✓ ' + name); pass++; }
  else { console.log('  ✗ ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); fail++; }
}
async function post(path, body) {
  const r = await fetch(BASE + path, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  });
  return { status: r.status, body: await r.json() };
}

(async () => {
  await startServer();
  console.log('\n[整段分享文案添加商品]');
  const r1 = await post('/api/products', { raw: RAW });

  t('添加成功', r1.status === 200 && r1.body.ok === true, r1.body);
  t('名称来自接口（不是文案里的口令码）',
    typeof r1.body.name === 'string' && !/nvJRp|CZ6526/.test(r1.body.name) && r1.body.name.length > 0,
    r1.body.name);
  t('店铺已自动识别', typeof r1.body.shopName === 'string' && r1.body.shopName.length > 0, r1.body.shopName);
  t('已建立基线', typeof r1.body.baseline === 'number', r1.body.baseline);

  console.log('\n[去重]');
  const r2 = await post('/api/products', { raw: RAW });
  t('同一段文案重复添加被拦', r2.status === 400 && /已经在监控列表/.test(r2.body.error), r2.body);

  // 用商品ID构造另一种链接形式，验证「同一商品不同链接」也能拦住
  const db = JSON.parse(fs.readFileSync(DB, 'utf8'));
  const created = db.products.find(p => p.id === r1.body.id);
  t('商品档案记录了 itemId', !!created && !!created.itemId, created && created.itemId);

  if (created && created.itemId) {
    const canonical = 'https://www.xiaohongshu.com/goods-detail/' + created.itemId;
    const r3 = await post('/api/products', { raw: canonical });
    t('换成商品详情页长链也被拦（按 itemId 去重）',
      r3.status === 400 && /已经在监控列表/.test(r3.body.error), r3.body);

    const r4 = await post('/api/products', { raw: '标题在前 ' + canonical });
    t('长链外面再包一层文字也被拦',
      r4.status === 400 && /已经在监控列表/.test(r4.body.error), r4.body);
  }

  console.log('\n[非法输入]');
  const r5 = await post('/api/products', { raw: '这不是链接，只是随手一段文字' });
  t('没有链接时给出明确提示', r5.status === 400 && /没有找到链接/.test(r5.body.error), r5.body);

  const r6 = await post('/api/products', { raw: '' });
  t('空输入被拒', r6.status === 400, r6.body);

  console.log('\n[落库检查]');
  const db2 = JSON.parse(fs.readFileSync(DB, 'utf8'));
  const mine = db2.products.filter(p => p.url === 'https://xhslink.com/m/4T71eJQIwpB');
  t('只写入一条商品记录', mine.length === 1, mine.length);
  const snaps = db2.snapshots.filter(s => s.productId === r1.body.id);
  t('基线快照已写入', snaps.length === 1 && typeof snaps[0].soldTotal === 'number', snaps.length);
  t('快照带上了到手价', snaps.length === 1 && typeof snaps[0].price === 'number', snaps[0] && snaps[0].price);

  console.log(`\n结果: ${pass} 通过, ${fail} 失败\n`);
  await stopServer();
  process.exit(fail ? 1 : 0);
})().catch(async e => {
  console.error('测试异常：', e.message);
  await stopServer();
  process.exit(1);
});
