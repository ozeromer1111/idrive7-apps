'use strict';
// Never apply the instrument/UI word-replacement dictionary to diagnostic prose.
const path = require('path');
const { getLanguage, dict, plural } = require('./kit/i18n');
let db = null;
function diagnosticText(value) {
    const source = String(value == null ? '' : value);
    const language = getLanguage();
    const ambiguous = /^(\d+) possible texts \(depends on unit type\)$/.exec(source);
    if (ambiguous && language === 'zh-CN') return ambiguous[1] + ' 个候选说明（取决于单元型号）';
    if (ambiguous && language !== 'en') {
        const n = Number(ambiguous[1]);
        return n + ' ' + plural(n, 'possible texts (depends on unit type)', 'possible texts (depends on unit type)');
    }
    // tr: the fault text pack is committed (diagnostic_i18n.pack, tr.json: English text -> Turkish); the hand-translated
    // CheckControl messages come from the dictionary. A missing pack only means the English text stays.
    if ((language === 'zh-CN' || language === 'ru' || language === 'tr') && !db) {
        try { db = require('./kit/pack').open(path.join(__dirname, 'diagnostic_i18n')); } catch (e) { db = null; }
    }
    if (!db) return language === 'tr' ? dict[source] || source : source;
    let hit = null;
    try { hit = db.get(language + '.json', source); } catch (e) { hit = null; }
    return hit || dict[source] || source;
}
module.exports = { diagnosticText };
