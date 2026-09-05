import mqtt from 'mqtt';
import http from 'http';

const IP = '127.0.0.1';
const AUTH = { username: 'siot', password: 'dfrobot' };

function login() {
  return new Promise((res, rej) => {
    const data = JSON.stringify(AUTH);
    const req = http.request(
      { host: IP, port: 8080, path: '/api/v2/login', method: 'POST', headers: { 'Content-Type': 'application/json' } },
      r => { let b = ''; r.on('data', d => b += d); r.on('end', () => { try { const j = JSON.parse(b); res(j.token || (j.data && j.data.token)); } catch (e) { rej(e); } }); }
    );
    req.on('error', rej); req.write(data); req.end();
  });
}
function putTopic(token, headers) {
  return new Promise((res) => {
    const data = JSON.stringify({ topic: 'siot/ict_up', topicDes: 'classroom' });
    const req = http.request(
      { host: IP, port: 8080, path: '/api/v2/topics', method: 'PUT', headers: { 'Content-Type': 'application/json', ...headers } },
      r => { let b = ''; r.on('data', d => b += d); r.on('end', () => res({ code: r.statusCode, body: b.slice(0, 120), headers })); }
    );
    req.on('error', e => res({ code: 0, body: e.message, headers }));
    req.write(data); req.end();
  });
}
function conn(url, opts = {}) {
  return new Promise(resolve => {
    let s = false;
    const c = mqtt.connect(url, { ...AUTH, connectTimeout: 6000, reconnectPeriod: 0, ...opts });
    const done = (ok, note) => { if (s) return; s = true; resolve({ ok, note, c }); };
    c.once('connect', () => done(true, ''));
    c.once('error', e => done(false, e.message));
    setTimeout(() => done(false, 'timeout'), 6500);
  });
}
const subscribe = (c, t, o) => new Promise((res, rej) => c.subscribe(t, o, (e, g) => e ? rej(e) : res(g)));
const publish = (c, t, p, o) => new Promise((res, rej) => c.publish(t, p, o, e => e ? rej(e) : res()));
function expectMsg(c, topic, ms = 3000) {
  return new Promise(resolve => {
    const tm = setTimeout(() => { c.removeListener('message', on); resolve(null); }, ms);
    function on(tp, pl) { if (tp !== topic) return; clearTimeout(tm); c.removeListener('message', on); resolve(pl.toString()); }
    c.on('message', on);
  });
}

const tok = await login();
console.log('login token?', !!tok);
const variants = {
  'Bearer': { Authorization: 'Bearer ' + tok },
  'raw': { Authorization: tok },
  'x-auth-token': { 'x-auth-token': tok },
  'token': { token: tok },
};
let okVariant = null;
for (const [name, h] of Object.entries(variants)) {
  const r = await putTopic(tok, h);
  console.log(`header[${name}] ->`, r.code, r.body);
  if (r.code === 200 || r.code === 201) okVariant = { name, h };
}
if (!okVariant) { console.log('无可用认证头，停止转发测试'); setTimeout(() => process.exit(0), 300); }

const pub = await conn(`mqtt://${IP}:1883`);
const sub = await conn(`ws://${IP}:1888/ws`);
if (pub.ok && sub.ok) {
  await subscribe(sub.c, 'siot/ict_up', { qos: 1 });
  const p = expectMsg(sub.c, 'siot/ict_up');
  await publish(pub.c, 'siot/ict_up', JSON.stringify({ msgId: 'v1', type: 'checkin', seat: '07' }), { qos: 1 });
  const got = await p;
  console.log('[RESULT] Plan B 两级主题转发:', got ? 'PASS -> ' + got : 'FAIL');
} else {
  console.log('conn fail', JSON.stringify(pub), JSON.stringify(sub));
}
setTimeout(() => process.exit(0), 500);
