const fs = require('fs');
const path = require('path');
const scheduleFile = path.join(__dirname, 'data', 'schedule.json');

const DEFAULTS = {
  enabled: true,
  times: ['09:00', '21:00'],   // 每天在这些时刻自动采集
  runOnStart: false,           // 启动时立刻采一次
  ranSlots: [],                // 已执行过的槽位，形如 '2026-10-20 09:00'
  lastRunAt: null
};

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

function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function nowHM() {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

// 下一次执行时间（用于展示）
function nextRun(cfg) {
  if (!cfg.enabled || !cfg.times.length) return null;
  const now = new Date();
  const todayStr = today();
  const candidates = [];
  for (const t of cfg.times) {
    const [h, m] = t.split(':').map(Number);
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, m, 0, 0);
    if (d > now) candidates.push(d);
  }
  if (!candidates.length) {
    const [h, m] = cfg.times[0].split(':').map(Number);
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, h, m, 0, 0);
    candidates.push(d);
  }
  candidates.sort((a, b) => a - b);
  return candidates[0];
}

// 判断此刻该不该跑：到点且该槽位今天还没跑过
// 用槽位（含日期）判重，跨天不漏、重复触发不重跑
function shouldRunNow(cfg) {
  if (!cfg.enabled || !cfg.times.length) return false;
  const now = nowHM();
  const t = today();
  for (const tm of cfg.times) {
    if (tm === now && !cfg.ranSlots.includes(`${t} ${tm}`)) return true;
  }
  return false;
}

function markRun(cfg, slot) {
  const key = `${today()} ${slot}`;
  // 只保留最近 10 条，避免文件无限增长
  cfg.ranSlots = cfg.ranSlots.filter(x => x !== key).concat(key).slice(-10);
  cfg.lastRunAt = new Date().toISOString();
  return save(cfg);
}

module.exports = { load, save, nextRun, shouldRunNow, markRun, today, nowHM, DEFAULTS, scheduleFile };