'use strict';
/**
 * Fuel Analysis - everything about the fuel on one screen (read-only).
 *
 *   - fuel in the tank (litres, both halves, range)      the car's own signal, else the engine unit
 *   - consumption now (l/h, and l/100 km while moving)   engine unit
 *   - ethanol in the fuel (%)                            engine unit
 *   - octane as the engine adapted to it (RON 91..98)    engine unit: knock adaptation, not a lab value
 *   - fuel temperature                                   engine unit
 *   - high pressure (rail, with its target) / low pressure
 *   - time since the last refuelling
 *
 * Engine unit values are read with UDS 0x22 (candidates in app.json config.dme): the fast ones
 * (consumption, pressures) about once a second while the screen is shown, the rest every 10 s.
 * With no car attached demo data drives the tiles; a DEMO badge is drawn whenever it does.
 */
const mgu = require('./kit/mgu');
const { withAlpha } = require('./kit/canvas');
const G = require('./kit/gauges');
const { Diag } = require('./kit/diag');
const { DidReader } = require('./kit/dids');

const W = 1600, H = 520;
const GO = '#2fd27a';
const FAST = ['flow', 'hpfp', 'hpfpTarget', 'lpfp'];
const SLOW = ['ethanol', 'ron', 'fuelTemp', 'sinceFill'];
const TANK = ['tank', 'tankL', 'tankR'];
const HIST_MS = 5 * 60000;
const CONS = { VERBRAUCH_IN_L_S_100KM: 'l/100 km', VERBRAUCH_IN_MPG_UK: 'mpg', VERBRAUCH_IN_MPG_US: 'mpg US', VERBRAUCH_IN_KM_S_L: 'km/l', 1: 'l/100 km', 2: 'mpg', 3: 'mpg US', 4: 'km/l' };

mgu.run({
    async start(ctx) {
        const { ui, settings, log } = ctx;
        const dme = Object.assign({ ecu: 18 }, (ctx.spec.config && ctx.spec.config.dme) || {});
        const live = {}, at = {}, fail = {}, tried = {};
        const hist = { flow: [], hpfp: [], hpfpTarget: [], lpfp: [], fuelTemp: [] };
        const startT = Date.now();
        let lastCar = 0, kombiTank = 0;

        const put = (k, v) => {
            if (!G.isNum(v)) return;
            live[k] = v; at[k] = Date.now(); lastCar = at[k];
        };

        /* ---------- the car's own signals ---------- */
        const ok = (v, max) => (G.isNum(v) && v >= 0 && v < max ? v : null);
        const watches = [
            ['de.bmw.infotainment.KombiIF', {
                statusRangeTankStatus: (v) => {
                    if (!v) return;
                    const tk = ok(v.fluidLevelFuelTank, 255);
                    if (tk !== null) { put('tank', tk); kombiTank = Date.now(); }
                    put('tankL', ok(v.fluidLevelFuelTankLeftHand, 255));
                    put('tankR', ok(v.fluidLevelFuelTankRightHand, 255));
                    put('range', ok(v.range, 4095));
                },
                // the on-board computer's average (trip 1), 0.1 per bit in the car's consumption unit
                statusBordcomputerAverage: (v) => {
                    if (!v || !G.isNum(v.consumptionAverage1BC1) || v.consumptionAverage1BC1 >= 65535) return;
                    put('avg', v.consumptionAverage1BC1 * 0.1);
                    live.avgUnit = CONS[v.statusUnitOfMeasurementConsumptionBC] || 'l/100 km';
                },
            }],
            ['de.bmw.infotainment.vehicle.Vehicle2', {
                statusCarSpeed2: (v) => { const r = v && v.speedVehicleCentreOfGravity; if (G.isNum(r) && r !== 65535) put('speed', r * 0.015625); },
            }],
        ];
        const subs = [];
        Promise.all(watches.map(([iface, h]) => ctx.signals.watch(iface, '1', h, log).then((s) => { subs.push(s); return s; })))
            .then((all) => log.info('signals: ' + all.map((s) => s.iface.split('.').pop() + (s.error ? '(err)' : '')).join(' ')))
            .catch((e) => log.warn('signals: ' + e));

        /* ---------- the engine unit ---------- */
        const link = new Diag(ctx.signals, log);
        link.quiet = true;
        link.init();
        const rd = new DidReader(link, { ecu: dme.ecu });
        let busy = false, round = 0, timer = null;

        async function readKey(k) {
            // a value the engine unit refuses is only tried again every 30 s
            if ((fail[k] || 0) >= 3 && Date.now() - (tried[k] || 0) < 30000) return;
            tried[k] = Date.now();
            const v = await rd.value(k, dme[k]);
            if (v === null) { fail[k] = (fail[k] || 0) + 1; return; }
            fail[k] = 0;
            put(k, v);
            if (hist[k]) {
                const now = Date.now(), h = hist[k];
                if (!h.length || now - h[h.length - 1][0] >= 2000) h.push([now, v]);
                while (h.length && now - h[0][0] > HIST_MS) h.shift();
            }
        }
        async function poll() {
            busy = true;
            const shown = ui.isVisible('MAIN');
            try {
                if (shown && link.available) {
                    for (const k of FAST) await readKey(k);
                    if (round % 10 === 0) {
                        for (const k of SLOW) await readKey(k);
                        // the tank from the engine unit only while the car's own signal sends none
                        if (Date.now() - kombiTank > 30000) for (const k of TANK) await readKey(k);
                    }
                    round++;
                }
            } catch (e) { log.warn('poll: ' + (e && e.message || e)); }
            busy = false;
            timer = setTimeout(poll, shown ? 900 : 3000);
        }
        timer = setTimeout(poll, 1000);

        /* ---------- demo ---------- */
        const carPresent = () => lastCar > 0 || subs.some((s) => s.available);
        const usingDemo = () => settings.get('demo') === 'on' || (settings.get('demo') === 'auto' && !carPresent() && Date.now() - startT > 5000);
        const demoHist = { flow: [], hpfp: [], hpfpTarget: [], lpfp: [], fuelTemp: [] };
        function demoData() {
            const s = (Date.now() - startT) / 1000, pull = Math.max(0, Math.sin(s / 7)), size = settings.get('tankSize') || 68;
            const d = {
                tank: Math.round(size * 0.6), tankL: Math.round(size * 0.29), tankR: Math.round(size * 0.31), range: 452,
                speed: 40 + pull * 120, flow: 1.2 + pull * 46, ethanol: 9.4, ron: 96.4, fuelTemp: 31 + 4 * Math.sin(s / 60),
                hpfp: 60 + pull * 280, hpfpTarget: 62 + pull * 285 + (pull > 0.9 ? 30 : 0), avg: 9.8, avgUnit: 'l/100 km', lpfp: 5.6 - pull * 0.8, sinceFill: 26.5,
            };
            Object.keys(demoHist).forEach((k) => { const h = demoHist[k]; if (!h.length || Date.now() - h[h.length - 1][0] >= 2000) h.push([Date.now(), d[k]]); if (h.length > 150) h.shift(); });
            return d;
        }
        /** What the screen shows: demo data, or the car's values while they are fresh. */
        function data() {
            if (usingDemo()) return { d: demoData(), h: demoHist, demo: true };
            const d = {}, now = Date.now();
            const fresh = { flow: 6000, hpfp: 6000, hpfpTarget: 6000, lpfp: 6000, speed: 5000 };
            Object.keys(live).forEach((k) => { if (now - at[k] < (fresh[k] || 60000) || TANK.indexOf(k) >= 0 || k === 'range' || k === 'avg' || k === 'avgUnit') d[k] = live[k]; });
            return { d, h: hist, demo: false };
        }

        /* ---------- units ---------- */
        const F = () => settings.get('tempUnit') === 'f';
        const T = (c) => (G.isNum(c) ? (F() ? c * 9 / 5 + 32 : c) : null);
        const tU = () => (F() ? '°F' : '°C');
        const PSI = () => settings.get('pressUnit') === 'psi';
        const P = (bar) => (G.isNum(bar) ? (PSI() ? bar * 14.5038 : bar) : null);
        const pU = () => (PSI() ? 'psi' : 'bar');

        /** Why an engine unit value is missing, for its tile. */
        function why(k) {
            if (!link.p) return 'no diagnostic link';
            if (!link.available) return 'diagnostic link down';
            return (fail[k] || 0) >= 3 ? 'not available from this engine unit' : 'reading...';
        }
        /** min / max of a history for a tile's last line. */
        const mm = (h, f, dec) => {
            const v = h.map((p) => p[1]).filter(G.isNum);
            return v.length ? 'last 5 min  ·  min ' + G.fmt(f(Math.min.apply(null, v)), dec) + '  max ' + G.fmt(f(Math.max.apply(null, v)), dec) : 'last 5 min';
        };
        const trace = (h, f) => h.map((p) => f(p[1]));

        /**
         * Rail pressure, target against actual: the actual value big, the target beside it, how far under /
         * over it is, and both over the last 5 minutes (target as a thin line). Under the target by more
         * than the tolerance is the one that matters (the pump does not keep up): red; over it: amber.
         */
        function pairTile(cv, t, x, y, w, h, g) {
            const p = G.panel(cv, t, x, y, w, h, g.label), yb = p.y + p.h;
            const a = g.actual, tg = g.target, has = G.isNum(a), big = 72;
            const gap = has && G.isNum(tg) ? a - tg : null, off = G.isNum(gap) && Math.abs(gap) >= g.tol;
            const col = !has ? t.dim : !off ? t.text : gap < 0 ? t.crit : t.warn;
            const base = y + 52 + big * 0.78;
            const vw = cv.text(has ? G.fmt(a, g.decimals) : '--', x + 18, base, big, col, { font: 'num' });
            if (has) cv.text(g.unit, x + 26 + vw, base, 26, t.dim);
            const r = x + w - 18;
            cv.text('TARGET', r, y + 70, 18, t.dim, { font: 'bold', spacing: 1.5, align: 'right' });
            cv.text(G.isNum(tg) ? G.fmt(tg, g.decimals) : '--', r, y + 108, 34, G.isNum(tg) ? t.text : t.dim, { font: 'num', align: 'right' });
            const ha = g.histA || [], ht = g.histT || [], all = ha.concat(ht).filter(G.isNum);
            if (all.length > 2) {
                const hx = x + 18, hw = w - 36, hy = yb - G.MARGIN - 28, hh = Math.min(44, hy - (y + 122) - 8);
                let lo = Math.min.apply(null, all), hi = Math.max.apply(null, all);
                if (hi - lo < 1e-6) { lo -= 1; hi += 1; }
                const pts = (hs) => hs.map((q, i) => [hx + (i / Math.max(1, hs.length - 1)) * hw, G.isNum(q) ? hy - ((q - lo) / (hi - lo)) * hh : hy]);
                if (hh > 8 && ha.filter(G.isNum).length > 2) { const pa = pts(ha); cv.fillUnder(pa, hy, withAlpha(t.accent, 0.16)); cv.polyline(pa, 2.5, withAlpha(t.accent, 0.85)); }
                if (hh > 8 && ht.filter(G.isNum).length > 2) cv.polyline(pts(ht), 1.5, withAlpha(t.text, 0.55));
            }
            const sub = !has ? g.why : !G.isNum(tg) ? g.noTarget
                : !off ? 'on target  ·  ' + (gap >= 0 ? '+' : '') + G.fmt(gap, g.decimals) + ' ' + g.unit
                    : (gap > 0 ? '+' : '') + G.fmt(gap, g.decimals) + ' ' + g.unit + (gap > 0 ? ' over target' : ' under target');
            cv.text(sub, x + 18, yb - G.MARGIN, 22, off ? col : t.dim, { spacing: 0.5 });
        }

        /** Eight tiles, four a row. */
        function grid(n) {
            const per = 4, rows = Math.ceil(n / per), gap = 16, out = [];
            const h = (G.BOTTOM - G.TOP - gap * (rows - 1)) / rows;
            for (let r = 0; r < rows; r++) {
                const k = Math.min(per, n - r * per), w = (1552 - 24 * (k - 1)) / k;
                for (let c = 0; c < k; c++) out.push({ x: 24 + c * (w + 24), y: G.TOP + r * (h + gap), w, h });
            }
            return out;
        }

        async function render() {
            const t = ctx.theme(), { d, h, demo } = data();
            const cv = ctx.canvas(W, H).clear(t.bg);
            const none = (k) => (demo ? 'no data' : why(k));
            const size = settings.get('tankSize') || 68;
            const id = (x) => x;

            // tank: litres, the halves and the range below
            const halves = G.isNum(d.tankL) && G.isNum(d.tankR) ? 'left ' + G.fmt(d.tankL, 0) + ' l  ·  right ' + G.fmt(d.tankR, 0) + ' l' : '';
            const range = G.isNum(d.range) ? G.fmt(d.range, 0) + ' km' : '';
            // consumption per 100 km only while moving
            const per100 = G.isNum(d.flow) && G.isNum(d.speed) ? (d.speed < 5 ? 'standing' : G.fmt(d.flow / d.speed * 100, 1) + ' l/100 km') : '';
            const eth = d.ethanol;
            const ethName = !G.isNum(eth) ? '' : eth < 2.5 ? 'E0' : eth < 7.5 ? 'E5' : eth < 15 ? 'E10' : eth < 50 ? 'E' + Math.round(eth / 5) * 5 : 'E85 / flex fuel';
            const tiles = [
                { label: 'Fuel in the tank', value: d.tank, unit: 'l', decimals: 0,
                    zones: [{ from: -1, to: size * 0.1, color: 'crit' }, { from: size * 0.1, to: size * 0.2, color: 'warn' }],
                    sub: G.isNum(d.tank) ? ([halves, range].filter(id).join('  ·  ') || G.fmt(d.tank / size * 100, 0) + ' %') : none('tank') },
                { label: 'Consumption now', value: d.flow, unit: 'l/h', decimals: 1, history: trace(h.flow, id),
                    sub: G.isNum(d.flow) ? [per100, G.isNum(d.avg) ? 'AVG ' + G.fmt(d.avg, 1) + (per100 && d.avgUnit === 'l/100 km' ? '' : ' ' + d.avgUnit) : ''].filter(id).join('  ·  ') || mm(h.flow, id, 1)
                        : G.isNum(d.avg) ? 'AVG ' + G.fmt(d.avg, 1) + ' ' + d.avgUnit : none('flow') },
                { label: 'Ethanol in the fuel', value: eth, unit: '%', decimals: 0,
                    sub: G.isNum(eth) ? ethName : none('ethanol') },
                { label: 'Octane (adapted)', value: d.ron, unit: 'RON', decimals: 1, valueColor: G.isNum(d.ron) && d.ron >= 97 ? GO : null,
                    zones: [{ from: 0, to: 93, color: 'crit' }, { from: 93, to: 95, color: 'warn' }],
                    sub: G.isNum(d.ron) ? "engine's knock adaptation, 91-98" : none('ron') },
                { label: 'Fuel temperature', value: T(d.fuelTemp), unit: tU(), decimals: 0, history: trace(h.fuelTemp, T),
                    zones: [{ from: T(60), to: T(75), color: 'warn' }, { from: T(75), to: 999, color: 'crit' }],
                    sub: G.isNum(d.fuelTemp) ? mm(h.fuelTemp, T, 0) : none('fuelTemp') },
                { draw: (c, th, x, y, w, hh) => pairTile(c, th, x, y, w, hh, {
                    label: 'High pressure: target vs actual', actual: P(d.hpfp), target: P(d.hpfpTarget), unit: pU(), decimals: 0, tol: P(15),
                    why: none('hpfp'), noTarget: G.isNum(fail.hpfpTarget) && fail.hpfpTarget >= 3 ? 'no target from this engine unit' : mm(h.hpfp, P, 0),
                    histA: trace(h.hpfp, P), histT: trace(h.hpfpTarget, P) }) },
                { label: 'Low pressure fuel', value: P(d.lpfp), unit: pU(), decimals: PSI() ? 0 : 1, history: trace(h.lpfp, P),
                    zones: [{ from: -99, to: P(3), color: 'crit' }, { from: P(3), to: P(4), color: 'warn' }],
                    sub: G.isNum(d.lpfp) ? mm(h.lpfp, P, PSI() ? 0 : 1) : none('lpfp') },
                { label: 'Since refuelling', value: d.sinceFill, unit: 'h', decimals: 1,
                    sub: G.isNum(d.sinceFill) ? 'engine running time' : none('sinceFill') },
            ];
            grid(tiles.length).forEach((b, i) => (tiles[i].draw ? tiles[i].draw(cv, t, b.x, b.y, b.w, b.h) : G.stat(cv, t, b.x, b.y, b.w, b.h, Object.assign({ size: 72 }, tiles[i]))));
            G.frame(cv, t, ['Fuel'], 0, [demo && { text: 'DEMO' }]);
            await ui.image('MAIN_GFX', cv);
        }

        ctx.loop('MAIN', 4, render);
        render().catch((e) => log.warn('first render: ' + e));
    },
});
