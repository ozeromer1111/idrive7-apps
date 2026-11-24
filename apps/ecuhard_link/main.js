'use strict';
/**
 * ECUHARD Bağlantı - araca uzaktan bağlantı (agent uygulamanın İÇİNDE; ayrı servis/exe YOK).
 *
 * "İZİN VER" düğmesi bağlantıyı açar (varsayılan KAPALI). Açıkken araç röleye (VPS) bağlanır,
 * operatör komutlarını yapar ve her komutu bu ekranda gösterir. "İZNİ KAPAT" ile anında kesilir.
 * "TAM YETKİ / YALNIZ OKU" yazma iznini kontrol eder.
 *
 * Güvenlik: gömülü ayarda yalnız araç anahtarı (akey) + röle sertifika parmak izi var; komut
 * çalıştırma yetkisi veren operatör anahtarı (okey) burada DEĞİL. Uygulama içinde çalıştığı için
 * erişim ekran/uygulama seviyesindedir (root değil).
 */
const mgu = require('./kit/mgu');
const G = require('./kit/gauges');
const { createAgent } = require('./agent-core');

const W = 1600, H = 520;
const GREEN = '#2fd27a', AMBER = '#ffb020';

mgu.run({
    async start(ctx) {
        const { ui, log } = ctx;
        let page = 0;
        let st = { armed: false, readonly: false, connected: false, since: 0, op: '', last_cmd: '', log: [] };

        const agent = createAgent({ onState: (s) => { st = s; } });
        agent.start();
        st = agent.getState();

        function setArmed(v) { agent.setArmed(v); st = agent.getState(); }
        function setReadonly(v) { agent.setReadonly(v); st = agent.getState(); }

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
            G.panel(cv, t, 24, 44, 760, 468, 'Bağlantı');
            const sw = statusWord(t);
            cv.circle(84, 150, 16, sw.c);
            cv.text(sw.w, 120, 168, 60, sw.c, { font: 'bold', spacing: 1 });
            let y = 232;
            if (st.armed && st.connected) {
                cv.text('Süre', 48, y, 24, t.dim); cv.text(fmtDur(st.since), 240, y, 24, t.text, { font: 'num' }); y += 44;
                cv.text('Operatör', 48, y, 24, t.dim); cv.text(st.op || '-', 240, y, 24, t.text); y += 44;
                cv.text('Son komut', 48, y, 24, t.dim);
                cv.text((st.last_cmd || '-').slice(0, 42), 240, y, 22, t.text, { font: 'mono' }); y += 44;
            } else if (st.armed) {
                cv.text('Araç röleye bağlanmaya çalışıyor…', 48, y, 24, t.dim); y += 44;
            } else {
                cv.text('Uzaktan bağlantı kapalı. Kimse araca giremez.', 48, y, 24, t.dim); y += 44;
                cv.text('Bağlanmak için İZİN VER.', 48, y, 24, t.dim); y += 44;
            }
            const on = st.armed;
            G.button(cv, t, 48, 400, 340, 76, on ? 'İZNİ KAPAT' : 'İZİN VER', () => { setArmed(!st.armed); return render(); },
                { key: 'toggle', color: on ? t.crit : GREEN, primary: true });
            G.button(cv, t, 410, 400, 326, 76, st.readonly ? 'YALNIZ OKU' : 'TAM YETKİ', () => { setReadonly(!st.readonly); return render(); },
                { key: 'mode', color: st.readonly ? AMBER : null });

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
            const t = ctx.theme(), cv = ctx.canvas(W, H).clear(t.bg);
            (page === 0 ? drawMain : drawLogPage)(cv, t);
            header(cv, t);
            await ui.image('MAIN_GFX', cv);
        }

        const flip = () => { page = 1 - page; return render(); };
        ui.onClick('BTN_PAGE', flip);
        ui.onClick('BTN_PREV', flip);
        ctx.onTab((i) => i !== page && flip());
        ui.onClick('BTN_TOGGLE', () => { setArmed(!st.armed); return render(); });
        ui.onClick('BTN_MODE', () => { setReadonly(!st.readonly); return render(); });

        ctx.loop('MAIN', 4, render);
        render().then(() => log.info('ilk kare çizildi')).catch((e) => log.warn('ilk render: ' + e));
    },
});
