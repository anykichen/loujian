# -*- coding: utf-8 -*-
"""
漏检趋势追溯系统 - 本地Web应用
================================
单文件Flask后端 + SQLite数据库，专为打包成单个exe设计：
- 数据库文件保存在“程序所在目录”，可持久化、可备份、可拷走。
- 模板/静态资源在打包后从 PyInstaller 的临时目录读取（resource_path）。
- 启动时自动在默认浏览器打开页面，体验上像一个桌面程序。

打包命令（在装好 pyinstaller 的 Windows 机器上执行）：
    pyinstaller --onefile --add-data "templates;templates" --add-data "static;static" --icon "icon.ico" --name 漏检趋势追溯系统 app.py

打包后双击 dist/漏检趋势追溯系统.exe 即可，浏览器会自动打开 http://127.0.0.1:5577
"""

import os
import sys
import json
import sqlite3
import threading
import webbrowser
from datetime import datetime, date
from flask import Flask, request, jsonify, render_template, g

# ----------------------------------------------------------------------
# 路径处理：兼容“直接用python运行”和“打包成exe运行”两种场景
# ----------------------------------------------------------------------

def resource_path(relative_path):
    """只读资源（模板、静态文件）的路径：打包后从 PyInstaller 解压的临时目录读取"""
    base_path = getattr(sys, "_MEIPASS", os.path.dirname(os.path.abspath(__file__)))
    return os.path.join(base_path, relative_path)


def writable_base_dir():
    """数据库等需要持久化的文件：保存在“可执行文件/脚本所在目录”，不能用_MEIPASS（那是临时目录）"""
    if getattr(sys, "frozen", False):
        return os.path.dirname(sys.executable)
    return os.path.dirname(os.path.abspath(__file__))


DB_PATH = os.path.join(writable_base_dir(), "leak_trend.db")
PORT = 5577

app = Flask(
    __name__,
    template_folder=resource_path("templates"),
    static_folder=resource_path("static"),
)

DEFAULT_COLORS = [
    "#3A6EA5", "#C97B3D", "#8A8F98", "#B7973D", "#4F8F6B", "#7A4E3D",
    "#9B2226", "#6B4423", "#2F4F4F", "#8B0000", "#008B8B", "#8B4513",
    "#483D8B", "#CD853F", "#DAA520", "#20B2AA", "#808000", "#000080",
]

DEFAULT_DEFECTS = [
    {"code": "scratch", "name": "划痕"},
    {"code": "dent", "name": "凹陷"},
    {"code": "burr", "name": "毛刺"},
    {"code": "color_diff", "name": "色差"},
    {"code": "foreign_obj", "name": "异物"},
    {"code": "deform", "name": "变形"},
]

# ----------------------------------------------------------------------
# 数据库
# ----------------------------------------------------------------------

def get_db():
    if "db" not in g:
        g.db = sqlite3.connect(DB_PATH)
        g.db.row_factory = sqlite3.Row
    return g.db


@app.teardown_appcontext
def close_db(exception=None):
    db = g.pop("db", None)
    if db is not None:
        db.close()


def init_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row

    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS projects (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT UNIQUE NOT NULL,
            code TEXT UNIQUE,
            description TEXT DEFAULT '',
            created_at TEXT DEFAULT (datetime('now','localtime')),
            updated_at TEXT DEFAULT (datetime('now','localtime'))
        )
        """
    )

    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS defects (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            code TEXT UNIQUE NOT NULL,
            name TEXT NOT NULL,
            color TEXT NOT NULL,
            sort_order INTEGER NOT NULL DEFAULT 0,
            created_at TEXT DEFAULT (datetime('now','localtime')),
            updated_at TEXT DEFAULT (datetime('now','localtime'))
        )
        """
    )

    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS records (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            project_id INTEGER NOT NULL DEFAULT 1,
            date TEXT NOT NULL,
            input_qty INTEGER NOT NULL DEFAULT 0,
            defect_data TEXT NOT NULL DEFAULT '{}',
            created_at TEXT DEFAULT (datetime('now','localtime')),
            updated_at TEXT DEFAULT (datetime('now','localtime')),
            UNIQUE(project_id, date)
        )
        """
    )

    if not conn.execute("SELECT id FROM projects WHERE id=1").fetchone():
        pass
    existing_codes = set(r["code"] for r in conn.execute("SELECT code FROM defects").fetchall())
    current_count = len(existing_codes)
    for idx, d in enumerate(DEFAULT_DEFECTS):
        if d["code"] not in existing_codes:
            color = DEFAULT_COLORS[(current_count + idx) % len(DEFAULT_COLORS)]
            conn.execute(
                "INSERT INTO defects (code, name, color, sort_order) VALUES (?, ?, ?, ?)",
                (d["code"], d["name"], color, current_count + idx + 1),
            )

    conn.execute("UPDATE records SET project_id = 1 WHERE project_id IS NULL")

    conn.commit()
    conn.close()


def get_defects():
    rows = get_db().execute("SELECT * FROM defects ORDER BY sort_order").fetchall()
    return [dict(r) for r in rows]


def get_defect_codes():
    rows = get_db().execute("SELECT code FROM defects ORDER BY sort_order").fetchall()
    return [r["code"] for r in rows]


# ----------------------------------------------------------------------
# 工具函数
# ----------------------------------------------------------------------

def row_to_record(row):
    d = dict(row)
    defect_data = json.loads(d.get("defect_data") or "{}")
    codes = get_defect_codes()
    defect_total = sum(defect_data.get(f, 0) for f in codes)
    input_qty = d["input_qty"] or 0
    leak_rate = (defect_total / input_qty * 100) if input_qty > 0 else None
    rates = {
        f: (defect_data.get(f, 0) / input_qty * 100 if input_qty > 0 else None) for f in codes
    }
    d["defect_data"] = defect_data
    d["defect_total"] = defect_total
    d["leak_rate"] = leak_rate
    d["rates"] = rates
    return d


def bucket_key(iso_date, granularity):
    y, m, day_str = iso_date.split("-")
    d = date(int(y), int(m), int(day_str))
    if granularity == "day":
        return iso_date
    if granularity == "month":
        return f"{y}-{m}"
    if granularity == "year":
        return y
    if granularity == "week":
        iso_year, iso_week, _ = d.isocalendar()
        return f"{iso_year}-W{iso_week:02d}"
    raise ValueError("unknown granularity")


def aggregate(rows, granularity):
    codes = get_defect_codes()
    buckets = {}
    order = []
    for row in rows:
        key = bucket_key(row["date"], granularity)
        defect_data = json.loads(row["defect_data"] or "{}")
        if key not in buckets:
            buckets[key] = {
                "label": key,
                "input_qty": 0,
                **{f: 0 for f in codes},
            }
            order.append(key)
        b = buckets[key]
        b["input_qty"] += row["input_qty"] or 0
        for f in codes:
            b[f] += defect_data.get(f, 0) or 0

    result = []
    for key in sorted(order):
        b = buckets[key]
        defect_total = sum(b[f] for f in codes)
        input_qty = b["input_qty"]
        leak_rate = (defect_total / input_qty * 100) if input_qty > 0 else None
        rates = {f: (b[f] / input_qty * 100 if input_qty > 0 else None) for f in codes}
        b["defect_total"] = defect_total
        b["leak_rate"] = leak_rate
        b["rates"] = rates
        result.append(b)
    return result


# ----------------------------------------------------------------------
# 页面
# ----------------------------------------------------------------------

@app.route("/")
def index():
    defects = get_defects()
    return render_template("index.html", defects=defects)


# ----------------------------------------------------------------------
# API - 不良类型管理
# ----------------------------------------------------------------------

@app.route("/api/defects", methods=["GET"])
def list_defects():
    return jsonify(get_defects())


@app.route("/api/projects", methods=["GET"])
def list_projects():
    rows = get_db().execute("SELECT * FROM projects ORDER BY id").fetchall()
    return jsonify([dict(r) for r in rows])


@app.route("/api/projects", methods=["POST"])
def create_project():
    data = request.get_json(force=True) or {}
    name = data.get("name")
    code = data.get("code")
    description = data.get("description", "")

    if not name:
        return jsonify({"error": "缺少名称"}), 400

    db = get_db()
    try:
        db.execute(
            "INSERT INTO projects (name, code, description) VALUES (?, ?, ?)",
            (name, code, description),
        )
        db.commit()
    except sqlite3.IntegrityError:
        return jsonify({"error": "名称或代码已存在"}), 400

    rows = db.execute("SELECT * FROM projects ORDER BY id").fetchall()
    return jsonify([dict(r) for r in rows])


@app.route("/api/projects/<project_id>", methods=["PUT"])
def update_project(project_id):
    data = request.get_json(force=True) or {}
    name = data.get("name")
    code = data.get("code")
    description = data.get("description")

    if name is None and code is None and description is None:
        return jsonify({"error": "没有需要更新的字段"}), 400

    db = get_db()
    updates = []
    params = []

    if name is not None:
        updates.append("name=?")
        params.append(name)
    if code is not None:
        updates.append("code=?")
        params.append(code)
    if description is not None:
        updates.append("description=?")
        params.append(description)

    updates.append("updated_at=datetime('now','localtime')")
    params.append(project_id)

    try:
        db.execute(
            f"UPDATE projects SET {', '.join(updates)} WHERE id=?",
            params,
        )
        db.commit()
    except sqlite3.IntegrityError:
        return jsonify({"error": "名称或代码已存在"}), 400

    rows = db.execute("SELECT * FROM projects ORDER BY id").fetchall()
    return jsonify([dict(r) for r in rows])


@app.route("/api/projects/<project_id>", methods=["DELETE"])
def delete_project(project_id):
    db = get_db()
    count = db.execute("SELECT COUNT(*) FROM records WHERE project_id=?", (project_id,)).fetchone()[0]
    if count > 0:
        return jsonify({"error": "该专案下有数据，无法删除"}), 400

    db.execute("DELETE FROM projects WHERE id=?", (project_id,))
    db.commit()

    rows = db.execute("SELECT * FROM projects ORDER BY id").fetchall()
    return jsonify([dict(r) for r in rows])


@app.route("/api/defects", methods=["POST"])
def create_defect():
    data = request.get_json(force=True) or {}
    code = data.get("code")
    name = data.get("name")

    if not code or not name:
        return jsonify({"error": "缺少代码或名称"}), 400

    db = get_db()
    try:
        count = db.execute("SELECT COUNT(*) FROM defects").fetchone()[0]
        color = DEFAULT_COLORS[count % len(DEFAULT_COLORS)]
        sort_order = count + 1
        db.execute(
            "INSERT INTO defects (code, name, color, sort_order) VALUES (?, ?, ?, ?)",
            (code, name, color, sort_order),
        )
        db.commit()
    except sqlite3.IntegrityError:
        return jsonify({"error": "代码已存在"}), 400

    rows = db.execute("SELECT * FROM defects ORDER BY sort_order").fetchall()
    return jsonify([dict(r) for r in rows])


@app.route("/api/defects/<defect_id>", methods=["PUT"])
def update_defect(defect_id):
    data = request.get_json(force=True) or {}
    name = data.get("name")

    if name is None:
        return jsonify({"error": "没有需要更新的字段"}), 400

    db = get_db()
    db.execute(
        "UPDATE defects SET name=?, updated_at=datetime('now','localtime') WHERE id=?",
        (name, defect_id),
    )
    db.commit()

    rows = db.execute("SELECT * FROM defects ORDER BY sort_order").fetchall()
    return jsonify([dict(r) for r in rows])


@app.route("/api/defects/<defect_id>", methods=["DELETE"])
def delete_defect(defect_id):
    db = get_db()
    row = db.execute("SELECT code FROM defects WHERE id=?", (defect_id,)).fetchone()
    if not row:
        return jsonify({"error": "不良类型不存在"}), 400
    code = row["code"]

    rows = db.execute("SELECT date, defect_data FROM records").fetchall()
    for r in rows:
        defect_data = json.loads(r["defect_data"] or "{}")
        if code in defect_data:
            del defect_data[code]
            db.execute(
                "UPDATE records SET defect_data=? WHERE date=?",
                (json.dumps(defect_data), r["date"]),
            )

    db.execute("DELETE FROM defects WHERE id=?", (defect_id,))
    db.commit()

    rows = db.execute("SELECT * FROM defects ORDER BY sort_order").fetchall()
    return jsonify([dict(r) for r in rows])


# ----------------------------------------------------------------------
# API - 单日记录的增/改/删/查
# ----------------------------------------------------------------------

@app.route("/api/records", methods=["GET"])
def list_records():
    start = request.args.get("start")
    end = request.args.get("end")
    limit = request.args.get("limit", type=int)
    project_id = request.args.get("project_id", type=int)

    if project_id is None:
        return jsonify([])

    query = "SELECT * FROM records WHERE project_id = ?"
    params = [project_id]
    if start:
        query += " AND date >= ?"
        params.append(start)
    if end:
        query += " AND date <= ?"
        params.append(end)
    query += " ORDER BY date DESC"
    if limit:
        query += " LIMIT ?"
        params.append(limit)

    rows = get_db().execute(query, params).fetchall()
    return jsonify([row_to_record(r) for r in rows])


@app.route("/api/records/<rec_date>", methods=["GET"])
def get_record(rec_date):
    project_id = request.args.get("project_id", type=int)
    if project_id is None:
        return jsonify(None)
    row = get_db().execute("SELECT * FROM records WHERE project_id = ? AND date = ?", (project_id, rec_date)).fetchone()
    if not row:
        return jsonify(None)
    return jsonify(row_to_record(row))


@app.route("/api/records", methods=["POST"])
def upsert_record():
    data = request.get_json(force=True) or {}
    rec_date = data.get("date")
    project_id = data.get("project_id")
    if not rec_date:
        return jsonify({"error": "缺少日期"}), 400
    if project_id is None:
        return jsonify({"error": "缺少专案"}), 400
    try:
        datetime.strptime(rec_date, "%Y-%m-%d")
    except ValueError:
        return jsonify({"error": "日期格式不正确，应为 YYYY-MM-DD"}), 400

    input_qty = int(data.get("input_qty") or 0)
    codes = get_defect_codes()

    defect_data_input = data.get("defect_data", {})
    if not defect_data_input:
        defect_data_input = {code: data.get(code) for code in codes if data.get(code) is not None}

    defect_data = {f: int(defect_data_input.get(f) or 0) for f in codes}

    if input_qty < 0 or any(v < 0 for v in defect_data.values()):
        return jsonify({"error": "数值不能为负数"}), 400

    db = get_db()
    existing = db.execute("SELECT id FROM records WHERE project_id = ? AND date = ?", (project_id, rec_date)).fetchone()
    if existing:
        db.execute(
            "UPDATE records SET input_qty=?, defect_data=?, updated_at=datetime('now','localtime') WHERE project_id=? AND date=?",
            [input_qty, json.dumps(defect_data), project_id, rec_date],
        )
    else:
        db.execute(
            "INSERT INTO records (project_id, date, input_qty, defect_data) VALUES (?, ?, ?, ?)",
            [project_id, rec_date, input_qty, json.dumps(defect_data)],
        )
    db.commit()
    row = db.execute("SELECT * FROM records WHERE project_id = ? AND date = ?", (project_id, rec_date)).fetchone()
    return jsonify(row_to_record(row))


@app.route("/api/records/<rec_date>", methods=["DELETE"])
def delete_record(rec_date):
    project_id = request.args.get("project_id", type=int)
    if project_id is None:
        return jsonify({"error": "缺少专案"}), 400
    db = get_db()
    db.execute("DELETE FROM records WHERE project_id = ? AND date = ?", (project_id, rec_date))
    db.commit()
    return jsonify({"ok": True})


# ----------------------------------------------------------------------
# API - 图表汇总数据（日/周/月/年）
# ----------------------------------------------------------------------

@app.route("/api/summary")
def summary():
    granularity = request.args.get("granularity", "day")
    if granularity not in ("day", "week", "month", "year"):
        return jsonify({"error": "granularity 必须是 day/week/month/year"}), 400

    project_id = request.args.get("project_id", type=int)
    if project_id is None:
        return jsonify({"granularity": granularity, "buckets": [], "defects": get_defects()})
    start = request.args.get("start")
    end = request.args.get("end")
    query = "SELECT * FROM records WHERE project_id = ?"
    params = [project_id]
    if start:
        query += " AND date >= ?"
        params.append(start)
    if end:
        query += " AND date <= ?"
        params.append(end)
    query += " ORDER BY date"

    rows = get_db().execute(query, params).fetchall()
    buckets = aggregate(rows, granularity)
    defects = get_defects()
    return jsonify({"granularity": granularity, "buckets": buckets, "defects": defects})


@app.route("/api/stats/overview")
def stats_overview():
    project_id = request.args.get("project_id", type=int)
    if project_id is None:
        return jsonify({"today": {"input_qty": 0, "defect_total": 0, "leak_rate": None}, "month": {"input_qty": 0, "defect_total": 0, "leak_rate": None}, "year": {"input_qty": 0, "defect_total": 0, "leak_rate": None}})
    db = get_db()
    codes = get_defect_codes()
    today = date.today().isoformat()
    month_prefix = today[:7]
    year_prefix = today[:4]

    def calc(prefix_param):
        rows = db.execute(
            "SELECT * FROM records WHERE project_id = ? AND date LIKE ?", (project_id, prefix_param + "%",)
        ).fetchall()
        if not rows:
            return {"input_qty": 0, "defect_total": 0, "leak_rate": None}
        input_qty = sum(r["input_qty"] for r in rows)
        defect_total = sum(sum(json.loads(r["defect_data"] or "{}").get(f, 0) for f in codes) for r in rows)
        leak_rate = (defect_total / input_qty * 100) if input_qty > 0 else None
        return {"input_qty": input_qty, "defect_total": defect_total, "leak_rate": leak_rate}

    today_row = db.execute("SELECT * FROM records WHERE project_id = ? AND date = ?", (project_id, today)).fetchone()
    today_stat = row_to_record(today_row) if today_row else {"input_qty": 0, "defect_total": 0, "leak_rate": None}

    return jsonify(
        {
            "today": {"input_qty": today_stat.get("input_qty", 0), "defect_total": today_stat.get("defect_total", 0), "leak_rate": today_stat.get("leak_rate")},
            "month": calc(month_prefix),
            "year": calc(year_prefix),
        }
    )


# ----------------------------------------------------------------------
# 启动
# ----------------------------------------------------------------------

def open_browser():
    webbrowser.open(f"http://127.0.0.1:{PORT}")


if __name__ == "__main__":
    init_db()
    threading.Timer(1.0, open_browser).start()
    app.run(host="127.0.0.1", port=PORT, debug=False)