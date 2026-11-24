'use strict';
/* Koltuklar - iteriodev-comfort araci (acik kaynak, araci koltuk modullerine baglayan kok servis)
 * ile konusan istemci. Protokol: /run/iteriodev-comfort/ctl.sock, satir sonuyla ayrilmis JSON.
 *   gelen: {state:{seats:{pos,moving,job,memories,axes,hall,...}, parked, carOn}}  (acilista + degisince)
 *   giden: {op:'jog',seat,axis,dir}  {op:'stop'}  {op:'memory',seat,slot,save}  {op:'gentleman'}
 * Bu dosya SADECE sokete baglanir; koltugu hareket ettiren UDS'i comfort araci yapar.
 */
var net = require('net');

var CTL = process.env.COMFORT_CTL || '/run/iteriodev-comfort/ctl.sock';
var AXES = ['SLV', 'SHV', 'LNV', 'SNV', 'KHV'];   // ileri-geri, yukseklik, sirt, egim, baslik

function createComfort(opts) {
    opts = opts || {};
    var onState = typeof opts.onState === 'function' ? opts.onState : function () {};
    var ctl = opts.ctl || CTL;
    var sock = null, connected = false, buf = '', reconnectT = null, seats = null, car = {};

    function emit() { try { onState({ connected: connected, seats: seats, car: car }); } catch (e) {} }

    function connect() {
        if (sock) return;
        sock = net.connect(ctl);
        sock.setEncoding('utf8');
        sock.on('connect', function () { connected = true; emit(); send({ op: 'get' }); });
        sock.on('data', function (d) {
            buf += d;
            if (buf.length > 262144) buf = buf.slice(-65536);
            var n;
            while ((n = buf.indexOf('\n')) >= 0) {
                var line = buf.slice(0, n); buf = buf.slice(n + 1);
                var m; try { m = JSON.parse(line); } catch (e) { continue; }
                if (m && m.state) { if (m.state.seats) seats = m.state.seats; car = { parked: m.state.parked, carOn: m.state.carOn }; emit(); }
            }
        });
        sock.on('error', function () {});
        sock.on('close', function () { connected = false; sock = null; emit(); schedule(); });
    }
    function schedule() { if (reconnectT) return; reconnectT = setTimeout(function () { reconnectT = null; connect(); }, 2000); }
    function send(obj) { if (sock && connected && !sock.destroyed) { try { sock.write(JSON.stringify(obj) + '\n'); } catch (e) {} } }

    return {
        start: function () { connect(); },
        stop: function () { if (sock) { try { sock.destroy(); } catch (e) {} sock = null; } if (reconnectT) { clearTimeout(reconnectT); reconnectT = null; } },
        jog: function (seat, axis, dir) { send({ op: 'jog', seat: seat, axis: axis, dir: dir > 0 ? 1 : -1 }); },
        halt: function () { send({ op: 'stop' }); },
        memory: function (seat, slot, save) { send({ op: 'memory', seat: seat, slot: slot, save: !!save }); },
        gentleman: function () { send({ op: 'gentleman' }); },
        easyExit: function (seat, save) { send({ op: 'exit', seat: seat, save: !!save }); },
        setEasyExit: function (on) { send({ op: 'set', settings: { easyExit: !!on } }); },
        state: function () { return { connected: connected, seats: seats, car: car }; },
        AXES: AXES,
    };
}

module.exports = { createComfort: createComfort, AXES: AXES };
