/*
周期聚合测试：每次 / 日 / 周 / 月
这些语义一旦错了，图看着正常但数字全是错的，所以钉死在测试里。
*/
const K = require('./web/chartkit.js');

let pass = 0, fail = 0;
function t(name, cond, extra) {
  if (cond) { console.log('  ✓ ' + name); pass++; }
  else { console.log('  ✗ ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); fail++; }
}
const vals = arr => arr.map(x => x.v);
const at = (h, d, mo) => new Date(2026, (mo || 9) - 1, d, h, 0, 0).toISOString();

/* 同一天多次采集、跨天、跨周、跨月各造一份 */
const DAY = [
  { t: at(9, 20), v: 100 },
  { t: at(12, 20), v: 110 },
  { t: at(21, 20), v: 130 }
];

console.log('\n[按日聚合：一天只留最后一个点]');
{
  const c = K.cumulativeByPeriod(DAY, 'day');
  t('一天内的 3 次采集合成 1 个点', c.length === 1, c.length);
  t('取的是当天最后一次的值', vals(c)[0] === 130, vals(c));
  t('周期起点是当天 00:00', new Date(c[0].t).getHours() === 0, c[0].t);
}

console.log('\n[按日增量：本日最后 − 前一日最后；首日按期内起算]');
{
  const pts = [
    { t: at(10, 19), v: 100 },
    { t: at(22, 19), v: 110 },   // 10-19 最后 = 110
    { t: at(9, 20), v: 120 },
    { t: at(21, 20), v: 150 }    // 10-20 最后 = 150
  ];
  const d = K.deltaByPeriod(pts, 'day');
  t('两天数据 → 2 个增量（首日也要能看出涨了多少）', d.length === 2, d.length);
  t('首日 = 110 − 100 = 10，且标了 firstBasis', vals(d)[0] === 10 && d[0].firstBasis === true, d[0]);
  t('次日 = 150 − 110 = 40，不带 firstBasis', vals(d)[1] === 40 && !d[1].firstBasis, d[1]);
  t('合计 = 150 − 100，每件都恰好归到某一天',
    vals(d).reduce((a, v) => a + v, 0) === 50, vals(d));
}

console.log('\n[周期增量不对"周期起点变低"做特殊处理]');
{
  // 昨天最后 1661，今天 00:15 是 1647，今天 10:00 回到 1660
  // 旧实现会把 1647 当基点 → +13；现在按"上周期最后"算 → −1
  // （1647 这种降下去又涨回来的读数，属于过期读数，上游 soldSeries 会剔除，
  //   真到不了这里；这里验证的是"万一它还在，也不会被当成新起点"）
  const pts = [
    { t: at(23, 20), v: 1661 },
    { t: at(0, 21), v: 1647 },
    { t: at(10, 21), v: 1660 }
  ];
  const d = K.deltaByPeriod(pts, 'day');
  t('今天 = 1660 − 1661 = −1（不拿掉下来的 1647 当基点）', vals(d)[0] === -1, vals(d));
}

console.log('\n[首周期只有一个点：算不出来就跳过，不编 0]');
{
  const d = K.deltaByPeriod([{ t: at(10, 20), v: 500 }], 'day');
  t('只有一个周期 → 没有增量点', d.length === 0, d.length);
  const d2 = K.deltaByPeriod([], 'day');
  t('空序列 → 空', d2.length === 0);
}

console.log('\n[每次采集：相邻两次之差]');
{
  const d = K.deltaByPeriod(DAY, 'each');
  t('3 次采集 → 2 个增量', d.length === 2, d.length);
  t('增量是 10 和 20', JSON.stringify(vals(d)) === '[10,20]', vals(d));
  const c = K.cumulativeByPeriod(DAY, 'each');
  t('each 模式累计保留每一次采集', c.length === 3, c.length);
}

console.log('\n[跨周：周一为起点]');
{
  // 不写死星期几：从库函数自己推出的周一往后构造，避免年份一变就误判
  const monMs = K.bucketStart(new Date(2026, 9, 19).getTime(), 'week');
  const mon = new Date(monMs);
  const day = n => { const d = new Date(mon); d.setDate(d.getDate() + n); return d; };
  t('周期起点确实是周一', mon.getDay() === 1, mon.toDateString());

  const pts = [
    { t: day(0).toISOString(), v: 100 },   // 周一
    { t: day(3).toISOString(), v: 120 },   // 周四
    { t: day(6).toISOString(), v: 150 },   // 周日，同周最后
    { t: day(7).toISOString(), v: 180 }    // 下周一
  ];
  const c = K.cumulativeByPeriod(pts, 'week');
  t('同周 3 天合成 1 点，跨周再 1 点 → 2 点', c.length === 2, c.map(x => K.fmtBucket(x.t, 'week')));
  t('第一周取周日最后值 150', vals(c)[0] === 150, vals(c));
  t('第二周取 180', vals(c)[1] === 180, vals(c));
  const d = K.deltaByPeriod(pts, 'week');
  t('第一周按期内起算：150 − 100 = 50（标 firstBasis）', vals(d)[0] === 50 && d[0].firstBasis === true, d[0]);
  t('第二周 = 180 − 150 = 30', vals(d)[1] === 30, vals(d));
}

console.log('\n[跨月]');
{
  const pts = [
    { t: new Date(2026, 8, 30, 10).toISOString(), v: 100 },
    { t: new Date(2026, 9, 1, 10).toISOString(), v: 130 },
    { t: new Date(2026, 9, 31, 10).toISOString(), v: 200 }
  ];
  const c = K.cumulativeByPeriod(pts, 'month');
  t('9 月 1 点、10 月 1 点', c.length === 2, c.map(x => x.t));
  t('10 月取最后 200', vals(c)[1] === 200, vals(c));
  const d = K.deltaByPeriod(pts, 'month');
  t('月增量 = 130 − 100… 应为 100', vals(d)[0] === 100, vals(d));
}

console.log('\n[乱序输入也要正确]');
{
  const shuffled = [
    { t: at(21, 20), v: 130 },
    { t: at(9, 20), v: 100 },
    { t: at(12, 20), v: 110 }
  ];
  const c = K.cumulativeByPeriod(shuffled, 'day');
  t('未按时间排序也能取到最后一次', vals(c)[0] === 130, vals(c));
}

console.log('\n[脏数据不应污染结果]');
{
  const pts = [{ t: at(9, 20), v: null }, { t: at(12, 20), v: 88 }];
  const c = K.cumulativeByPeriod(pts, 'day');
  t('null 值被丢弃', c.length === 1 && vals(c)[0] === 88, c);
  t('全脏数据 → 空', K.cumulativeByPeriod([{ t: at(9, 20), v: null }], 'day').length === 0);
}

/*
店铺/分组的周期增量：先按品算，再相加。
反着做（先把各品累计值求和、再跨周期相减）在「某品缺上一期」时会炸得很离谱，
真实事故就发生在这里：新加一个已售 1635 的商品，店铺当天凭空多了 1635 件。
*/
console.log('\n[店铺周期增量：先按品算，再相加]');
{
  // 事故复刻：眼罩昨天 54000，今天还是 54000；11:27 新加一个已售 1635 的商品
  const A = [{ t: at(21, 20), v: 54000 }, { t: at(11, 21), v: 54000 }];
  const B = [{ t: at(11, 21), v: 1635 }, { t: at(13, 21), v: 1635 }];

  // 先求和再相减（错误做法）会得到什么
  const wrong = K.deltaByPeriod(K.sumSeries([A, B]), 'day');
  t('错误做法确实会算出 +1635（复刻事故）', vals(wrong)[0] === 1635, wrong);

  const right = K.sumDeltas([A, B], 'day');
  t('正确做法是 0（新品一件没卖，只是刚被纳入监控）', vals(right).length === 1 && vals(right)[0] === 0, right);
  t('合计不再是「它一辈子的销量」', vals(right).reduce((a, v) => a + v, 0) === 0, vals(right));
}

console.log('\n[店铺周期增量：多品都涨时，与逐品相加一致]');
{
  const A = [{ t: at(9, 20), v: 100 }, { t: at(21, 20), v: 110 }, { t: at(21, 21), v: 130 }];
  const B = [{ t: at(12, 20), v: 500 }, { t: at(12, 21), v: 520 }];
  const d = K.sumDeltas([A, B], 'day');
  // 10-20：A 从 100 涨到 110 = 10；B 当天只有一条读数，算不出来 → 不参与，也不编 0 影响别人
  t('第一天 = 10（B 当天只有一条读数，不能把 500 全算成当天销量）', vals(d)[0] === 10, d);
  // 10-21：A 130 − 110 = 20；B 520 − 500 = 20
  t('第二天 = 20 + 20 = 40', vals(d)[1] === 40, d);
}

console.log('\n[店铺周期增量：空心点只在全是起算点时标]');
{
  const A = [{ t: at(9, 20), v: 100 }, { t: at(9, 21), v: 110 }];   // 21 号有真基线
  const B = [{ t: at(9, 21), v: 500 }, { t: at(12, 21), v: 505 }];    // 21 号才起算
  const d = K.sumDeltas([A, B], 'day');
  t('21 号合计 = 10 + 5 = 15', vals(d)[0] === 15, d);
  t('有真基线就不标空心点', d[0].firstBasis === false, d[0]);

  const only = K.sumDeltas([
    [{ t: at(9, 21), v: 100 }, { t: at(12, 21), v: 110 }],
    [{ t: at(9, 21), v: 500 }, { t: at(12, 21), v: 505 }]
  ], 'day');
  t('全部都是起算点时才标空心点', only[0].firstBasis === true && vals(only)[0] === 15, only[0]);
}

console.log('\n[店铺周期增量：单条序列时与 deltaByPeriod 等价]');
{
  const A = [{ t: at(9, 20), v: 100 }, { t: at(21, 20), v: 130 }, { t: at(21, 21), v: 150 }];
  const a = K.deltaByPeriod(A, 'day'), b = K.sumDeltas([A], 'day');
  t('逐点数值一致', JSON.stringify(vals(a)) === JSON.stringify(vals(b)), { a: vals(a), b: vals(b) });
  t('firstBasis 也一致', a.map(x => !!x.firstBasis).join() === b.map(x => !!x.firstBasis).join(), b);
  t('空输入 → 空', K.sumDeltas([], 'day').length === 0 && K.sumDeltas([[], []], 'day').length === 0);
}

console.log('\n[取数窗口随周期放大]');
{
  t('日 → 31 天', K.periodDays('day') === 31);
  t('周 → 120 天', K.periodDays('week') === 120);
  t('月 → 400 天', K.periodDays('month') === 400);
  t('每次 → 30 天', K.periodDays('each') === 30);
  t('未知周期退回 31', K.periodDays('xx') === 31);
}

console.log('\n[数值标签抽稀]');
{
  t('点少时全标', JSON.stringify(K.labelIndexes(3, 8)) === '[0,1,2]');
  const idx = K.labelIndexes(16, 8);
  t('点多时不超过 9 个', idx.length <= 9, idx.length);
  t('最后一个点必标（最新值最关心）', idx[idx.length - 1] === 15, idx);
  t('下标递增且不重复', idx.every((v, i) => i === 0 || v > idx[i - 1]), idx);
  t('空序列返回空', K.labelIndexes(0, 8).length === 0);
}

console.log('\n[折线图带数值标签]');
{
  const s = [{ name: 'A', color: '#000', points: [{ t: at(9, 20), v: 100 }, { t: at(21, 20), v: 150 }] }];
  const svg = K.lineSvg(s, { values: true });
  t('开启了标签就有 <text> 数值', /<text[^>]*>100<\/text>/.test(svg) && /<text[^>]*>150<\/text>/.test(svg), svg && svg.slice(0, 120));
  t('每个点都有圆点', (svg.match(/<circle/g) || []).length === 2, (svg.match(/<circle/g) || []).length);
  const bare = K.lineSvg(s, {});
  t('不开启时只有末点一个圆', (bare.match(/<circle/g) || []).length === 1, (bare.match(/<circle/g) || []).length);
  t('不开启时不画数值', !/>150</.test(bare));
}

console.log('\n[X 轴文案随周期变化]');
{
  t('月 → 2026-10', K.fmtBucket(new Date(2026, 9, 5).toISOString(), 'month') === '2026-10');
  t('周 → 带"起"', /起$/.test(K.fmtBucket(new Date(2026, 9, 5).toISOString(), 'week')));
  t('日 → 10/5', K.fmtBucket(new Date(2026, 9, 5).toISOString(), 'day') === '10/5');
  t('每次 → 带时分', /\d{2}:\d{2}$/.test(K.fmtBucket(new Date(2026, 9, 5, 14, 30).toISOString(), 'each')));
}

/* 真实问题：只有两天数据时，横轴曾画成「10/20 10/20 10/21 10/21」，
   因为旧实现是在整段范围上等距插 4 个刻度再各自格式化。 */
console.log('\n[X 轴标签不重复、按数据点打]');
{
  const bottom = svg => [...svg.matchAll(/<text x="[\d.]+" y="195"[^>]*>([^<]*)<\/text>/g)].map(m => m[1]);
  const pts = [{ t: at(20, 20, 10), v: 100 }, { t: at(20, 21, 10), v: 120 }];   // 10/20、10/21 各一条
  const svg = K.lineSvg([{ name: 'A', color: '#000', points: pts }],
    { fmtX: t => K.fmtBucket(t, 'day') });
  const lab = bottom(svg);
  t('两个日期只画两个标签（不是四个）', lab.length === 2, lab);
  t('标签文案不重复', new Set(lab).size === lab.length, lab);
  t('正好是 10/20 与 10/21', lab.join(',') === '10/20,10/21', lab);

  // 点很多时按最小像素间距抽稀，且仍不重复
  const many = [];
  for (let i = 0; i < 12; i++) many.push({ t: new Date(2026, 8, 1 + i, 10).toISOString(), v: 100 + i });
  const svg2 = K.lineSvg([{ name: 'A', color: '#000', points: many }], { fmtX: t => K.fmtBucket(t, 'day') });
  const lab2 = bottom(svg2);
  t('12 个日期会被抽稀（不超过 12 个）', lab2.length > 0 && lab2.length <= 12, lab2.length);
  t('抽稀后仍不重复', new Set(lab2).size === lab2.length, lab2);
}

console.log('\n[首周期起算点：空心圈 + ≈]');
{
  const d = K.deltaByPeriod([{ t: at(10, 20), v: 100 }, { t: at(21, 20), v: 130 }], 'day');
  const svg = K.lineSvg([{ name: 'A', color: '#000', points: d }], {
    values: true, fmtV: v => (v > 0 ? '+' : '') + Math.round(v)
  });
  t('起算点画成空心圈（填充是背景色）', /fill="var\(--bg\)" stroke="#000"/.test(svg), svg.slice(0, 200));
  t('起算点数值带 ≈ 前缀', /≈\+30/.test(svg), (svg.match(/<text[^>]*>[^<]*<\/text>/g) || []).slice(-3));
}

console.log(`\n结果: ${pass} 通过, ${fail} 失败\n`);
process.exit(fail ? 1 : 0);
