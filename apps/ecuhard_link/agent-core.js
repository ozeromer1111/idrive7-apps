'use strict';
/* ECUHARD Baglanti - agent cekirdegi (uygulama icinde calisir, ayri servis/exe YOK).
 * Roleye (VPS) baglanir, operatörden gelen komut/dosya isteklerini yapar, her komutu
 * durum+gunluge yazar; ekran uygulamasi (main.js) bunu gosterir ve Izin Ver dugmesiyle
 * acip kapatir.
 *
 * GUVENLIK: burada yalnizca ARAC anahtari (akey) + role sertifika parmak izi (pin) var.
 * Komutu CALISTIRMA yetkisi veren OPERATOR anahtari (okey) burada DEGIL (yalniz VPS'te).
 * Bu yuzden bu dosya herkese acik depoda olabilir. Baglanti yalnizca Izin Ver aciksa kurulur
 * (varsayilan KAPALI). Uygulama icinde calistigi icin erisim ekran/uygulama seviyesindedir (root degil).
 */
var net = require('net');
var tls = require('tls');
var cp = require('child_process');
var fs = require('fs');
var crypto = require('crypto');

var DEFAULTS = {
  host: '72.62.90.188',
  port: 8792,
  akey: 'hN3eAlQiOEU5pOM76x23FjqEV3jPYKTj',
  pin: 'da5bfa6496e52848cea1252b314e5ad76c85a643ab9bb7df2f01c563f46e8d5b',
  id: 'WBAGV4C00NCH67131',
  name: 'BMW 840i',
};

var MAX_FRAME = 16 * 1024 * 1024;
var CHUNK = 64 * 1024;

function now() { return Math.floor(Date.now() / 1000); }

function createAgent(opts) {
  opts = opts || {};
  var env = (typeof process !== 'undefined' && process.env) || {};
  var CFG = {
    host: opts.host || env.CARLINK_HOST || DEFAULTS.host,
    port: parseInt(opts.port || env.CARLINK_PORT || DEFAULTS.port, 10),
    akey: opts.akey || env.CARLINK_AKEY || DEFAULTS.akey,
    pin: (opts.pin || env.CARLINK_PIN || DEFAULTS.pin),
    id: opts.id || env.CARLINK_ID || DEFAULTS.id,
    name: opts.name || env.CARLINK_NAME || DEFAULTS.name,
    plain: (opts.plain != null ? opts.plain : env.CARLINK_PLAIN === '1'),
    shell: opts.shell || env.CARLINK_SHELL || '/bin/sh',
    ver: 1,
  };
  var onState = typeof opts.onState === 'function' ? opts.onState : function () {};

  var state = {
    armed: false, readonly: false,         // varsayilan KAPALI: yalniz Izin Ver'le baglanir
    connected: false, since: 0, op: '', last_cmd: '', log: [],
  };
  var sock = null, children = {}, reconnectT = null, timer = null;

  function emit() { try { onState(getState()); } catch (e) {} }
  function getState() {
    return { armed: state.armed, readonly: state.readonly, connected: state.connected,
             since: state.since, op: state.op, last_cmd: state.last_cmd, log: state.log.slice(-40) };
  }
  function pushLog(entry) {
    entry.ts = now();
    state.log.push(entry);
    if (state.log.length > 60) state.log = state.log.slice(-60);
    emit();
  }

  function frameBytes(obj) {
    var body = Buffer.from(JSON.stringify(obj), 'utf8');
    var hdr = Buffer.allocUnsafe(4);
    hdr.writeUInt32BE(body.length, 0);
    return Buffer.concat([hdr, body]);
  }
  function send(obj) { if (sock && !sock.destroyed) { try { sock.write(frameBytes(obj)); } catch (e) {} } }

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

  function killChild(rid) {
    var ch = children[rid];
    if (ch) { try { ch.kill('SIGKILL'); } catch (e) {} delete children[rid]; }
  }
  function streamOut(rid, buf) {
    for (var i = 0; i < buf.length; i += CHUNK) send({ t: 'out', rid: rid, data: buf.slice(i, i + CHUNK).toString('base64') });
  }
  function doExec(msg) {
    var rid = msg.rid, cmd = String(msg.cmd || '');
    state.op = msg.op || ''; state.last_cmd = cmd;
    pushLog({ op: msg.op || '', cmd: cmd });
    var ch;
    try { ch = cp.spawn(CFG.shell, ['-c', cmd], { windowsHide: true }); }
    catch (e) { send({ t: 'err', rid: rid, msg: String(e) }); return; }
    children[rid] = ch;
    ch.stdout.on('data', function (d) { streamOut(rid, d); });
    ch.stderr.on('data', function (d) { streamOut(rid, d); });
    ch.on('close', function (code) { delete children[rid]; send({ t: 'exit', rid: rid, code: code }); });
    ch.on('error', function (e) { delete children[rid]; send({ t: 'err', rid: rid, msg: String(e) }); });
  }
  function doRead(msg) {
    var rid = msg.rid, p = String(msg.path || '');
    fs.readFile(p, function (err, data) {
      if (err) { send({ t: 'err', rid: rid, msg: String(err) }); return; }
      for (var i = 0; i < data.length; i += CHUNK) send({ t: 'file', rid: rid, data: data.slice(i, i + CHUNK).toString('base64'), eof: i + CHUNK >= data.length });
      if (data.length === 0) send({ t: 'file', rid: rid, data: '', eof: true });
    });
  }
  function doWrite(msg) {
    var rid = msg.rid, p = String(msg.path || '');
    if (state.readonly) { send({ t: 'err', rid: rid, msg: 'yalniz-oku modu' }); return; }
    pushLog({ op: msg.op || '', cmd: 'YAZ ' + p });
    fs.writeFile(p, Buffer.from(String(msg.data || ''), 'base64'), function (err) {
      if (err) send({ t: 'err', rid: rid, msg: String(err) }); else send({ t: 'exit', rid: rid, code: 0 });
    });
  }
  function doLs(msg) {
    var rid = msg.rid, p = String(msg.path || '/');
    fs.readdir(p, function (err, names) {
      if (err) { send({ t: 'err', rid: rid, msg: String(err) }); return; }
      var out = [];
      for (var i = 0; i < names.length; i++) {
        var full = p.replace(/\/+$/, '') + '/' + names[i], dir = false, size = 0;
        try { var s = fs.statSync(full); dir = s.isDirectory(); size = s.size; } catch (e) {}
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

  function connect() {
    if (!state.armed || sock) return;
    var opts2 = { host: CFG.host, port: CFG.port };
    var hello = function () {
      send({ t: 'hello', role: 'agent', akey: CFG.akey, id: CFG.id, name: CFG.name, ver: CFG.ver,
             armed: state.armed, readonly: state.readonly });
    };
    if (CFG.plain) {
      sock = net.connect(opts2, hello);
    } else {
      opts2.rejectUnauthorized = !CFG.pin;
      sock = tls.connect(opts2, function () {
        if (CFG.pin) {
          var cert = sock.getPeerCertificate();
          var fp = cert && cert.raw ? crypto.createHash('sha256').update(cert.raw).digest('hex') : '';
          if (fp.toLowerCase() !== CFG.pin.toLowerCase()) { sock.destroy(); return; }
        }
        hello();
      });
    }
    var parse = makeParser(function (msg) {
      if (msg.t === 'hello_ok') { state.connected = true; state.since = now(); emit(); }
      else if (msg.t === 'hello_fail') { if (sock) sock.destroy(); }
      else if (state.connected) onMsg(msg);
    });
    sock.on('data', parse);
    sock.on('error', function () {});
    sock.on('close', function () {
      state.connected = false; state.op = ''; emit();
      for (var rid in children) killChild(rid);
      sock = null;
      if (state.armed) scheduleReconnect();
    });
  }
  function scheduleReconnect() {
    if (reconnectT) return;
    reconnectT = setTimeout(function () { reconnectT = null; if (state.armed) connect(); }, 3000);
  }
  function disconnect() {
    for (var rid in children) killChild(rid);
    if (sock) { try { sock.destroy(); } catch (e) {} sock = null; }
    if (reconnectT) { clearTimeout(reconnectT); reconnectT = null; }
    state.connected = false; state.op = ''; emit();
  }

  function setArmed(v) {
    v = !!v;
    if (v === state.armed) return;
    state.armed = v; emit();
    if (v) connect(); else disconnect();
  }
  function setReadonly(v) {
    state.readonly = !!v; emit();
    if (state.connected) send({ t: 'status', armed: state.armed, readonly: state.readonly });
  }

  function keepalive() { if (state.connected) send({ t: 'status', armed: state.armed, readonly: state.readonly }); }

  function start() {
    if (timer) return;
    timer = setInterval(function () { if (state.armed && !sock && !reconnectT) connect(); }, 2000);
    setInterval(keepalive, 25000);
    emit();
  }
  function stop() { if (timer) { clearInterval(timer); timer = null; } disconnect(); }

  return { start: start, stop: stop, setArmed: setArmed, setReadonly: setReadonly, getState: getState };
}

module.exports = { createAgent: createAgent };
