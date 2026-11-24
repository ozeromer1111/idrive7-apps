'use strict';
/**
 * ECUHARD Bağlantı - araçtaki uzaktan bağlantı servisinin (ecuhard-link araci) ekran kumandası.
 *
 * Asıl bağlantıyı root SERVİS yapar (Store aracı "ECUHARD Bağlantı Servisi"): röleye yalnız o çıkabilir
 * (araçta internet uid-kapılı; uygulama çıkamaz). Servis durumu /var/opt/ecuhard-link/status.json'a yazar;
 * bu uygulama onu okuyup gösterir. "İZİN VER" düğmesi /var/opt/ecuhard-link/control.json'a {armed} yazar;
 * servis 1 sn içinde uygular (armed=false -> röleden tamamen kopar). "TAM YETKİ/YALNIZ OKU" yazma iznidir.
 *
 * Servis kurulu değilse (klasör yok) bu uygulama "Servisi Store'dan kur" der.
 * Yollar ECUHARD_LINK_DIR ile değişir (emülatör testi için).
 */
const fs = require('fs');
const path = require('path');
const mgu = require('./kit/mgu');
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
        let st = { armed: false, readonly: false, connected: false, online: false, since: 0, op: '', last_cmd: '', log: [] };
        let stMtime = 0, serviceSeen = false, writeFail = false;

        function readStatus() {
            try {
                const m = fs.statSync(STATUS).mtimeMs;
                serviceSeen = true;
                if (m === stMtime) return;
                stMtime = m;
                const j = JSON.parse(fs.readFileSync(STATUS, 'utf8'));
                if (j && typeof j === 'object') st = j;
            } catch (e) { /* servis henüz yazmadıysa / kurulu değilse */ }
        }
        function writeControl(armed, readonly) {
            try {
                fs.writeFileSync(CONTROL + '.new', JSON.stringify({ armed: armed, readonly: readonly }));
                fs.renameSync(CONTROL + '.new', CONTROL);
                st.armed = armed; st.readonly = readonly; writeFail = false;
            } catch (e) { writeFail = true; log.warn('control yazılamadı: ' + e); }
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
            if (!serviceSeen) return { w: 'SERVİS YOK', c: t.crit };
            if (!st.armed) return { w: 'KAPALI', c: t.dim };
            if (st.connected) return { w: 'BAĞLI', c: GREEN };
            return { w: 'BAĞLANIYOR', c: AMBER };
        }

        function drawMain(cv, t) {
            G.panel(cv, t, 24, 44, 760, 468, 'Bağlantı');
            const sw = statusWord(t);
            cv.circle(84, 150, 16, sw.c);
            cv.text(sw.w, 120, 168, 56, sw.c, { font: 'bold', spacing: 1 });
            let y = 232;
            if (!serviceSeen) {
                cv.text('Bağlantı servisi kurulu değil.', 48, y, 24, t.dim); y += 40;
                cv.text('Store > araçlar > "ECUHARD Bağlantı Servisi" → Kur.', 48, y, 23, t.dim); y += 40;
            } else if (st.armed && st.connected) {
                cv.text('Süre', 48, y, 24, t.dim); cv.text(fmtDur(st.since), 240, y, 24, t.text, { font: 'num' }); y += 44;
                cv.text('Operatör', 48, y, 24, t.dim); cv.text(st.op || '-', 240, y, 24, t.text); y += 44;
                cv.text('Son komut', 48, y, 24, t.dim);
                cv.text((st.last_cmd || '-').slice(0, 42), 240, y, 22, t.text, { font: 'mono' }); y += 44;
            } else if (st.armed) {
                cv.text('Araç röleye bağlanmaya çalışıyor…', 48, y, 24, t.dim); y += 44;
            } else {
                cv.text('Uzaktan bağlantı kapalı. Kimse araca giremez.', 48, y, 24, t.dim); y += 40;
                cv.text('Bağlanmak için İZİN VER.', 48, y, 24, t.dim); y += 40;
            }
            if (writeFail) { cv.text('Not: servis kurulmadan açıp kapatılamaz.', 48, y, 22, AMBER); y += 40; }

            const on = st.armed;
            G.button(cv, t, 48, 400, 340, 76, on ? 'İZNİ KAPAT' : 'İZİN VER', () => { writeControl(!st.armed, st.readonly); return render(); },
                { key: 'toggle', color: on ? t.crit : GREEN, primary: true });
            G.button(cv, t, 410, 400, 326, 76, st.readonly ? 'YALNIZ OKU' : 'TAM YETKİ', () => { writeControl(st.armed, !st.readonly); return render(); },
                { key: 'mode', color: st.readonly ? AMBER : null });

            G.panel(cv, t, 808, 44, 768, 468, 'Son komutlar');
            drawLog(cv, t, 832, 116, 8);
        }
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
            const net = st.online ? { text: 'ÇEVRİMİÇİ', color: GREEN } : { text: 'ÇEVRİMDIŞI', color: t.crit };
            const link = !serviceSeen ? { text: 'SERVİS YOK' }
                : st.armed ? (st.connected ? { text: 'BAĞLI', color: GREEN } : { text: 'AÇIK', color: AMBER })
                : { text: 'KAPALI' };
            G.frame(cv, t, ['Durum', 'Günlük'], page, [net, link]);
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
        ui.onClick('BTN_TOGGLE', () => { writeControl(!st.armed, st.readonly); return render(); });
        ui.onClick('BTN_MODE', () => { writeControl(st.armed, !st.readonly); return render(); });

        ctx.loop('MAIN', 4, render);
        render().then(() => log.info('ilk kare çizildi')).catch((e) => log.warn('ilk render: ' + e));
    },
});
