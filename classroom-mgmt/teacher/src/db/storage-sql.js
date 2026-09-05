'use strict';
// SQLite 存储后端（better-sqlite3）。实现与 JSON 后端一致的表操作接口。
// 通过白名单列名构造参数化 SQL，避免注入。所有接口同步（better-sqlite3 同步 API）。

const TABLES = {
  t_session: ['session_id', 'teacher', 'class_name', 'start_time', 'end_time', 'phase', 'total_seats', 'export_flag', 'topic_plan', 'siot_ver', 'class_preset_id', 'activity_preset_id', 'activity_name', 'equipment_json', 'policy_mode'],
  t_student: ['stu_id', 'session_id', 'seat', 'group_id', 'name', 'student_no', 'checkin_time', 'checkin_status', 'machine_id', 'last_seen_at', 'return_status'],
  t_equipment: ['eq_id', 'eq_name', 'category', 'total'],
  t_equipment_borrow: ['borrow_id', 'session_id', 'seat', 'group_id', 'eq_id', 'qty', 'borrow_time', 'return_time', 'status'],
  t_task: ['task_id', 'session_id', 'title', 'desc', 'publish_time', 'close_time', 'source', 'activity_preset_id', 'timed', 'duration_sec', 'timer_state', 'timer_started_at', 'timer_paused_at', 'timer_remaining_ms'],
  t_task_status: ['id', 'task_id', 'seat', 'group_id', 'status', 'ts'],
  t_event_log: ['id', 'session_id', 'ts', 'type', 'seat', 'detail', 'msg_id', 'qos', 'raw_topic'],
  t_conflict: ['seat', 'machine_ids', 'first_seen_at', 'last_seen_at', 'message_count'],
  t_class_preset: ['preset_id', 'name', 'total_seats', 'group_size', 'note', 'created_at', 'updated_at', 'groups_json', 'equipment_json'],
  t_activity_preset: ['preset_id', 'name', 'category', 'equipment_json', 'task_templates_json', 'note', 'created_at', 'updated_at', 'timed', 'duration_sec'],
};

const PK = {
  t_session: 'session_id',
  t_student: 'stu_id',
  t_equipment: 'eq_id',
  t_equipment_borrow: 'borrow_id',
  t_task: 'task_id',
  t_task_status: 'id',
  t_event_log: 'id',
  t_conflict: 'seat',
  t_class_preset: 'preset_id',
  t_activity_preset: 'preset_id',
};

const DDL = `
CREATE TABLE IF NOT EXISTS t_session (
  session_id TEXT PRIMARY KEY,
  teacher TEXT NOT NULL,
  class_name TEXT,
  start_time INTEGER,
  end_time INTEGER,
  phase TEXT DEFAULT 'waiting',
  total_seats INTEGER DEFAULT 50,
  export_flag INTEGER DEFAULT 0,
  topic_plan TEXT,
  siot_ver TEXT,
  class_preset_id TEXT,
  activity_preset_id TEXT,
  activity_name TEXT,
  equipment_json TEXT,
  policy_mode TEXT DEFAULT 'open'
);
CREATE TABLE IF NOT EXISTS t_student (
  stu_id TEXT PRIMARY KEY,
  session_id TEXT,
  seat TEXT,
  group_id TEXT,
  name TEXT,
  student_no TEXT,
  checkin_time INTEGER,
  checkin_status TEXT DEFAULT 'pending',
  machine_id TEXT,
  last_seen_at INTEGER,
  return_status TEXT DEFAULT 'pending',
  UNIQUE(session_id, seat),
  FOREIGN KEY(session_id) REFERENCES t_session(session_id)
);
CREATE TABLE IF NOT EXISTS t_equipment (
  eq_id TEXT PRIMARY KEY,
  eq_name TEXT,
  category TEXT,
  total INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS t_equipment_borrow (
  borrow_id TEXT PRIMARY KEY,
  session_id TEXT,
  seat TEXT,
  group_id TEXT,
  eq_id TEXT,
  qty INTEGER DEFAULT 1,
  borrow_time INTEGER,
  return_time INTEGER,
  status TEXT DEFAULT 'borrowed',
  FOREIGN KEY(session_id) REFERENCES t_session(session_id)
);
CREATE TABLE IF NOT EXISTS t_task (
  task_id TEXT PRIMARY KEY,
  session_id TEXT,
  title TEXT,
  desc TEXT,
  publish_time INTEGER,
  close_time INTEGER,
  source TEXT DEFAULT 'custom',
  activity_preset_id TEXT,
  timed INTEGER DEFAULT 0,
  duration_sec INTEGER,
  timer_state TEXT DEFAULT 'idle',
  timer_started_at INTEGER,
  timer_paused_at INTEGER,
  timer_remaining_ms INTEGER,
  FOREIGN KEY(session_id) REFERENCES t_session(session_id)
);
CREATE TABLE IF NOT EXISTS t_task_status (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT,
  seat TEXT,
  group_id TEXT,
  status TEXT,
  ts INTEGER,
  FOREIGN KEY(task_id) REFERENCES t_task(task_id)
);
CREATE TABLE IF NOT EXISTS t_event_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT,
  ts INTEGER,
  type TEXT,
  seat TEXT,
  detail TEXT,
  msg_id TEXT UNIQUE,
  qos INTEGER,
  raw_topic TEXT
);
CREATE TABLE IF NOT EXISTS t_conflict (
  seat TEXT PRIMARY KEY,
  machine_ids TEXT,
  first_seen_at INTEGER,
  last_seen_at INTEGER,
  message_count INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS t_class_preset (
  preset_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  total_seats INTEGER DEFAULT 50,
  group_size INTEGER DEFAULT 5,
  note TEXT,
  groups_json TEXT,
  equipment_json TEXT,
  created_at INTEGER,
  updated_at INTEGER
);
CREATE TABLE IF NOT EXISTS t_activity_preset (
  preset_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  category TEXT,
  equipment_json TEXT,
  task_templates_json TEXT,
  note TEXT,
  timed INTEGER DEFAULT 0,
  duration_sec INTEGER,
  created_at INTEGER,
  updated_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_student_session ON t_student(session_id);
CREATE INDEX IF NOT EXISTS idx_borrow_session ON t_equipment_borrow(session_id);
CREATE INDEX IF NOT EXISTS idx_taskstatus_task ON t_task_status(task_id);
CREATE INDEX IF NOT EXISTS idx_event_session ON t_event_log(session_id);
CREATE INDEX IF NOT EXISTS idx_event_ts ON t_event_log(ts);
`;

const { BusinessError } = require('../errors');

// better-sqlite3 默认开启 PRAGMA foreign_keys=ON（实测 13.0.3 为 1），外键是真实生效的。
// 原生 SqliteError 禁止穿透到 service / 路由层，统一映射为业务错误 E-REF-01。
function isFkViolation(e) {
  if (!e) return false;
  return e.code === 'SQLITE_CONSTRAINT_FOREIGNKEY'
    || String(e.message || '').includes('FOREIGN KEY constraint failed');
}

function toRefError(e, table) {
  return new BusinessError('E-REF-01',
    `参照完整性违规：${table} 的外键目标记录不存在`,
    { table, reason: 'foreign_key' });
}

function whereClause(table, where) {
  const cols = TABLES[table] || [];
  const keys = Object.keys(where || {}).filter((k) => cols.includes(k));
  if (keys.length === 0) return { clause: '', params: [] };
  return {
    clause: ' WHERE ' + keys.map((k) => `${k}=?`).join(' AND '),
    params: keys.map((k) => where[k]),
  };
}

class SqlStorage {
  constructor(db) {
    this.db = db;
    this.mode = 'sqlite';
    this.db.pragma('journal_mode = WAL');
    this.db.exec(DDL);
    this._migrate();
  }

  // 轻量列迁移：为旧库补齐新列（重复添加会抛错，逐个捕获忽略）。
  _migrate() {
    const RUNS = [
      ['t_session', [['class_preset_id', 'TEXT'], ['activity_preset_id', 'TEXT'], ['activity_name', 'TEXT'],
        ['equipment_json', 'TEXT'], ['policy_mode', 'TEXT DEFAULT \'open\'']]],
      ['t_task', [['source', 'TEXT DEFAULT \'custom\''], ['activity_preset_id', 'TEXT'], ['timed', 'INTEGER DEFAULT 0'],
        ['duration_sec', 'INTEGER'], ['timer_state', 'TEXT DEFAULT \'idle\''], ['timer_started_at', 'INTEGER'],
        ['timer_paused_at', 'INTEGER'], ['timer_remaining_ms', 'INTEGER']]],
      ['t_activity_preset', [['timed', 'INTEGER DEFAULT 0'], ['duration_sec', 'INTEGER']]],
      ['t_class_preset', [['groups_json', 'TEXT'], ['equipment_json', 'TEXT']]],
    ];
    for (const [table, cols] of RUNS) {
      for (const [name, type] of cols) {
        try { this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`); } catch (_e) { /* 列已存在 */ }
      }
    }
  }

  insert(table, row) {
    const cols = (TABLES[table] || []).filter((k) => row[k] !== undefined);
    if (cols.length === 0) return null;
    const sql = `INSERT INTO ${table} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`;
    let info;
    try {
      info = this.db.prepare(sql).run(...cols.map((k) => row[k]));
    } catch (e) {
      if (isFkViolation(e)) throw toRefError(e, table);
      throw e;
    }
    const pk = PK[table];
    if (pk === 'id') return Object.assign({ id: info.lastInsertRowid }, row);
    return this.get(table, { [pk]: row[pk] }) || Object.assign({}, row);
  }

  // 存在则按主键更新，否则插入
  upsert(table, row) {
    const pk = PK[table];
    if (row[pk] != null) {
      const existing = this.get(table, { [pk]: row[pk] });
      if (existing) {
        this.update(table, { [pk]: row[pk] }, row);
        return this.get(table, { [pk]: row[pk] });
      }
    }
    return this.insert(table, row);
  }

  get(table, where) {
    const r = this.find(table, where);
    return r[0] || null;
  }

  find(table, where) {
    const wc = whereClause(table, where);
    return this.db.prepare(`SELECT * FROM ${table}${wc.clause}`).all(...wc.params);
  }

  all(table) {
    return this.db.prepare(`SELECT * FROM ${table}`).all();
  }

  update(table, where, patch) {
    const cols = (TABLES[table] || []).filter((k) => patch[k] !== undefined);
    if (cols.length === 0) return 0;
    const wc = whereClause(table, where);
    const sql = `UPDATE ${table} SET ${cols.map((k) => `${k}=?`).join(',')}${wc.clause}`;
    try {
      return this.db.prepare(sql).run(...cols.map((k) => patch[k]), ...wc.params).changes;
    } catch (e) {
      if (isFkViolation(e)) throw toRefError(e, table);
      throw e;
    }
  }

  // 原子执行：事件标记（msg_id 幂等）与业务写入必须同生共死。
  // 业务写入抛错时整段回滚，避免 msg_id 被"毒丸"占用导致 MQTT 重投后消息永久丢失。
  transaction(fn) {
    return this.db.transaction(fn)();
  }

  remove(table, where) {
    const wc = whereClause(table, where);
    return this.db.prepare(`DELETE FROM ${table}${wc.clause}`).run(...wc.params).changes;
  }

  count(table, where) {
    const wc = whereClause(table, where);
    const r = this.db.prepare(`SELECT COUNT(*) c FROM ${table}${wc.clause}`).get(...wc.params);
    return r.c;
  }

  // 事件幂等写入：msg_id UNIQUE，重复直接忽略。返回 { inserted: boolean }
  insertEvent(row) {
    try {
      const cols = (TABLES.t_event_log || []).filter((k) => row[k] !== undefined);
      const sql = `INSERT INTO t_event_log (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`;
      const info = this.db.prepare(sql).run(...cols.map((k) => row[k]));
      return { inserted: info.changes > 0 };
    } catch (e) {
      // UNIQUE(msg_id) 冲突
      if (String(e.message || '').includes('UNIQUE')) return { inserted: false, dup: true };
      throw e;
    }
  }

  close() {
    try { this.db.close(); } catch (_e) { /* ignore */ }
  }
}

module.exports = { SqlStorage, TABLES, PK };
