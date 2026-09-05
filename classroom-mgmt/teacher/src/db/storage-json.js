'use strict';
// 降级存储后端：内存 + JSON 文件。当 better-sqlite3 原生模块不可用（无编译工具链）时启用，
// 实现与 SqlStorage 完全一致的接口，保证 server 能起、能 smoke test。
// 数据量小（单节课 ≤50 学生 / ≤250 业务消息），同步落盘足够。

const fs = require('fs');
const path = require('path');

const TABLES = {
  t_session: ['session_id', 'teacher', 'class_name', 'start_time', 'end_time', 'phase', 'total_seats', 'export_flag', 'topic_plan', 'siot_ver', 'class_preset_id', 'activity_preset_id', 'activity_name', 'equipment_json', 'policy_mode'],
  t_student: ['stu_id', 'session_id', 'seat', 'group_id', 'name', 'student_no', 'checkin_time', 'checkin_status', 'machine_id', 'last_seen_at', 'return_status'],
  t_equipment: ['eq_id', 'eq_name', 'category', 'total'],
  t_equipment_borrow: ['borrow_id', 'session_id', 'seat', 'group_id', 'eq_id', 'qty', 'borrow_time', 'return_time', 'status'],
  t_task: ['task_id', 'session_id', 'title', 'desc', 'publish_time', 'close_time', 'source', 'activity_preset_id', 'timed', 'duration_sec', 'timer_state', 'timer_started_at', 'timer_paused_at', 'timer_remaining_ms'],
  t_task_status: ['id', 'task_id', 'seat', 'group_id', 'status', 'ts'],
  t_event_log: ['id', 'session_id', 'ts', 'type', 'seat', 'detail', 'msg_id', 'qos', 'raw_topic'],
  t_conflict: ['seat', 'machine_ids', 'first_seen_at', 'last_seen_at', 'message_count'],
  t_class_preset: ['preset_id', 'name', 'total_seats', 'group_size', 'note', 'created_at', 'updated_at'],
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

function matchRow(row, where) {
  return Object.keys(where || {}).every((k) => row[k] === where[k]);
}

class JsonStorage {
  constructor(filePath) {
    this.mode = 'json';
    this.file = filePath || path.join(process.cwd(), 'classroom.db.json');
    this.tables = {};
    this.seqs = {};
    for (const t of Object.keys(TABLES)) {
      this.tables[t] = [];
      this.seqs[t] = 0;
    }
    this._load();
  }

  _load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (raw && raw.tables) {
        for (const t of Object.keys(this.tables)) {
          this.tables[t] = raw.tables[t] || [];
        }
        this.seqs = raw.seqs || this.seqs;
      }
    } catch (_e) {
      // 文件不存在或损坏：从空开始
    }
  }

  _persist() {
    try {
      fs.writeFileSync(this.file, JSON.stringify({ tables: this.tables, seqs: this.seqs }));
    } catch (e) {
      // 落盘失败仅告警，不影响内存态
      // eslint-disable-next-line no-console
      console.warn('[JSON_STORAGE] persist failed:', e.message);
    }
  }

  _nextId(table) {
    this.seqs[table] = (this.seqs[table] || 0) + 1;
    return this.seqs[table];
  }

  insert(table, row) {
    const cols = (TABLES[table] || []).filter((k) => row[k] !== undefined);
    const r = {};
    for (const k of cols) r[k] = row[k];
    if (PK[table] === 'id') r.id = this._nextId(table);
    this.tables[table].push(r);
    this._persist();
    return Object.assign({}, r);
  }

  upsert(table, row) {
    const pk = PK[table];
    if (row[pk] != null) {
      const idx = this.tables[table].findIndex((x) => x[pk] === row[pk]);
      if (idx >= 0) {
        this.tables[table][idx] = Object.assign({}, this.tables[table][idx], row);
        this._persist();
        return Object.assign({}, this.tables[table][idx]);
      }
    }
    return this.insert(table, row);
  }

  get(table, where) {
    const r = this.find(table, where);
    return r[0] || null;
  }

  find(table, where) {
    return this.tables[table].filter((row) => matchRow(row, where));
  }

  all(table) {
    return this.tables[table].slice();
  }

  update(table, where, patch) {
    let n = 0;
    for (const row of this.tables[table]) {
      if (matchRow(row, where)) {
        Object.assign(row, patch);
        n += 1;
      }
    }
    if (n > 0) this._persist();
    return n;
  }

  remove(table, where) {
    const before = this.tables[table].length;
    this.tables[table] = this.tables[table].filter((row) => !matchRow(row, where));
    const n = before - this.tables[table].length;
    if (n > 0) this._persist();
    return n;
  }

  count(table, where) {
    return this.find(table, where).length;
  }

  // 与 SqlStorage.transaction 语义对齐：失败整体回滚（数据量为单节课级别，快照开销可忽略）。
  transaction(fn) {
    const tablesSnapshot = JSON.stringify(this.tables);
    const seqsSnapshot = Object.assign({}, this.seqs);
    try {
      return fn();
    } catch (e) {
      this.tables = JSON.parse(tablesSnapshot);
      this.seqs = seqsSnapshot;
      this._persist();
      throw e;
    }
  }

  insertEvent(row) {
    if (row.msg_id != null) {
      const dup = this.tables.t_event_log.find((x) => x.msg_id === row.msg_id);
      if (dup) return { inserted: false, dup: true };
    }
    const r = this.insert('t_event_log', row);
    return { inserted: !!r, row: r };
  }

  close() {
    this._persist();
  }
}

module.exports = { JsonStorage, TABLES, PK };
