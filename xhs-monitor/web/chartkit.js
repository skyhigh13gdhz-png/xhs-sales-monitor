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

function axes(b, W, H, PL, PR, PT, PB, fmtY) {
  const iw = W - PL - PR, ih = H - PT - PB;
  const Y = v => PT + ih - ((v - b.vmin) / (b.vmax - b.vmin || 1)) * ih;
  const X = t => PL + ((t - b.tmin) / (b.tmax - b.tmin || 1)) * iw;

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
    xl.push(`<text x="${x}" y="${H - PB + 15}" font-size="11" text-anchor="middle" fill="var(--tx3)">${d.getMonth() + 1}/${d.getDate()}</text>`);
  }
  return { X, Y, grid: grid.join(''), xl: xl.join('') };
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

  const { X, Y, grid, xl } = axes(bb, W, H, PL, PR, PT, PB, fmtNum);
  const body = series.map(s => {
    const c = s.color;
    const pts = s.points.map(p => `${X(new Date(p.t).getTime()).toFixed(1)},${Y(p.v).toFixed(1)}`);
    if (pts.length === 1) {
      const [x, y] = pts[0].split(',');
      return `<circle cx="${x}" cy="${y}" r="3" fill="${c}"/>`;
    }
    return `<polyline points="${pts.join(' ')}" fill="none" stroke="${c}" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round"/>` +
      `<circle cx="${pts[pts.length - 1].split(',')[0]}" cy="${pts[pts.length - 1].split(',')[1]}" r="2.6" fill="${c}"/>`;
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

const ChartKit = { PALETTE, color, sumSeries, valueAt, toSteps, shortName, lineSvg, stepSvg, legend, bounds };

if (typeof module !== 'undefined' && module.exports) module.exports = ChartKit;
if (typeof window !== 'undefined') window.ChartKit = ChartKit;
