'use strict';
// 在线/离线看门狗：周期扫描座位 last_seen_at，检测 online/offline 跳变并广播 SSE。
// 弥补 15s 心跳间隔与 SIoT 无 LWT 的缺口（ARCH §5.8）。
const db = require('./db');
const sse = require('./sse');

let prevOnline = new Set();
let timer = null;

function scan() {
  const session = db.getCurrentSession();
  if (!session) { prevOnline = new Set(); return; }
  const students = db.queryStudents(session.session_id).items;
  const curOnline = new Set(students.filter((s) => s.online).map((s) => s.seat));
  for (const s of students) {
    const wasOn = prevOnline.has(s.seat);
    const isOn = curOnline.has(s.seat);
    if (isOn && !wasOn) {
      sse.publish('student.online', { seat: s.seat, online: true, lastSeenAt: s.lastSeenAt });
    } else if (!isOn && wasOn) {
      sse.publish('student.offline', { seat: s.seat, online: false, lastSeenAt: s.lastSeenAt });
    }
  }
  prevOnline = curOnline;
}

function start(intervalMs) {
  if (timer) return;
  timer = setInterval(scan, intervalMs || 5000);
  if (timer.unref) timer.unref();
}
function stop() { if (timer) { clearInterval(timer); timer = null; } }
function reset() { prevOnline = new Set(); }

module.exports = { start, stop, reset, scan };
