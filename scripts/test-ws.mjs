// V-3: WebSocket (1888) MQTT forwarding on siot/ topics — used by Electron renderer.
import mqtt from "mqtt";

const BROKER = "ws://127.0.0.1:1888/ws";
const USER = "siot";
const PASS = "dfrobot";
const TOPIC = "siot/ict_ws_test";

let done = false;
function finish(ok, msg) {
  if (done) return;
  done = true;
  console.log(`\n[RESULT] ${ok ? "PASS" : "FAIL"} - ${msg}`);
  try { sub.end(true); } catch (_) {}
  try { pub.end(true); } catch (_) {}
  // let stdout flush, then exit
  setTimeout(() => process.exit(ok ? 0 : 1), 200);
}

const sub = mqtt.connect(BROKER, { username: USER, password: PASS, clientId: "ws_sub_" + Math.random().toString(16).slice(2,8), clean: true, connectTimeout: 8000 });
const pub = mqtt.connect(BROKER, { username: USER, password: PASS, clientId: "ws_pub_" + Math.random().toString(16).slice(2,8), clean: true, connectTimeout: 8000 });

sub.on("connect", () => {
  console.log("[ws-sub] connected via WebSocket, subscribing", TOPIC);
  sub.subscribe(TOPIC, { qos: 1 }, (err) => {
    if (err) { console.log("[ws-sub] subscribe ERR:", err.message); return finish(false, "ws subscribe error: " + err.message); }
    console.log("[ws-sub] subscribed OK");
    setTimeout(() => {
      const p = JSON.stringify({ seat: "B07", via: "websocket", value: "help" });
      pub.publish(TOPIC, p, { qos: 1 }, (e) => {
        if (e) { console.log("[ws-pub] publish ERR:", e.message); return finish(false, "ws publish error: " + e.message); }
        console.log("[ws-pub] published:", p);
      });
    }, 500);
  });
});
sub.on("message", (t, b) => {
  console.log("[ws-sub] RECEIVED on", t, "->", b.toString());
  try { const p = JSON.parse(b.toString()); if (p.via === "websocket" && p.value === "help") return finish(true, "WebSocket MQTT forwarding works on siot/ topics"); } catch (_) {}
});
sub.on("error", (e) => { console.log("[ws-sub] ERROR:", e.message); finish(false, "ws sub error: " + e.message); });
pub.on("error", (e) => { console.log("[ws-pub] ERROR:", e.message); finish(false, "ws pub error: " + e.message); });
setTimeout(() => { console.log("[timeout] no message received in 10s"); finish(false, "ws timeout — no message received"); }, 10000);
