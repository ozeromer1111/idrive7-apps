'use strict';
/**
 * carimage.js - the top-down car photo, drawn like text from its glyph atlas (kit/localization/fonts/car.json,
 * made by kit/tools/bake_car.py): a black silhouette, its brightness in white, its red parts in red.
 * size(height) -> [width, height] or null when there is no atlas.
 * drawCar(cv, cx, top, height): centred on cx, the front at the top; returns its width (0 = not drawn).
 */
const fonts = require('./fonts');

function atlas(height) {
    const f = fonts.get('car', height, '');
    return f && f.family === 'car' && f.glyphs[0xE010] ? f : null;
}

function size(height) {
    const f = atlas(height);
    return f ? [f.glyphs[0xE010][2] * height / f.size, height] : null;
}

function drawCar(cv, cx, top, height, red) {
    const f = atlas(height);
    if (!f) return 0;
    const o = { font: 'car', align: 'center', literal: true };
    cv.text('', cx, top + height, height, '#000000', o);
    cv.text('', cx, top + height, height, '#ffffff', o);
    cv.text('', cx, top + height, height, red || '#d0202a', o);
    return f.glyphs[0xE010][2] * height / f.size;
}

/** A tyre seen from above (kit/localization/fonts/tyre.json, kit/tools/bake_tyre.py): left = mirrored tread. */
function drawTyre(cv, x, y, height, left) {
    const f = fonts.get('tyre', height, '');
    if (!f || f.family !== 'tyre' || !f.glyphs[0xE020]) return false;
    const o = { font: 'tyre', literal: true };
    cv.text('', x, y + height, height, '#000000', o);
    cv.text(left ? '' : '', x, y + height, height, '#ffffff', o);
    return true;
}

module.exports = { size, drawCar, drawTyre };
