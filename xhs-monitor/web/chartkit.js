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

/* 每周期的增量 = 本周期累计 − 上一周期累计。
   第一个周期没有基线，直接跳过（不编造 0）。 */
function deltaByPeriod(points, period) {
  const cum = cumulativeByPeriod(points, period);
  const out = [];
  for (let i = 1; i < cum.length; i++) {
    out.push({ t: cum[i].t, v: cum[i].v - cum[i - 1].v });
  }
  return out;
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

function axes(b, W, H, PL, PR, PT, PB, fmtY, fmtX) {
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

  const xl = [];
  const ticks = 4;
  for (let i = 0; i < ticks; i++) {
    const t = b.tmin + ((b.tmax - b.tmin) * i) / (ticks - 1);
    const x = X(t).toFixed(1);
    const d = new Date(t);
    xl.push(`<text x="${x}" y="${H - PB + 15}" font-size="11" text-anchor="middle" fill="var(--tx3)">${fx(t)}</text>`);
  }
  return { X, Y, grid: grid.join(''), xl: xl.join('') };
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
  const W = o.width || 680, H = o.height || 210, PL = 54, PR = 16, PT = 16, PB = 30;
  const b = bounds(series, 'points');
  if (!b) return null;
  const pad = (b.vmax - b.vmin) * 0.15 || 1;
  const bb = { ...b, vmin: Math.max(0, b.vmin - pad), vmax: b.vmax + pad };

  const fmtV = o.fmtV || fmtNum;
  const { X, Y, grid, xl } = axes(bb, W, H, PL, PR, PT, PB, fmtV, o.fmtX);
  const body = series.map(s => {
    const c = s.color;
    const xy = s.points.map(p => ({
      x: X(new Date(p.t).getTime()), y: Y(p.v), v: p.v, t: p.t
    }));
    if (!xy.length) return '';

    // 数值用线的颜色 + 背景色描边：多序列时能一眼看出这个数属于哪条线
    const label = (x, y, v) =>
      `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" font-size="10.5" text-anchor="middle" fill="${c}"` +
      ` stroke="var(--bg)" stroke-width="2.6" paint-order="stroke" stroke-linejoin="round">${fmtV(v)}</text>`;

    if (xy.length === 1) {
      const { x, y, v } = xy[0];
      const dot = `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="3" fill="${c}"/>`;
      return dot + (o.values ? label(x, y - 8, v) : '');
    }

    const line = `<polyline points="${xy.map(p => p.x.toFixed(1) + ',' + p.y.toFixed(1)).join(' ')}" fill="none" stroke="${c}" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round"/>`;

    if (!o.values) {
      const last = xy[xy.length - 1];
      return line + `<circle cx="${last.x.toFixed(1)}" cy="${last.y.toFixed(1)}" r="2.6" fill="${c}"/>`;
    }

    // 标数值时把每个点都点出来，文字只按抽稀规则标注，避免挤成一团
    const dots = xy.map(p => `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="2.4" fill="${c}"/>`).join('');
    const labels = labelIndexes(xy.length, o.maxLabels)
      .map(i => {
        const p = xy[i];
        // 靠上的点标签放到下方，避免顶出画布
        return label(p.x, p.y + (p.y < PT + 14 ? 14 : -8), p.v);
      }).join('');
    return line + dots + labels;
  }).join('');

  return `<svg viewBox="0 0 ${W} ${H}" role="img">${grid}${body}${xl}</svg>`;
}

/*
价格阶梯图（多序列）
series: [{ name, points:[{t,v}], color }]
值不变 → 水平线；值变化 → 垂直跳变
*/
function stepSvg(series, opt) {
  const o = opt || {};
  const W = o.width || 680, H = o.height || 200, PL = 56, PR = 16, PT = 16, PB = 30;
  const steps = series.map(s => ({ ...s, steps: toSteps(s.points) })).filter(s => s.steps.length);
  const b = bounds(steps, 'steps');
  if (!b) return null;
  const pad = (b.vmax - b.vmin) * 0.18 || 1;
  const bb = { ...b, vmin: Math.max(0, b.vmin - pad), vmax: b.vmax + pad };

  const { X, Y, grid, xl } = axes(bb, W, H, PL, PR, PT, PB, v => '¥' + (v < 100 ? v.toFixed(1) : Math.round(v)));

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

  return `<svg viewBox="0 0 ${W} ${H}" role="img">${grid}${body}${xl}</svg>`;
}

/* 图例：浏览器里用；返回 HTML 字符串 */
function legend(series, extra) {
  return (series || []).map(s =>
    `<span class="lg"><i style="background:${s.color}"></i>${s.name}${s.note ? `<b class="lgnote">${s.note}</b>` : ''}</span>`
  ).join('') + (extra || '');
}

const ChartKit = {
  PALETTE, PERIODS, PERIOD_TEXT, color, sumSeries, valueAt, toSteps, shortName,
  bucketStart, fmtBucket, cumulativeByPeriod, deltaByPeriod, periodDays, labelIndexes,
  lineSvg, stepSvg, legend, bounds
};

if (typeof module !== 'undefined' && module.exports) module.exports = ChartKit;
if (typeof window !== 'undefined') window.ChartKit = ChartKit;
