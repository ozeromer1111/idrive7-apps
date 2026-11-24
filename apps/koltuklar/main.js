'use strict';
/**
 * Koltuklar - ön koltukları ekrandan ayarlama. Asıl hareketi iteriodev-comfort aracı (açık kaynak,
 * koltuk modüllerine UDS yazan kök servis) yapar; bu uygulama /run/iteriodev-comfort/ctl.sock
 * üzerinden ona komut gönderen bir arayüzdür (kendi kodumuz, kendi tasarımımız).
 *
 * Kit dokunmayla çalışır (basılı-tut yok): bir yöne dokun -> koltuk hareket eder (300 ms'de bir jog),
 * tekrar dokun ya da DURDUR -> durur. M1-M3 hafıza, Yolcu için Yer Aç (park halinde).
 */
const mgu = require('./kit/mgu');
const G = require('./kit/gauges');
const { createComfort } = require('./comfort-client');

const W = 1600, H = 520;
const GREEN = '#2fd27a', AMBER = '#ffb020';

// eksen -> Türkçe ad + iki yön etiketi (a = dir +1, b = dir -1)
const AX = {
    SLV: { name: 'İleri / Geri', a: 'İleri', b: 'Geri' },
    SHV: { name: 'Yükseklik', a: 'Yukarı', b: 'Aşağı' },
    LNV: { name: 'Sırt', a: 'Dik', b: 'Yatır' },
    SNV: { name: 'Oturak eğimi', a: 'Ön ▲', b: 'Ön ▼' },
    KHV: { name: 'Başlık', a: 'Baş ▲', b: 'Baş ▼' },
};
const AX_ORDER = ['SLV', 'SHV', 'LNV', 'SNV', 'KHV'];

mgu.run({
    async start(ctx) {
        const { ui, log, settings } = ctx;
        let cs = { connected: false, seats: null, car: {} };
        let active = null, jogT = null, saveMode = false, saveFlash = 0;

        const comfort = createComfort({ onState: (s) => { cs = s; } });
        comfort.start();

        function stopJog() {
            if (jogT) { clearInterval(jogT); jogT = null; }
            active = null;
            comfort.halt();
        }
        function startJog(seat, axis, dir) {
            if (active && active.seat === seat && active.axis === axis && active.dir === dir) { stopJog(); return; }
            if (jogT) { clearInterval(jogT); jogT = null; }
            comfort.halt();
            active = { seat, axis, dir };
            comfort.jog(seat, axis, dir);
            jogT = setInterval(() => comfort.jog(seat, axis, dir), 300);
        }
        function memoryTap(seat, slot) {
            stopJog();
            if (saveMode) { comfort.memory(seat, slot, true); saveMode = false; saveFlash = Date.now(); }
            else comfort.memory(seat, slot, false);   // geri çağır (koltuk hareket eder)
        }

        const seatsState = () => (cs.seats || {});
        const axesOf = (seat) => ((seatsState().axes || {})[seat] || []);
        const memOf = (seat) => ((seatsState().memories || {})[seat] || [null, null, null]);
        const movingNow = () => seatsState().moving || null;   // {seat,axis}
        const jobNow = () => seatsState().job || null;

        function seatTitle(seat) { return seat === 'driver' ? 'Sürücü' : 'Yolcu'; }

        /* bir koltuğun yarısı */
        function drawSeat(cv, t, x0, seat) {
            const w = 756;
            G.panel(cv, t, x0, 44, w, 468, seatTitle(seat));
            const axes = axesOf(seat);
            if (!cs.connected) return;
            if (!axes.length) {
                cv.text('Bu koltuk yanıt vermiyor', x0 + 24, 150, 26, t.dim);
                cv.text('(hafızasız koltuk ya da modül kapalı)', x0 + 24, 190, 22, t.dim);
                return;
            }
            const mv = movingNow();
            let y = 104;
            AX_ORDER.filter((a) => axes.indexOf(a) >= 0).forEach((axis) => {
                const d = AX[axis];
                cv.text(d.name, x0 + 24, y + 30, 23, t.dim);
                const movThis = mv && mv.seat === seat && mv.axis === axis;
                const bx = x0 + 300, bw = 198, gap = 14;
                const onA = active && active.seat === seat && active.axis === axis && active.dir === 1;
                const onB = active && active.seat === seat && active.axis === axis && active.dir === -1;
                G.button(cv, t, bx, y, bw, 52, d.a, () => { startJog(seat, axis, 1); return render(); },
                    { key: seat + axis + 'a', color: onA ? AMBER : null });
                G.button(cv, t, bx + bw + gap, y, bw, 52, d.b, () => { startJog(seat, axis, -1); return render(); },
                    { key: seat + axis + 'b', color: onB ? AMBER : null });
                if (movThis) cv.circle(x0 + 24 + 6, y + 6, 7, AMBER);
                y += 62;
            });
            // hafıza satırı
            const mem = memOf(seat), job = jobNow();
            const my = 418, mbw = 150, mgap = 14;
            for (let i = 0; i < 3; i++) {
                const has = !!mem[i];
                const lit = seat === (seatsState().jobSeat) && job === 'memory';
                G.button(cv, t, x0 + 24 + i * (mbw + mgap), my, mbw, 60, 'M' + (i + 1),
                    () => { memoryTap(seat, i); return render(); },
                    { key: seat + 'm' + i, color: lit ? AMBER : (has ? null : t.dim) });
            }
            // yolcu: Yer Aç (park halinde)
            if (seat === 'passenger') {
                const roomOut = !!seatsState().roomOut;
                G.button(cv, t, x0 + 24 + 3 * (mbw + mgap), my, 210, 60, roomOut ? 'Geri Al' : 'Yer Aç',
                    () => { stopJog(); comfort.gentleman(); return render(); },
                    { key: 'yerac', color: roomOut ? AMBER : null });
            }
        }

        function drawDisconnected(cv, t) {
            G.panel(cv, t, 24, 44, 1552, 468, 'Koltuklar');
            cv.text('Comfort aracı bağlı değil.', 48, 150, 30, t.crit, { font: 'bold' });
            cv.text('Koltuk kontrolü için Store > araçlar > Comfort kurulu olmalı.', 48, 200, 24, t.dim);
            cv.text('(iteriodev-comfort — Ambiyans ve Koltuklar bunu kullanır)', 48, 238, 22, t.dim);
        }

        function header(cv, t) {
            const moving = !!movingNow() || !!jobNow();
            const badge = !cs.connected ? { text: 'COMFORT YOK' }
                : moving ? { text: 'HAREKET', color: AMBER }
                : saveMode ? { text: 'KAYDET: M SEÇ', color: AMBER }
                : { text: seatsState().parked === false ? 'SÜRÜŞTE' : 'HAZIR', color: GREEN };
            G.frame(cv, t, ['Koltuklar'], 0, [badge]);
        }

        async function render() {
            const t = ctx.theme(), cv = ctx.canvas(W, H).clear(t.bg);
            if (!cs.connected) drawDisconnected(cv, t);
            else {
                const rhd = !!settings.get('rhd');
                drawSeat(cv, t, 24, rhd ? 'passenger' : 'driver');
                drawSeat(cv, t, 820, rhd ? 'driver' : 'passenger');
            }
            header(cv, t);
            await ui.image('MAIN_GFX', cv);
        }

        ui.onClick('BTN_DUR', () => { stopJog(); return render(); });
        ui.onClick('BTN_KAYDET', () => { saveMode = !saveMode; return render(); });

        ctx.loop('MAIN', 6, render);
        render().then(() => log.info('ilk kare çizildi')).catch((e) => log.warn('ilk render: ' + e));
    },
});
