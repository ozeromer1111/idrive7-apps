'use strict';
/**
 * ECUHARD Bağlantı - araçtaki uzaktan bağlantı agent'ının (ecuhard-link) ekran kumandası.
 *
 * Agent (root) /var/opt/ecuhard-link/status.json'a durumu + yapılan komutları yazar; bu uygulama onu
 * okuyup gösterir. Düğmeler /var/opt/ecuhard-link/control.json'a {armed, readonly} yazar; agent 1 sn
 * içinde uygular (armed=false -> röleden tamamen kopar; readonly=true -> yazma reddedilir).
 *
 * Bu uygulama araçla hiç konuşmaz (sinyal/DID yok); yalnız iki dosya üzerinden agent'ı yönetir.
 * Yollar ECUHARD_LINK_DIR ile değişir (emülatör testi için).
 */
const fs = require('fs');
const path = require('path');
const mgu = require('./kit/mgu');
const { withAlpha } = require('./kit/canvas');
const G = require('./kit/gauges');

const W = 1600, H = 520;
const GREEN = '#2fd27a', AMBER = '#ffb020';
const DIR = process.env.ECUHARD_LINK_DIR || '/var/opt/ecuhard-link';
const STATUS = path.join(DIR, 'status.json');
const CONTROL = path.join(DIR, 'control.json');

mgu.run({
    async start(ctx) {
        const { ui, log } = ctx;
        let page = 0;
        let st = { armed: true, readonly: false, connected: false, since: 0, op: '', last_cmd: '', log: [] };
        let stMtime = 0;

        function readStatus() {
            try {
                const m = fs.statSync(STATUS).mtimeMs;
                if (m === stMtime) return;
                stMtime = m;
                const j = JSON.parse(fs.readFileSync(STATUS, 'utf8'));
                if (j && typeof j === 'object') st = j;
            } catch (e) { /* agent henüz yazmadıysa varsayılan */ }
        }

        function writeControl(armed, readonly) {
            try {
                fs.mkdirSync(DIR, { recursive: true });
                fs.writeFileSync(CONTROL + '.new', JSON.stringify({ armed: armed, readonly: readonly }));
                fs.renameSync(CONTROL + '.new', CONTROL);
                st.armed = armed; st.readonly = readonly;   // anlık yansıma; agent birazdan teyit eder
            } catch (e) { log.warn('control yazılamadı: ' + e); }
        }

        function fmtDur(sinceSec) {
            if (!sinceSec) return '';
            let s = Math.max(0, Math.floor(Date.now() / 1000) - sinceSec);
            const h = Math.floor(s / 3600); s -= h * 3600;
            const m = Math.floor(s / 60); s -= m * 60;
            const p = (n) => String(n).padStart(2, '0');
            return (h ? h + ':' : '') + p(m) + ':' + p(s);
        }
        function hhmmss(tsSec) {
            const d = new Date((tsSec || 0) * 1000), p = (n) => String(n).padStart(2, '0');
            return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
        }

        function statusWord(t) {
            if (!st.armed) return { w: 'KAPALI', c: t.dim };
            if (st.connected) return { w: 'BAĞLI', c: GREEN };
            return { w: 'BAĞLANIYOR', c: AMBER };
        }

        /* ---------- Durum sayfası ---------- */
        function drawMain(cv, t) {
            // sol panel: durum + düğmeler
            G.panel(cv, t, 24, 44, 760, 468, 'Bağlantı');
            const sw = statusWord(t);
            cv.circle(84, 150, 16, sw.c);
            cv.text(sw.w, 120, 168, 60, sw.c, { font: 'bold', spacing: 1 });
            // ayrıntı
            let y = 232;
            if (st.armed && st.connected) {
                cv.text('Süre', 48, y, 24, t.dim); cv.text(fmtDur(st.since), 240, y, 24, t.text, { font: 'num' });
                y += 44;
                cv.text('Operatör', 48, y, 24, t.dim); cv.text(st.op || '-', 240, y, 24, t.text); y += 44;
                cv.text('Son komut', 48, y, 24, t.dim);
                cv.text((st.last_cmd || '-').slice(0, 42), 240, y, 22, t.text, { font: 'mono' }); y += 44;
            } else if (st.armed) {
                cv.text('Araç röleye bağlanmaya çalışıyor…', 48, y, 24, t.dim); y += 44;
            } else {
                cv.text('Uzaktan bağlantı kapalı. Kimse araca giremez.', 48, y, 24, t.dim); y += 44;
            }
            // düğmeler
            const tog = st.armed;
            G.button(cv, t, 48, 400, 340, 76, tog ? 'KAPAT' : 'AÇ', () => writeControl(!st.armed, st.readonly),
                { key: 'toggle', color: tog ? t.crit : GREEN, primary: true });
            G.button(cv, t, 410, 400, 326, 76, st.readonly ? 'YALNIZ OKU' : 'TAM YETKİ', () => writeControl(st.armed, !st.readonly),
                { key: 'mode', color: st.readonly ? AMBER : null });

            // sağ panel: son komutlar
            G.panel(cv, t, 808, 44, 768, 468, 'Son komutlar');
            drawLog(cv, t, 832, 116, 8);
        }

        /* ---------- Günlük sayfası ---------- */
        function drawLogPage(cv, t) {
            G.panel(cv, t, 24, 44, 1552, 468, 'Komut günlüğü');
            drawLog(cv, t, 48, 116, 15);
        }

        function drawLog(cv, t, x, y0, n) {
            const items = (st.log || []).slice(-n);
            if (!items.length) { cv.text('Henüz komut yok.', x, y0, 24, t.dim); return; }
            for (let i = 0; i < items.length; i++) {
                const e = items[i], y = y0 + i * 44;
                cv.text(hhmmss(e.ts), x, y, 22, t.dim, { font: 'num' });
                if (e.op) cv.text(e.op, x + 118, y, 22, t.accent2);
                cv.text(String(e.cmd || '').slice(0, 72), x + 232, y, 22, t.text, { font: 'mono' });
            }
        }

        function header(cv, t) {
            const badge = st.armed ? (st.connected ? { text: 'BAĞLI', color: GREEN } : { text: 'AÇIK', color: AMBER })
                                   : { text: 'KAPALI' };
            G.frame(cv, t, ['Durum', 'Günlük'], page, [badge]);
        }

        async function render() {
            readStatus();
            const t = ctx.theme(), cv = ctx.canvas(W, H).clear(t.bg);
            (page === 0 ? drawMain : drawLogPage)(cv, t);
            header(cv, t);
            await ui.image('MAIN_GFX', cv);
        }

        const flip = () => { page = 1 - page; return render(); };
        ui.onClick('BTN_PAGE', flip);
        ui.onClick('BTN_PREV', flip);
        ctx.onTab((i) => i !== page && flip());
        // standart düzende HMI düğmeleri
        ui.onClick('BTN_TOGGLE', () => { writeControl(!st.armed, st.readonly); return render(); });
        ui.onClick('BTN_MODE', () => { writeControl(st.armed, !st.readonly); return render(); });

        ctx.loop('MAIN', 4, render);
        render().then(() => log.info('ilk kare çizildi')).catch((e) => log.warn('ilk render: ' + e));
    },
});
