/*
分享文案解析测试（纯离线，不联网、不碰数据库）
重点是「链接必须被完整、准确地抠出来」——后面所有采集都依赖它。
*/
const assert = require('assert');
const { parseShareText } = require('./api_collect');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); pass++; }
  catch (e) { console.log('  ✗ ' + name + '\n      ' + e.message); fail++; }
}

console.log('\n[真实分享文案]');
const REAL = '【小红书】猫咪磁吸风铃冰箱贴 😆 nvJRp7r2K6 😆 https://xhslink.com/m/4T71eJQIwpB 点击链接或者复制本条信息打开【小红书app】查看 CZ6526';

t('能抠出短链', () => {
  assert.equal(parseShareText(REAL).url, 'https://xhslink.com/m/4T71eJQIwpB');
});
t('能从文案还原商品名', () => {
  assert.equal(parseShareText(REAL).title, '猫咪磁吸风铃冰箱贴');
});
t('不带出口令码 nvJRp7r2K6', () => {
  assert.ok(!parseShareText(REAL).title.includes('nvJRp'));
});
t('不带出结尾的 CZ6526', () => {
  assert.ok(!parseShareText(REAL).title.includes('CZ6526'));
});
t('不带出【小红书】前缀', () => {
  assert.ok(!parseShareText(REAL).title.includes('小红书'));
});
t('不带出「点击链接」等引导语', () => {
  assert.ok(!/点击链接|复制本条/.test(parseShareText(REAL).title));
});

console.log('\n[纯链接]');
t('商品详情页长链', () => {
  const r = parseShareText('https://www.xiaohongshu.com/goods-detail/6aacab557116f00001c2fca9');
  assert.equal(r.url, 'https://www.xiaohongshu.com/goods-detail/6aacab557116f00001c2fca9');
});
t('纯链接时标题为空（交给接口识别）', () => {
  assert.equal(parseShareText('https://xhslink.com/m/abc123').title, '');
});
t('链接前后带空格也能认', () => {
  assert.equal(parseShareText('  https://xhslink.com/m/abc123  ').url, 'https://xhslink.com/m/abc123');
});

console.log('\n[链接与中文紧贴]');
t('链接后面直接跟汉字，不能把汉字吞进 URL', () => {
  const r = parseShareText('https://xhslink.com/m/abc123点击链接打开小红书');
  assert.equal(r.url, 'https://xhslink.com/m/abc123');
});
t('中文在链接前面', () => {
  const r = parseShareText('猫咪冰箱贴https://xhslink.com/m/abc123');
  assert.equal(r.url, 'https://xhslink.com/m/abc123');
  assert.equal(r.title, '猫咪冰箱贴');
});

console.log('\n[其他常见格式]');
t('标题 + 链接', () => {
  const r = parseShareText('猫咪磁吸风铃冰箱贴 https://xhslink.com/m/4T71eJQIwpB');
  assert.equal(r.title, '猫咪磁吸风铃冰箱贴');
});
t('多行文本（标题在上、链接在下）', () => {
  const r = parseShareText('【小红书】好物分享\n复制本条信息，打开【小红书】App查看精彩内容！\nhttps://xhslink.com/a/abcdefg');
  assert.equal(r.url, 'https://xhslink.com/a/abcdefg');
  assert.equal(r.title, '好物分享');
});
t('链接在前、标题在后', () => {
  const r = parseShareText('https://xhslink.com/m/abc123 猫咪磁吸风铃冰箱贴');
  assert.equal(r.title, '猫咪磁吸风铃冰箱贴');
});
t('中英混排的商品名不会被拆坏', () => {
  const r = parseShareText('【小红书】iPad电容笔 平替 😆 Ab12Cd34 😆 https://xhslink.com/m/xyz123');
  assert.equal(r.title, 'iPad电容笔 平替');
});
t('多个链接取第一个', () => {
  const r = parseShareText('https://xhslink.com/m/first 和 https://xhslink.com/m/second');
  assert.equal(r.url, 'https://xhslink.com/m/first');
});
t('链接尾部标点要去掉', () => {
  assert.equal(parseShareText('看这个 https://xhslink.com/m/abc123，很好用').url, 'https://xhslink.com/m/abc123');
});

console.log('\n[无效输入]');
t('没有链接时 url 为空', () => {
  const r = parseShareText('这不是链接，只是随手一段文字');
  assert.equal(r.url, '');
  assert.equal(r.title, '');
});
t('空字符串不报错', () => {
  const r = parseShareText('');
  assert.deepEqual(r, { url: '', title: '' });
});
t('null / undefined 不报错', () => {
  assert.deepEqual(parseShareText(null), { url: '', title: '' });
  assert.deepEqual(parseShareText(undefined), { url: '', title: '' });
});
t('只有标题没有链接时不瞎猜', () => {
  assert.equal(parseShareText('【小红书】猫咪磁吸风铃冰箱贴').url, '');
});

console.log(`\n结果: ${pass} 通过, ${fail} 失败\n`);
process.exit(fail ? 1 : 0);
