# 小红书对标销量监控

监控小红书**对标店铺**商品的公开展示销量与到手价，自动记录快照、计算增量、绘制趋势与价格阶梯图。

主工具在 `xhs-monitor/`，详细文档见 [xhs-monitor/README.md](xhs-monitor/README.md)。

## 仓库结构

```
.
├── xhs-monitor/         主工具（本地服务 + 网页界面）
│   ├── server.js        本地 HTTP 服务（端口 7788，支持手机同网访问）
│   ├── web/index.html   单文件前端（含样式与逻辑）
│   ├── api_collect.js   免登录 JSON 接口采集（主通道）
│   ├── collect.js       双通道调度：接口优先，登录态浏览器回退
│   ├── store.js         数据存储、增量计算、分组/店铺聚合
│   ├── scheduler.js     定时采集（到点判断、槽位去重）
│   ├── test_*.js        各层测试
│   └── README.md        使用说明、数据口径、常见问题
├── probes/              早期探活脚本（记录如何发现免登录接口，仅存档）
└── .gitignore
```

## 启动

双击 `xhs-monitor/启动监控.command`，或命令行：

```bash
cd xhs-monitor
NODE_PATH=~/.workbuddy/binaries/node/workspace/node_modules \
PLAYWRIGHT_BROWSERS_PATH=~/.workbuddy/binaries/node/workspace/browsers \
node server.js
```

浏览器打开 <http://127.0.0.1:7788>。

## Git 约定

**不入库的内容**（见 `.gitignore`）：

| 路径 | 原因 |
|---|---|
| `xhs-monitor/data/snapshots.json` | 真实销量与价格，每次采集都变 |
| `xhs-monitor/data/auto-log.json` | 采集执行日志 |
| `xhs-monitor/data/schedule.json` | 定时配置（本机状态） |
| `xhs-monitor/auth/` | 登录态，等同凭据 |
| `xhs-monitor/report.html` | 由数据生成的静态看板 |

数据虽然不入库，但**建议定期备份**——历史快照丢了就补不回来：

```bash
cd xhs-monitor
mkdir -p ../backups && cp data/snapshots.json "../backups/snapshots-$(date +%Y%m%d-%H%M%S).json"
```

**提交信息**用 `feat / fix / docs / test / refactor / chore` 前缀，一句话说清改了什么、为什么。

**改动前后都跑测试**，统一入口：

```bash
cd xhs-monitor
bash run_tests.sh          # 全部
bash run_tests.sh core     # 只要不需要浏览器的那批（约 20 秒）
```

`run_tests.sh` 会先把 `data/snapshots.json`、`data/schedule.json` 备份到 `backups/<时间戳>/`，
跑完再比对 MD5，一旦发现被测试改动就打印还原命令。

> 为什么强制走这个入口：早期 `test_api.js` 直连 7788 生产实例，开头就清空商品表，
> 把真实监控数据删光过一次（2026-10-20）。现在所有测试都自带临时库 + 独立端口，
> 但备份与校验仍固化在脚本里，不靠记性。

界面测试用系统 Chrome（本机没装 Playwright 自带的 chromium），
启动参数统一是 `chromium.launch({ channel: 'chrome' })`。

## 已知边界

- 「已售」是商品页对访客展示的数字，**不等于真实订单量**，只能看趋势，不能当财务报表
- 采集走的是小红书内部商品详情接口，无官方文档承诺，接口变更时会明确报错而非静默给错数据
- 价格记录的是**到手价**（`dealPrice`），不是划线价
