const fs = require('fs');
const path = require('path');

/*
配置文件的位置必须可被测试隔离。
测试会设置 XHS_DB 指向临时库；这时把 schedule.json 一并放进那个临时目录，
避免测试动到用户的真实定时设置（曾经真的被删过一次）。
优先顺序：XHS_SCHEDULE > XHS_DATA_DIR > XHS_DB 所在目录 > 项目 data/
*/
const DATA_DIR = process.env.XHS_DATA_DIR
  || (process.env.XHS_DB ? path.dirname(process.env.XHS_DB) : path.join(__dirname, 'data'));
const scheduleFile = process.env.XHS_SCHEDULE || path.join(DATA_DIR, 'schedule.json');

const DEFAULTS = {
  enabled: true,
  times: ['09:00', '21:00'],   // 每天在这些时刻自动采集
  runOnStart: false,           // 启动时立刻采一次
  ranSlots: [],                // 已执行过的槽位，形如 '2026-10-20 09:00'
  lastRunAt: null
};

/*
可信时段：只在 07:30–23:50 之间采集。
原因（2026-10-21 实测，见 data/snapshots.json）：
  商品 pmvgrzoov  10/20 23:40 读到 556 → 10/21 00:15 读到 550 → 10/21 08:18 回到 557
  商品 pmvgpc6x5  10/20 23:40 读到 1661 → 10/21 00:15 读到 1647 → 10/21 00:30 回到 1662
掉下去又涨回并超过掉之前的高点——退款扣减不可能把件数还回来，
所以凌晨那两条低读数是平台返回的旧快照，不是真实销量。
soldSeries() 能在事后把这类读数剔除，但有个前提：后面得有一条涨回来的记录。
若凌晨这条恰好是当天最后一条（服务停了、下一次采集失败），它就再也没机会翻案，
会被当成真实退款永久留下来。与其事后救，不如干脆别在窗口外采。
代价：看不到 00:00–07:30 的分时走势。这 7 个半小时的销量并不会丢，
只是整段归到「今天」——反正按日统计本来就该这样算。
*/
const TRUST_WINDOW = { start: '07:30', end: '23:50' };

function hmToMin(hm) {
  const [h, m] = hm.split(':').map(Number);
  return h * 60 + m;
}

// 'HH:MM' 这个时刻是否落在可信时段内
function timeInWindow(hm) {
  const min = hmToMin(hm);
  return min >= hmToMin(TRUST_WINDOW.start) && min <= hmToMin(TRUST_WINDOW.end);
}

// 此刻是否在可信时段内（可传入 Date 便于测试，不传则用当前时间）
function inTrustWindow(d) {
  return timeInWindow(nowHM(d));
}

function load() {
  try {
    if (!fs.existsSync(scheduleFile)) return { ...DEFAULTS };
    return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(scheduleFile, 'utf8')) };
  } catch (_) {
    return { ...DEFAULTS };
  }
}

function save(cfg) {
  fs.mkdirSync(path.dirname(scheduleFile), { recursive: true });
  fs.writeFileSync(scheduleFile, JSON.stringify(cfg, null, 2));
  return cfg;
}

// 两个函数都接受可选的 Date，测试里才能脱离"跑测试的那一刻"来断言
function today(d) {
  const x = d ? new Date(d) : new Date();
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
}

function nowHM(d) {
  const x = d ? new Date(d) : new Date();
  return `${String(x.getHours()).padStart(2, '0')}:${String(x.getMinutes()).padStart(2, '0')}`;
}

// 下一次执行时间（用于展示）
// 只考虑可信时段内的槽位——窗口外的槽位永远不会真的触发，显示出来是骗人
function nextRun(cfg) {
  if (!cfg.enabled || !cfg.times.length) return null;
  const usable = cfg.times.filter(timeInWindow);
  if (!usable.length) return null;
  const now = new Date();
  const candidates = [];
  for (const t of usable) {
    const [h, m] = t.split(':').map(Number);
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, m, 0, 0);
    if (d > now) candidates.push(d);
  }
  if (!candidates.length) {
    const [h, m] = usable[0].split(':').map(Number);
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, h, m, 0, 0);
    candidates.push(d);
  }
  candidates.sort((a, b) => a - b);
  return candidates[0];
}

// 判断此刻该不该跑：在可信时段内 + 到点 + 该槽位今天还没跑过
// 用槽位（含日期）判重，跨天不漏、重复触发不重跑
// now 可传 Date，仅测试使用；生产调用不传
function shouldRunNow(cfg, now) {
  if (!cfg.enabled || !cfg.times.length) return false;
  if (!inTrustWindow(now)) return false;      // 凌晨读数是旧快照，窗口外一律不采
  const hm = nowHM(now);
  return cfg.times.includes(hm) && !cfg.ranSlots.includes(`${today(now)} ${hm}`);
}

function markRun(cfg, slot) {
  const key = `${today()} ${slot}`;
  // 只保留最近 10 条，避免文件无限增长
  cfg.ranSlots = cfg.ranSlots.filter(x => x !== key).concat(key).slice(-10);
  cfg.lastRunAt = new Date().toISOString();
  return save(cfg);
}

module.exports = {
  load, save, nextRun, shouldRunNow, markRun,
  today, nowHM, inTrustWindow, timeInWindow, TRUST_WINDOW, DEFAULTS, scheduleFile
};