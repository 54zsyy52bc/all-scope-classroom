// Plan B forward test: pure MQTT pub/sub on siot/ topics (no HTTP API).
// Goal: confirm a student publishing to siot/ict_up is received by a teacher
// subscribed to the SAME single topic (distinguished by payload.seat).
import mqtt from "mqtt";

const BROKER = "mqtt://127.0.0.1:1883";
const USER = "siot";
const PASS = "dfrobot";
const TOPIC = "siot/ict_up";

function mkClient(label) {
  return mqtt.connect(BROKER, {
    username: USER,
    password: PASS,
    clientId: `test_${label}_${Math.random().toString(16).slice(2, 8)}`,
    clean: true,
    connectTimeout: 8000,
  });
}

const results = [];
let done = false;

function finish(ok, msg) {
  if (done) return;
  done = true;
  console.log(`\n[RESULT] ${ok ? "PASS" : "FAIL"} - ${msg}`);
  sub.end(true);
  pub.end(true);
  process.exit(ok ? 0 : 1);
}

const sub = mkClient("sub");
const pub = mkClient("pub");

const recv = [];

sub.on("connect", () => {
  console.log("[sub] connected, subscribing to", TOPIC);
  sub.subscribe(TOPIC, { qos: 1 }, (err) => {
    if (err) return finish(false, "subscribe error: " + err.message);
    console.log("[sub] subscribed OK, publishing test message from pub...");
    // publish slightly after subscribe is established
    setTimeout(() => {
      const payload = JSON.stringify({ seat: "A12", machine_id: "STU_A12", type: "status", value: "doing", ts: Date.now() });
      pub.publish(TOPIC, payload, { qos: 1 }, (e) => {
        if (e) return finish(false, "publish error: " + e.message);
        console.log("[pub] published:", payload);
      });
    }, 400);
  });
});

sub.on("message", (topic, buf) => {
  const raw = buf.toString();
  console.log("[sub] RECEIVED on", topic, "->", raw);
  recv.push(raw);
  try {
    const p = JSON.parse(raw);
    if (p.seat === "A12" && p.value === "doing") {
      return finish(true, "teacher received student message on shared topic siot/ict_up");
    }
  } catch (_) {}
});

sub.on("error", (e) => finish(false, "sub error: " + e.message));
pub.on("error", (e) => finish(false, "pub error: " + e.message));

setTimeout(() => {
  finish(false, `timeout — received ${recv.length} messages, expected student payload`);
}, 8000);
