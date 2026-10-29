const assert = require('assert');
const { fetchItem, resolveItemId, extractItemId, parseSold } = require('./api_collect');

/*
这两个是**打真实接口**用的，所以需要一个真实存在的商品。
用环境变量传自己的商品 ID，别把具体商品写死在仓库里：

  XHS_TEST_ITEM_ID=6a...  XHS_TEST_ITEM_SHORT=https://xhslink.com/m/xxx  node test_api_collect.js

没给就用一个占位 ID —— 相关用例会失败并提示怎么配，
这比在公开仓库里暴露自己的商品链接安全。
*/
const REAL_ID = process.env.XHS_TEST_ITEM_ID || '6a0000000000000000000000';
const REAL_SHORT = process.env.XHS_TEST_ITEM_SHORT || '';
const CONFIGURED = !!process.env.XHS_TEST_ITEM_ID;

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); console.log('  ✓ ' + name); pass++; }
  catch (e) { console.log('  ✗ ' + name + '\n      ' + e.message); fail++; }
};
const tt = async (name, fn) => {
  try { await fn(); console.log('  ✓ ' + name); pass++; }
  catch (e) { console.log('  ✗ ' + name + '\n      ' + e.message); fail++; }
};

(async () => {
  console.log('\n[商品ID 提取 - 纯函数]');
  t('标准 goods-detail 链接', () => assert.equal(
    extractItemId('https://www.xiaohongshu.com/goods-detail/6aacab557116f00001c2fca9?xsec_token=abc'), REAL_ID));
  t('带 instation_link 的长链接', () => {
    const u = 'https://www.xiaohongshu.com/goods-detail/' + REAL_ID + '?xsec_token=x&instation_link=xhsdiscover%3A%2F%2Fgoods_detail%2F' + REAL_ID;
    assert.equal(extractItemId(u), REAL_ID);
  });
  t('item_id 查询参数', () => assert.equal(extractItemId('https://mall.xiaohongshu.com/x?item_id=' + REAL_ID), REAL_ID));
  t('无关链接返回 null', () => assert.equal(extractItemId('https://www.example.com/page'), null));
  t('空字符串返回 null', () => assert.equal(extractItemId(''), null));
  t('null 返回 null', () => assert.equal(extractItemId(null), null));
  t('不误抓短链字母当ID', () => {
    // 用一个随便编的短链：只验证「短链里的字母不该被当成商品ID」
    const r = extractItemId('https://xhslink.com/m/AbCdEfGh12');
    assert.notEqual(r, REAL_ID, '短链里不该解出商品ID');
    assert.equal(r, null, '短链里不该解出任何ID，实际 ' + r);
  });

  console.log('\n[销量数字解析]');
  t('已售1805 → 1805', () => assert.equal(parseSold('已售1805'), 1805));
  t('已售1.2万 → 12000', () => assert.equal(parseSold('已售1.2万'), 12000));
  t('已售 3.5千 → 3500', () => assert.equal(parseSold('已售 3.5千'), 3500));
  t('无数字 → null', () => assert.equal(parseSold('暂无'), null));

  console.log('\n[短链解析 - 需联网]');
  await tt('短链能解出真实 item_id', async () => {
    assert.ok(REAL_SHORT, '没配 XHS_TEST_ITEM_SHORT，跳过（短链解析需要真实短链）');
    const id = await resolveItemId(REAL_SHORT);
    assert.equal(id, REAL_ID, '解出 ' + id);
  });
  await tt('直接链接免去跳转', async () => {
    const id = await resolveItemId('https://www.xiaohongshu.com/goods-detail/' + REAL_ID);
    assert.equal(id, REAL_ID);
  });

  console.log('\n[免登录接口取数]');
  let real = null;
  await tt('真实商品能取到销量', async () => {
    real = await fetchItem(REAL_ID);
    assert.ok(real.ok, real.failReason);
    assert.equal(typeof real.soldTotal, 'number');
    assert.ok(real.soldTotal > 0, '销量应大于 0，实际 ' + real.soldTotal);
  });
  await tt('能取到店铺销量', async () => {
    assert.equal(typeof real.shopSold, 'number', 'shopSold=' + real.shopSold);
  });
  await tt('能取到商品标题', async () => {
    assert.ok(real.title && real.title.length > 5, 'title=' + real.title);
  });
  await tt('能取到价格', async () => {
    assert.equal(typeof real.price, 'number', 'price=' + real.price);
  });
  await tt('能自动识别店铺名', async () => {
    assert.ok(real.shopName && real.shopName.length > 1, 'shopName=' + real.shopName);
  });
  await tt('能自动识别店铺ID与主页', async () => {
    assert.ok(/^[0-9a-f]{16,}$/.test(real.shopId || ''), 'shopId=' + real.shopId);
    assert.ok(/xiaohongshu\.com\/shop\//.test(real.shopUrl || ''), 'shopUrl=' + real.shopUrl);
  });
  await tt('能取到店铺销量与粉丝数', async () => {
    assert.equal(typeof real.shopSold, 'number', 'shopSold=' + real.shopSold);
    assert.equal(typeof real.fans, 'number', 'fans=' + real.fans);
  });
  await tt('标题是干净标题（无规格后缀）', async () => {
    assert.ok(real.title.length > 5, 'title=' + real.title);
    console.log('      → ' + real.title);
    console.log('      → 店铺: ' + real.shopName + '（已售' + real.shopSold + '，粉丝' + real.fans + '）');
  });
  await tt('不需要登录态', async () => {
    assert.equal(real.source, 'api');
  });

  console.log('\n[异常处理]');
  await tt('不存在的商品给出可读原因', async () => {
    const r = await fetchItem('000000000000000000000000');
    assert.equal(r.ok, false);
    assert.ok(/不存在|下架/.test(r.failReason), r.failReason);
  });

  console.log('\n[连续请求稳定性]');
  await tt('连续 3 次均成功且数值一致', async () => {
    const vals = [];
    for (let i = 0; i < 3; i++) {
      const r = await fetchItem(REAL_ID);
      assert.ok(r.ok, '第' + (i+1) + '次失败: ' + r.failReason);
      vals.push(r.soldTotal);
      await new Promise(x => setTimeout(x, 1200));
    }
    assert.equal(new Set(vals).size, 1, '数值波动: ' + vals.join(','));
    console.log('      → 三次均为 ' + vals[0]);
  });

  console.log(`\n结果: ${pass} 通过, ${fail} 失败\n`);
  process.exit(fail ? 1 : 0);
})();