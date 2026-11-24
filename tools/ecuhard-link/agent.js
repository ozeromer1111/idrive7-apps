'use strict';
/* ECUHARD Baglanti - araç agent'i (node, /usr/bin/node ile calisir).
 * Roleye (VPS) baglanir, benim konsolumdan gelen komut/dosya isteklerini root olarak yapar,
 * her komutu durum+gunluk dosyasina yazar (ID7 ekran uygulamasi bunu gosterir).
 *
 * Kontrol (ID7 uygulamasi yazar):  CONTROL json {armed:bool, readonly:bool}
 *   armed=false  -> roleden tamamen kopar + calisan komutlari oldur (Kapat = kesin kesilir)
 *   readonly=true -> yazma/istek reddedilir (yalniz okuma)
 * Durum (uygulama okur):  STATUS json {armed,readonly,connected,since,op,last_cmd,log:[...]}
 *
 * Ayarlar ortam degiskeninden (gommede sabitlerle uretilir):
 *   CARLINK_HOST CARLINK_PORT CARLINK_AKEY CARLINK_ID CARLINK_NAME
 *   CARLINK_PLAIN=1 (TLS yok, yerel test)  CARLINK_PIN=<sha256 cert fp>  (uretimde sertifika sabiti)
 *   CARLINK_SHELL (varsayilan /bin/sh)  CARLINK_CONTROL  CARLINK_STATUS  CARLINK_AUDIT
 */
var net = require('net');
var tls = require('tls');
var cp = require('child_process');
var fs = require('fs');
var crypto = require('crypto');

var CFG = {
  host: process.env.CARLINK_HOST || '127.0.0.1',
  port: parseInt(process.env.CARLINK_PORT || '8792', 10),
  akey: process.env.CARLINK_AKEY || '',
  id: process.env.CARLINK_ID || 'car',
  name: process.env.CARLINK_NAME || 'BMW',
  ver: 1,
  plain: process.env.CARLINK_PLAIN === '1',
  pin: process.env.CARLINK_PIN || '',
  shell: process.env.CARLINK_SHELL || '/bin/sh',
  control: process.env.CARLINK_CONTROL || '/var/opt/ecuhard-link/control.json',
  status: process.env.CARLINK_STATUS || '/var/opt/ecuhard-link/status.json',
  audit: process.env.CARLINK_AUDIT || '/var/opt/ecuhard-link/audit.log',
};
var MAX_FRAME = 16 * 1024 * 1024;
var CHUNK = 64 * 1024;

var state = {
  armed: false, readonly: false,  // Izin Ver ile acilir (varsayilan kapali)
  connected: false, since: 0, op: '', last_cmd: '',
  log: [],                        // son komutlar (ekran icin)
};
var sock = null;
var children = {};                // rid -> child process
var reconnectT = null;

function now() { return Math.floor(Date.now() / 1000); }

function writeStatus() {
  var s = {
    armed: state.armed, readonly: state.readonly, connected: state.connected,
    since: state.since, op: state.op, last_cmd: state.last_cmd, log: state.log.slice(-40),
    ver: CFG.ver, ts: now(),
  };
  try { fs.writeFileSync(CFG.status + '.new', JSON.stringify(s)); fs.renameSync(CFG.status + '.new', CFG.status); } catch (e) {}
}

function audit(line) {
  try { fs.appendFileSync(CFG.audit, new Date().toISOString() + ' ' + line + '\n'); } catch (e) {}
}

function pushLog(entry) {
  entry.ts = now();
  state.log.push(entry);
  if (state.log.length > 60) state.log = state.log.slice(-60);
  writeStatus();
}

function readControl() {
  try {
    var c = JSON.parse(fs.readFileSync(CFG.control, 'utf8'));
    if (typeof c.armed === 'boolean') state.armed = c.armed;
    if (typeof c.readonly === 'boolean') state.readonly = c.readonly;
  } catch (e) { /* dosya yoksa varsayilan: acik + tam */ }
}

// ---- cerceve okuma/yazma ----
function frameBytes(obj) {
  var body = Buffer.from(JSON.stringify(obj), 'utf8');
  var hdr = Buffer.allocUnsafe(4);
  hdr.writeUInt32BE(body.length, 0);
  return Buffer.concat([hdr, body]);
}
function send(obj) {
  if (sock && !sock.destroyed) { try { sock.write(frameBytes(obj)); } catch (e) {} }
}

function makeParser(onMsg) {
  var buf = Buffer.alloc(0);
  return function (chunk) {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= 4) {
      var n = buf.readUInt32BE(0);
      if (n > MAX_FRAME) { if (sock) sock.destroy(); return; }
      if (buf.length < 4 + n) break;
      var body = buf.slice(4, 4 + n);
      buf = buf.slice(4 + n);
      var msg; try { msg = JSON.parse(body.toString('utf8')); } catch (e) { continue; }
      onMsg(msg);
    }
  };
}

// ---- istekler ----
function killChild(rid) {
  var ch = children[rid];
  if (ch) { try { ch.kill('SIGKILL'); } catch (e) {} delete children[rid]; }
}

function doExec(msg) {
  var rid = msg.rid, cmd = String(msg.cmd || '');
  state.op = msg.op || ''; state.last_cmd = cmd;
  pushLog({ op: msg.op || '', cmd: cmd });
  audit('EXEC [' + (msg.op || '') + '] ' + cmd);
  var ch;
  try { ch = cp.spawn(CFG.shell, ['-c', cmd], { windowsHide: true }); }
  catch (e) { send({ t: 'err', rid: rid, msg: String(e) }); return; }
  children[rid] = ch;
  ch.stdout.on('data', function (d) { streamOut(rid, d); });
  ch.stderr.on('data', function (d) { streamOut(rid, d); });
  ch.on('close', function (code) { delete children[rid]; send({ t: 'exit', rid: rid, code: code }); });
  ch.on('error', function (e) { delete children[rid]; send({ t: 'err', rid: rid, msg: String(e) }); });
}

function streamOut(rid, buf) {
  for (var i = 0; i < buf.length; i += CHUNK) {
    send({ t: 'out', rid: rid, data: buf.slice(i, i + CHUNK).toString('base64') });
  }
}

function doRead(msg) {
  var rid = msg.rid, path = String(msg.path || '');
  audit('READ [' + (msg.op || '') + '] ' + path);
  fs.readFile(path, function (err, data) {
    if (err) { send({ t: 'err', rid: rid, msg: String(err) }); return; }
    for (var i = 0; i < data.length; i += CHUNK) {
      var last = i + CHUNK >= data.length;
      send({ t: 'file', rid: rid, data: data.slice(i, i + CHUNK).toString('base64'), eof: last });
    }
    if (data.length === 0) send({ t: 'file', rid: rid, data: '', eof: true });
  });
}

function doWrite(msg) {
  var rid = msg.rid, path = String(msg.path || '');
  if (state.readonly) { send({ t: 'err', rid: rid, msg: 'yalniz-oku modu' }); return; }
  pushLog({ op: msg.op || '', cmd: 'YAZ ' + path });
  audit('WRITE [' + (msg.op || '') + '] ' + path);
  var data = Buffer.from(String(msg.data || ''), 'base64');
  fs.writeFile(path, data, function (err) {
    if (err) send({ t: 'err', rid: rid, msg: String(err) });
    else send({ t: 'exit', rid: rid, code: 0 });
  });
}

function doLs(msg) {
  var rid = msg.rid, path = String(msg.path || '/');
  fs.readdir(path, function (err, names) {
    if (err) { send({ t: 'err', rid: rid, msg: String(err) }); return; }
    var out = [];
    for (var i = 0; i < names.length; i++) {
      var full = path.replace(/\/+$/, '') + '/' + names[i];
      var dir = false, size = 0;
      try { var st = fs.statSync(full); dir = st.isDirectory(); size = st.size; } catch (e) {}
      out.push({ n: names[i], d: dir, s: size });
    }
    send({ t: 'file', rid: rid, data: Buffer.from(JSON.stringify(out)).toString('base64'), eof: true });
  });
}

function onMsg(msg) {
  var t = msg.t;
  if (t === 'exec') doExec(msg);
  else if (t === 'read') doRead(msg);
  else if (t === 'write') doWrite(msg);
  else if (t === 'ls') doLs(msg);
  else if (t === 'cancel') killChild(msg.rid);
  else if (t === 'ping') send({ t: 'pong' });
}

// ---- baglanti yasam dongusu ----
function connect() {
  if (!state.armed) return;
  var opts = { host: CFG.host, port: CFG.port };
  var onConnect = function () {
    send({ t: 'hello', role: 'agent', akey: CFG.akey, id: CFG.id, name: CFG.name, ver: CFG.ver,
           armed: state.armed, readonly: state.readonly });
  };
  if (CFG.plain) {
    sock = net.connect(opts, onConnect);
  } else {
    opts.rejectUnauthorized = !CFG.pin;   // pin varsa kendi dogrulamamiz; yoksa CA
    sock = tls.connect(opts, function () {
      if (CFG.pin) {
        var cert = sock.getPeerCertificate();
        var fp = cert && cert.raw ? crypto.createHash('sha256').update(cert.raw).digest('hex') : '';
        if (fp.toLowerCase() !== CFG.pin.toLowerCase()) { audit('PIN mismatch'); sock.destroy(); return; }
      }
      onConnect();
    });
  }
  var parse = makeParser(function (msg) {
    if (msg.t === 'hello_ok') {
      state.connected = true; state.since = now(); writeStatus();
      audit('CONNECTED role=' + CFG.host + ':' + CFG.port);
    } else if (msg.t === 'hello_fail') {
      audit('HELLO FAIL ' + (msg.why || '')); sock.destroy();
    } else if (state.connected) onMsg(msg);
  });
  sock.on('data', parse);
  sock.on('error', function (e) { audit('SOCK err ' + e.message); });
  sock.on('close', function () {
    state.connected = false; state.op = ''; writeStatus();
    for (var rid in children) killChild(rid);
    sock = null;
    scheduleReconnect();
  });
}

function scheduleReconnect() {
  if (reconnectT) return;
  reconnectT = setTimeout(function () { reconnectT = null; if (state.armed) connect(); }, 3000);
}

function supervise() {
  var wasArmed = state.armed;
  readControl();
  if (state.armed && !sock && !reconnectT) connect();
  if (!state.armed && sock) {
    audit('DISARMED - kapatiliyor');
    for (var rid in children) killChild(rid);
    try { sock.destroy(); } catch (e) {}
    sock = null;
  }
  // bagliyken armed/readonly degisirse roleye bildir
  if (state.connected && sock) send({ t: 'status', armed: state.armed, readonly: state.readonly, name: CFG.name, ver: CFG.ver });
  if (wasArmed !== state.armed) writeStatus();
}

function main() {
  try { fs.mkdirSync(require('path').dirname(CFG.status), { recursive: true }); } catch (e) {}
  readControl();
  writeStatus();
  audit('AGENT start id=' + CFG.id + ' ' + CFG.host + ':' + CFG.port);
  setInterval(supervise, 1000);
  setInterval(function () { if (state.connected) send({ t: 'status', armed: state.armed, readonly: state.readonly }); }, 25000);
  supervise();
}
main();
