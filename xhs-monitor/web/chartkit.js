/*
多序列折线/阶梯图组件 + 序列聚合
纯函数，无 DOM 依赖，可用 node 直接测试（浏览器里挂到 window.ChartKit）
*/

const PALETTE = [
  '#2F9E8F', '#4C7DD9', '#D98A2B', '#B4559E',
  '#5C9E3D', '#C4553B', '#7A6BD9', '#3FA3B5'
];

function color(i) { return PALETTE[i % PALETTE.length]; }

/* 在各序列时间点的并集上取值；某序列在某时刻还没数据就跳过它（不当 0 算） */
function sumSeries(seriesList) {
  const list = (seriesList || []).filter(s => Array.isArray(s) && s.length);
  if (!list.length) return [];
  const tsSet = new Set();
  for (const s of list) for (const p of s) tsSet.add(new Date(p.t).getTime());
  const ts = [...tsSet].sort((a, b) => a - b);

  const out = [];
  for (const t of ts) {
    let sum = 0, has = false;
    for (const s of list) {
      const v = valueAt(s, t);
      if (v !== null) { sum += v; has = true; }
    }
    if (has) out.push({ t: new Date(t).toISOString(), v: sum });
  }
  return out;
}

/* 某序列在时刻 t 的取值（取 t 之前最后一个已知值） */
function valueAt(points, t) {
  let v = null;
  for (const p of points) {
    if (new Date(p.t).getTime() <= t) v = p.v; else break;
  }
  return v;
}

/* 价格序列 → 阶梯顶点。值不变时不产生新顶点，只在变化处跳变 */
function toSteps(points) {
  const out = [];
  for (const p of points) {
    if (!out.length || out[out.length - 1].v !== p.v) out.push({ t: p.t, v: p.v });
  }
  return out;
}

function shortName(name, max) {
  const s = String(name || '').trim()
    .replace(/^【[^】]*】/, '')          // 去掉【品牌】前缀
    .replace(/[（(][^）)]*[）)]/g, '')   // 去掉括号里的规格说明
    .replace(/\s+/g, '')
    .trim();
  const n = max || 10;
  return s.length > n ? s.slice(0, n) + '…' : s;
}

/* ---------- 周期聚合：每次 / 日 / 周 / 月 ---------- */

const PERIODS = ['each', 'day', 'week', 'month'];
const PERIOD_TEXT = { each: '每次采集', day: '按日', week: '按周', month: '按月' };

function startOfDay(d) { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; }
function startOfWeek(d) {                      // 周一为一周起点
  const x = startOfDay(d);
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7));
  return x;
}
function startOfMonth(d) { const x = startOfDay(d); x.setDate(1); return x; }

/* 时刻 t 所属周期的起始时间戳；'each' 就是原采集时刻本身 */
function bucketStart(t, period) {
  const d = new Date(t);
  if (period === 'week') return startOfWeek(d).getTime();
  if (period === 'month') return startOfMonth(d).getTime();
  if (period === 'day') return startOfDay(d).getTime();
  return d.getTime();
}

/* 每个周期只留一个点：取该周期内最后一次采集的累计值。
   跨周期不补 0 —— 没采到就是没采到。 */
function cumulativeByPeriod(points, period) {
  const p = period || 'day';
  const sorted = [...(points || [])]
    .filter(x => x && x.v !== null && x.v !== undefined && x.t)
    .sort((a, b) => new Date(a.t) - new Date(b.t));
  if (!sorted.length) return [];

  if (p === 'each') {
    return sorted.map(x => ({ t: new Date(x.t).toISOString(), v: x.v }));
  }
  const map = new Map();
  for (const x of sorted) map.set(bucketStart(x.t, p), x.v);   // 后写覆盖 → 周期内最后一个
  return [...map.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([t, v]) => ({ t: new Date(t).toISOString(), v }));
}

/*
每周期的增量，与「今日增量」「组内合计」同一套口径：
  本周期增量 = 本周期最后一次 − 上一周期最后一次。
  不再对"周期起点数字变低"做特殊处理——曾经以为那是平台剔除退款，
  实测是 0 点前后读到了旧快照（降下去又涨回来），上游已经把这类读数剔除，
  这里如果还按"掉下来的值"当基点，就会把当天销量整体抬高。
第一个周期没有上期：用「期内第一次」当基线并标 firstBasis（图上画空心圈 + ≈），
  不然从开始监控到第一个周期结束卖的量会整段看不见——只有两三天数据时尤其明显。
周期内只有一个点、又没上期 → 算不出来，跳过（不编 0）。
*/
function deltaByPeriod(points, period) {
  const p = period || 'day';
  const sorted = [...(points || [])]
    .filter(x => x && x.v !== null && x.v !== undefined && x.t)
    .sort((a, b) => new Date(a.t) - new Date(b.t));
  if (!sorted.length) return [];

  const groups = new Map();
  for (const x of sorted) {
    const k = bucketStart(x.t, p);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(x);
  }
  const keys = [...groups.keys()].sort((a, b) => a - b);

  const out = [];
  for (let i = 0; i < keys.length; i++) {
    const g = groups.get(keys[i]);
    const last = g[g.length - 1].v;
    const prevKey = i > 0 ? keys[i - 1] : null;
    const prevLast = prevKey === null ? null : groups.get(prevKey)[groups.get(prevKey).length - 1].v;

    let base = null, firstBasis = false;
    if (prevLast !== null) {
      base = prevLast;
    } else if (g.length > 1) {
      base = g[0].v;
      firstBasis = true;
    }
    if (base === null) continue;
    out.push({ t: new Date(keys[i]).toISOString(), v: last - base, firstBasis });
  }
  return out;
}

/*
店铺 / 分组的周期增量：**先按每个商品算出本周期增量，再按周期相加**。

不能反过来（先把各品累计值求和，再跨周期相减）。两者在「所有品都有上一期基线」时
结果相同，一旦某品缺上一期就天差地别：
  今天中午新加一个已售 1635 的商品 → 店铺累计值当场从 54000 跳到 55635，
  跨期相减会得出「这个店今天卖了 1635 件」，而那 1635 是人家一辈子的量。
按品先算就没有这个问题：新品本期只有一条读数 → 算不出增量 → 记 0。

周期内只有一条读数、又没有上期的品直接跳过（不编 0），所以不影响其它品。
空心点只在「该周期内参与相加的点全都是 firstBasis」时才标 —— 只要有一个品有真基线，
这个合计就是站得住的。
*/
function sumDeltas(seriesList, period) {
  const p = period || 'day';
  const acc = new Map();   // bucket 起点 → { v, allFirst, n }
  for (const pts of (seriesList || [])) {
    for (const d of deltaByPeriod(pts, p)) {
      const k = new Date(d.t).getTime();
      let o = acc.get(k);
      if (!o) { o = { v: 0, allFirst: true, n: 0 }; acc.set(k, o); }
      o.v += d.v;
      o.n += 1;
      if (!d.firstBasis) o.allFirst = false;
    }
  }
  return [...acc.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([t, o]) => ({ t: new Date(t).toISOString(), v: o.v, firstBasis: o.allFirst }));
}

/* 周期起点的显示文案 */
function fmtBucket(t, period) {
  const d = new Date(t);
  const mm = String(d.getMonth() + 1), dd = String(d.getDate());
  if (period === 'month') return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
  if (period === 'week') return mm + '/' + dd + ' 起';
  if (period === 'each') return mm + '/' + dd + ' ' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  return mm + '/' + dd;
}

/* 周期对应的取数窗口（天）：周/月要看更长，不然只有一两个点 */
function periodDays(period) {
  return { each: 30, day: 31, week: 120, month: 400 }[period || 'day'] || 31;
}

/* 统一的时间/数值范围 */
function bounds(series, key) {
  let tmin = Infinity, tmax = -Infinity, vmin = Infinity, vmax = -Infinity;
  for (const s of series) {
    for (const p of (s[key] || [])) {
      const t = new Date(p.t).getTime();
      if (t < tmin) tmin = t;
      if (t > tmax) tmax = t;
      if (p.v < vmin) vmin = p.v;
      if (p.v > vmax) vmax = p.v;
    }
  }
  if (!isFinite(tmin)) return null;
  if (tmin === tmax) { tmin -= 36e5; tmax += 36e5; }   // 单点也画得出来
  if (vmin === vmax) { const d = Math.max(Math.abs(vmin) * 0.08, 1); vmin -= d; vmax += d; }
  return { tmin, tmax, vmin, vmax };
}

/*
横轴标签：优先打在真实数据点上（tickTimes），没给才退回等距插值。
两种情况都要去重——两天数据若在整段范围上等距插 4 个刻度，
会画成「10/20 10/20 10/21 10/21」，看着像同一天出现了两次。
规则：同一文案只画一次；与前一个标签像素间距不足就省略。
窄屏（narrow）时最小间距按画布宽度缩，否则标签会互相挤掉。
*/
function pickTicks(X, fx, times, PL, W, PR, minGap) {
  const out = [];
  const gap = minGap || 44;
  for (const t of times) {
    const x = X(t);
    if (x < PL - 1 || x > W - PR + 1) continue;
    const text = fx(t);
    const prev = out[out.length - 1];
    if (prev && (prev.text === text || x - prev.x < gap)) continue;
    out.push({ x, text });
  }
  return out;
}

function axes(b, W, H, PL, PR, PT, PB, fmtY, fmtX, tickTimes, narrow) {
  const iw = W - PL - PR, ih = H - PT - PB;
  const Y = v => PT + ih - ((v - b.vmin) / (b.vmax - b.vmin || 1)) * ih;
  const X = t => PL + ((t - b.tmin) / (b.tmax - b.tmin || 1)) * iw;
  const fx = fmtX || (t => {
    const d = new Date(t);
    return (d.getMonth() + 1) + '/' + d.getDate();
  });

  const rows = 3;
  const grid = [];
  for (let i = 0; i < rows; i++) {
    const v = b.vmin + ((b.vmax - b.vmin) * i) / (rows - 1);
    const y = Y(v).toFixed(1);
    grid.push(`<line x1="${PL}" y1="${y}" x2="${W - PR}" y2="${y}" stroke="var(--line)" stroke-width="0.5"/>` +
      `<text x="${PL - 8}" y="${y}" font-size="11" text-anchor="end" dominant-baseline="central" fill="var(--tx3)">${fmtY(v)}</text>`);
  }

  const times = (tickTimes && tickTimes.length) ? tickTimes : (() => {
    const n = 4, a = [];
    for (let i = 0; i < n; i++) a.push(b.tmin + ((b.tmax - b.tmin) * i) / (n - 1));
    return a;
  })();
  // 窄屏放不下 44px 的标签间距，按可用宽度按比例收窄
  const minGap = narrow ? Math.max(30, Math.round((W - PL - PR) / 5)) : 44;
  const xl = pickTicks(X, fx, times, PL, W, PR, minGap).map(o => {
    // 两端的标签改成贴边的锚点，否则「10/20」会被画布裁掉半个字
    const anchor = o.x < PL + 14 ? 'start' : (o.x > W - PR - 14 ? 'end' : 'middle');
    return `<text x="${o.x.toFixed(1)}" y="${H - PB + 15}" font-size="11" text-anchor="${anchor}" fill="var(--tx3)">${o.text}</text>`;
  }).join('');
  return { X, Y, grid: grid.join(''), xl };
}

/*
数值标签抽稀：点多了全标会糊成一片。
保留规则 —— 不超过 max 个，等距取样，且最后一个点必标（最新值往往最关心）。
返回需要标注的下标数组。
*/
function labelIndexes(n, max) {
  if (n <= 0) return [];
  const m = max || 8;
  if (n <= m) return [...Array(n).keys()];
  const step = Math.ceil(n / m);
  const idx = [];
  for (let i = 0; i < n; i += step) idx.push(i);
  if (idx[idx.length - 1] !== n - 1) idx.push(n - 1);
  return idx;
}

function fmtNum(v) {
  const n = Math.round(v);
  return Math.abs(n) >= 10000 ? (n / 10000).toFixed(1) + '万' : String(n);
}

/*
累计走势（折线）
series: [{ name, points:[{t,v}], color }]
*/
function lineSvg(series, opt) {
  const o = opt || {};
  // 画布宽度按实际渲染宽度给，而不是固定 680。
  // 固定宽度 + svg{width:100%} 会让窄屏把整张图等比缩小：680→344 时
  // 10.5px 的字实际只剩 5px，完全看不清（手机上两个图都"压扁"就是这个原因）。
  // 按容器实际像素宽出图，viewBox 与像素 1:1，字号才是真实字号。
  const W = Math.max(300, Math.round(o.width || 680));
  const narrow = W < 520;
  // 窄屏图更矮（宽度小），但线的条数不变 → 竖向要留更多空间，
  // 否则多条线的数值标签会叠在一起看不清
  const HH = o.height || (narrow ? 260 : 210);
  const PL = narrow ? 42 : 54, PR = narrow ? 10 : 16, PT = 16, PB = 30;
  const b = bounds(series, 'points');
  if (!b) return null;
  const pad = (b.vmax - b.vmin) * 0.15 || 1;
  const bb = { ...b, vmin: Math.max(0, b.vmin - pad), vmax: b.vmax + pad };

  const fmtV = o.fmtV || fmtNum;
  // 横轴按真实数据点打标签；多序列取时间并集，去重交给 pickTicks
  let xt = o.xticks;
  if (!xt || !xt.length) {
    const set = new Set();
    for (const s of series) for (const p of s.points || []) set.add(new Date(p.t).getTime());
    xt = [...set].sort((a, b) => a - b);
  }
  const { X, Y, grid, xl } = axes(bb, W, HH, PL, PR, PT, PB, fmtV, o.fmtX, xt, narrow);
  const body = series.map(s => {
    const c = s.color;
    const xy = s.points.map(p => ({
      x: X(new Date(p.t).getTime()), y: Y(p.v), v: p.v, t: p.t, firstBasis: !!p.firstBasis
    }));
    if (!xy.length) return '';

    // 数值用线的颜色 + 背景色描边：多序列时能一眼看出这个数属于哪条线
    const label = (x, y, v, approx) =>
      `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" font-size="10.5" text-anchor="middle" fill="${c}"` +
      ` stroke="var(--bg)" stroke-width="2.6" paint-order="stroke" stroke-linejoin="round">${approx ? '≈' : ''}${fmtV(v)}</text>`;

    // 起算点画成空心圈：它没有上期基线，含义与其它点不同
    const dot = (p, r) => p.firstBasis
      ? `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="${r - 0.4}" fill="var(--bg)" stroke="${c}" stroke-width="1.6"/>`
      : `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="${r}" fill="${c}"/>`;

    if (xy.length === 1) {
      const p = xy[0];
      return dot(p, 3) + (o.values ? label(p.x, p.y - 8, p.v, p.firstBasis) : '');
    }

    const line = `<polyline points="${xy.map(p => p.x.toFixed(1) + ',' + p.y.toFixed(1)).join(' ')}" fill="none" stroke="${c}" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round"/>`;

    if (!o.values) {
      const last = xy[xy.length - 1];
      return line + `<circle cx="${last.x.toFixed(1)}" cy="${last.y.toFixed(1)}" r="2.6" fill="${c}"/>`;
    }

    // 标数值时把每个点都点出来，文字只按抽稀规则标注，避免挤成一团
    const dots = xy.map(p => dot(p, 2.4)).join('');
    const labels = labelIndexes(xy.length, o.maxLabels)
      .map(i => {
        const p = xy[i];
        // 靠上的点标签放到下方，避免顶出画布
        return label(p.x, p.y + (p.y < PT + 14 ? 14 : -8), p.v, p.firstBasis);
      }).join('');
    return line + dots + labels;
  }).join('');

  return `<svg viewBox="0 0 ${W} ${HH}" width="${W}" height="${HH}" role="img" preserveAspectRatio="xMidYMid meet">${grid}${body}${xl}</svg>`;
}

/*
价格阶梯图（多序列）
series: [{ name, points:[{t,v}], color }]
值不变 → 水平线；值变化 → 垂直跳变
*/
function stepSvg(series, opt) {
  const o = opt || {};
  const W = Math.max(300, Math.round(o.width || 680));
  const narrow = W < 520;
  const HH = o.height || (narrow ? 220 : 200);
  const PL = narrow ? 46 : 56, PR = narrow ? 10 : 16, PT = 16, PB = 30;
  const steps = series.map(s => ({ ...s, steps: toSteps(s.points) })).filter(s => s.steps.length);
  const b = bounds(steps, 'steps');
  if (!b) return null;
  const pad = (b.vmax - b.vmin) * 0.18 || 1;
  const bb = { ...b, vmin: Math.max(0, b.vmin - pad), vmax: b.vmax + pad };

  const { X, Y, grid, xl } = axes(bb, W, HH, PL, PR, PT, PB, v => '¥' + (v < 100 ? v.toFixed(1) : Math.round(v)), null, narrow);

  const body = steps.map(s => {
    const path = [];
    s.steps.forEach((p, i) => {
      const x = X(new Date(p.t).getTime());
      if (i === 0) path.push([x, Y(p.v)]);
      else {
        path.push([x, Y(s.steps[i - 1].v)]);   // 水平延伸到变更时刻
        path.push([x, Y(p.v)]);                // 垂直跳变
      }
    });
    const endX = X(bb.tmax);
    const lastY = Y(s.steps[s.steps.length - 1].v);
    if (endX > path[path.length - 1][0]) path.push([endX, lastY]);
    const line = path.map(p => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ');
    const dots = s.steps.map(p => `<circle cx="${X(new Date(p.t).getTime()).toFixed(1)}" cy="${Y(p.v).toFixed(1)}" r="2.3" fill="${s.color}"/>`).join('');
    return `<polyline points="${line}" fill="none" stroke="${s.color}" stroke-width="1.8" stroke-linejoin="miter"/>${dots}`;
  }).join('');

  return `<svg viewBox="0 0 ${W} ${HH}" width="${W}" height="${HH}" role="img" preserveAspectRatio="xMidYMid meet">${grid}${body}${xl}</svg>`;
}

/* 图例：浏览器里用；返回 HTML 字符串 */
function legend(series, extra) {
  return (series || []).map(s =>
    `<span class="lg"><i style="background:${s.color}"></i>${s.name}${s.note ? `<b class="lgnote">${s.note}</b>` : ''}</span>`
  ).join('') + (extra || '');
}

const ChartKit = {
  PALETTE, PERIODS, PERIOD_TEXT, color, sumSeries, valueAt, toSteps, shortName,
  bucketStart, fmtBucket, cumulativeByPeriod, deltaByPeriod, sumDeltas, periodDays, labelIndexes, pickTicks,
  lineSvg, stepSvg, legend, bounds
};

if (typeof module !== 'undefined' && module.exports) module.exports = ChartKit;
if (typeof window !== 'undefined') window.ChartKit = ChartKit;
