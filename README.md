# 漏检趋势追溯系统

本地运行的网页版质检数据追溯工具：表单录入每日数据，自动存入本机数据库，
图表按日/周/月/年查看不良明细堆叠柱状图 + 漏检率折线图，柱子上的标签显示
对应不良项自己的漏检率（不是总数）。

不需要任何外部服务器、不需要联网，所有数据都存在本机一个 SQLite 文件里。

## 目录结构

```
leakapp/
├── app.py                 Flask 后端（路由 + 数据库逻辑），程序入口
├── requirements.txt        Python 依赖（只有 Flask）
├── templates/
│   └── index.html          页面结构
├── static/
│   ├── css/style.css       样式
│   └── js/
│       ├── main.js                       前端逻辑（表单/表格/图表）
│       ├── chart.umd.min.js              Chart.js（已内置，无需联网）
│       └── chartjs-plugin-datalabels.min.js   柱上数据标签插件（已内置）
└── leak_trend.db           首次运行后自动生成，所有数据都在这一个文件里
```

## 本机运行（开发/测试用）

```bash
cd leakapp
pip install -r requirements.txt
python app.py
```

终端会显示 `Running on http://127.0.0.1:5577`，同时自动弹出浏览器打开这个地址。
以后想换个端口，改 `app.py` 顶部的 `PORT = 5577` 即可。

## 打包成单个 exe（Windows）

在一台装好 Python 的 Windows 电脑上（建议和最终使用的系统位数一致，比如都是 64 位）：

```bash
pip install -r requirements.txt
pip install pyinstaller

pyinstaller --onefile --add-data "templates;templates" --add-data "static;static" --name 漏检趋势追溯系统 app.py
```

打包完成后，`dist` 文件夹里的 `漏检趋势追溯系统.exe` 就是成品，双击即可运行：
程序会在后台起一个本地服务，并自动打开默认浏览器访问页面，体验上和打开一个桌面软件一样。
关闭这个程序就用任务管理器结束 `漏检趋势追溯系统.exe` 进程（或者保留命令行窗口、关闭那个窗口）。

打包时要注意两点（已经在代码里处理好，不用改）：
- 模板和静态文件路径用 `resource_path()`，从 PyInstaller 解压的临时目录读取；
- 数据库文件用 `writable_base_dir()`，固定存在 exe 所在目录，不会随程序重启丢失，
  也方便你直接拷走 `leak_trend.db` 做备份或者迁移到别的电脑。

如果以后想要更彻底的"桌面应用"体验（没有浏览器标签栏、没有地址栏），
可以换成 `pywebview` 把这个网页装进一个原生窗口里，结构完全不用改，
有需要的话告诉我，我可以再补一个版本。

## 数据规则

- 每天一条记录，日期是唯一键：同一天再保存一次会变成"更新"而不是新增一条。
- 漏检率 = 不良总数 / 投入数 × 100%；每个不良项各自的漏检率 = 该项数量 / 投入数。
- 周的定义是 ISO 周（周一为一周的开始，跨年的最后一周按 ISO 规则计算），
  图表上显示成"2026 第03周"这样的格式。
- 不良总数超过投入数时，录入表单会有红字提示（不会强制拦截，只是提醒你检查）。

## 接口一览（如果以后要接其他系统）

| 方法   | 路径                         | 说明                         |
|--------|------------------------------|------------------------------|
| GET    | /api/records                 | 列表，支持 `start`/`end`/`limit` |
| GET    | /api/records/<date>          | 单日详情                     |
| POST   | /api/records                 | 新增或更新一天的数据           |
| DELETE | /api/records/<date>          | 删除一天的数据                |
| GET    | /api/summary                 | 图表汇总，`granularity=day\|week\|month\|year` + `start`/`end` |
| GET    | /api/stats/overview          | 首页三个KPI卡片：今日/本月/本年漏检率 |

## 已知限制

- Flask 自带的开发服务器只适合单机单用户使用（本来就是给一个人在自己电脑上用的场景），
  不要把这个 exe 暴露到公网或者给很多人同时连接。
- 没有登录/权限控制，谁能打开这台电脑就能看和改数据。
