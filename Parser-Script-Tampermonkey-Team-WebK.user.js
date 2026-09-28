// ==UserScript==
// @name         Telegram Web K — экспорт новостей канала
// @namespace    telegram-parser-script-for-invest-news
// @version      1.10.0
// @description  Выгружает текст сообщений из открытого канала/чата в веб-версии Telegram (Web K) в таблицу с колонками «Надо брать», «Текст сообщения», «Дата», «Время», «Канал», «Тайминг», «Тема» и копирует результат в буфер обмена (TSV); копит собранные каналы и выгружает их одной таблицей с пометкой дублей.
// @author       vmsavelyev
// @match        https://web.telegram.org/k/*
// @grant        GM_registerMenuCommand
// @grant        GM_setClipboard
// @grant        GM_getValue
// @grant        GM_setValue
// @run-at       document-idle
// ==/UserScript==

// Логика идентична консольной версии скрипта (см. файл Parser-Script в репозитории) —
// отличия только в обвязке под Tampermonkey: скрипт не запускается автоматически при
// загрузке страницы (чтобы успеть открыть нужный канал и долистать ленту вручную), а
// вызывается через пункт меню Tampermonkey «Собрать новости с канала»; копирование в
// буфер обмена сначала пробует GM_setClipboard (не требует фокуса вкладки/разрешений),
// а при его отсутствии откатывается на navigator.clipboard, как раньше.

(function () {
    "use strict";

    // ---------- накопление каналов между запусками ----------
    // Каждый запуск собирает один канал. Собранное складывается в хранилище Tampermonkey,
    // чтобы потом выгрузить все каналы одной таблицей и пометить дубли между ними.
    // Каналы, которые ожидаются в выгрузке (название — как в заголовке чата), — нужны
    // только панели статуса, чтобы показать, какие из них ещё не собраны.
    const EXPECTED_CHANNELS = ["MarketTwits", "СМАРТЛАБ НОВОСТИ", "Сигналы РЦБ"];
    const STORE_KEY = "tgNewsStore";
    const TSV_HEADER = "Надо брать\tТекст сообщения\tДата\tВремя\tКанал\tТайминг\tТема\tОбработано";

    const pad2 = n => String(n).padStart(2, "0");
    const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
    // "ДД.ММ.ГГГГ Ч:ММ:СС" -> unix-секунды (0, если формат не распознан)
    function timingToSec(timing) {
        const m = timing && timing.match(/^(\d{2})\.(\d{2})\.(\d{4}) (\d{1,2}):(\d{2}):(\d{2})$/);
        return m ? new Date(+m[3], +m[2] - 1, +m[1], +m[4], +m[5], +m[6]).getTime() / 1000 : 0;
    }
    function fmtSec(sec) {
        const d = new Date(sec * 1000);
        return `${pad2(d.getDate())}.${pad2(d.getMonth() + 1)}.${d.getFullYear()} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
    }
    function tsvLine(v, processed = "") {
        return [v.importance, v.text, v.date, v.time, v.channel, v.timing, v.topic, processed].join("\t");
    }

    function storeGet() {
        try {
            const raw = typeof GM_getValue === "function" ? GM_getValue(STORE_KEY, null) : localStorage.getItem(STORE_KEY);
            const s = typeof raw === "string" ? JSON.parse(raw) : raw;
            if (s && s.items && s.channels) return s;
        } catch (e) {
            console.warn("[TG] не удалось прочитать накопленные новости:", e);
        }
        return { items: {}, channels: {} };
    }
    function storeSet(s) {
        if (typeof GM_setValue === "function") GM_setValue(STORE_KEY, s);
        else localStorage.setItem(STORE_KEY, JSON.stringify(s));
    }

    // сливает собранное за запуск в хранилище; повторный сбор того же канала или
    // пересекающегося периода не создаёт копий (ключ — канал + id сообщения)
    function mergeIntoStore(channel, values) {
        const store = storeGet();
        for (const v of values) {
            const key = `${channel}|${v.id || `${v.timing}|${v.text.slice(0, 200)}`}`;
            store.items[key] = {
                channel, text: v.text, date: v.date, time: v.time, timing: v.timing,
                tsSort: timingToSec(v.timing), importance: v.importance, topic: v.topic
            };
        }
        store.channels[channel] = { lastRunAt: Date.now() };
        storeSet(store);
        return Object.keys(store.items).length;
    }

    async function copyResult(result) {
        try {
            if (typeof GM_setClipboard === "function") {
                GM_setClipboard(result, "text");
            } else {
                await navigator.clipboard.writeText(result);
            }
            return true;
        } catch (e) {
            const a = document.createElement("textarea");
            a.value = result;
            a.style = `position:fixed;top:20px;left:20px;width:80vw;height:70vh;z-index:999999;
                       background:#fff;color:#000;font-size:14px;padding:10px;border:3px solid red;`;
            document.body.appendChild(a); a.focus(); a.select();
            return false;
        }
    }

    // ---------- поиск дублей между каналами ----------
    // Дубль — более поздняя «Важно»-новость про тот же факт или развитие той же
    // истории, что и более ранняя «Важно»-новость (из любого канала, включая тот же).
    // Сравнение без LLM: множество «корней» слов (первые 5 букв) с весами IDF,
    // чтобы вездесущие «россия/украина/трамп/санкции» почти не влияли на похожесть.
    // Похожесть по словам дополняют «запреты» (dupConflict ниже): разные компании,
    // разные цифры, разные люди, более поздняя стадия события, опровержение.
    const DUP_WINDOW_H  = 24;   // насколько далеко назад (в часах) искать оригинал
    const DUP_THRESHOLD = 0.5;  // порог взвешенного коэффициента пересечения (0..1)
    const DUP_DIGEST_COMPANIES = 3; // со скольких упомянутых компаний пост считается сводкой
    const DUP_MIN_ROOTS = 3;    // новости с меньшим числом значимых корней не сравниваем
    const DUP_BOILERPLATE = /читать далее|мы в max|подробнее|mt в max/g;
    const DUP_STOP_WORDS = new Set((
        "что как все так его она они оно был была было были будет это этот эта эти того этого этой " +
        "для при про под над без через после перед между или уже еще тоже также только даже если " +
        "чем чтобы когда где кто там тут них ним нее ней него ему нам нас вас вам себя свою свой " +
        "который которая которые которых года году лет день дня сегодня ранее заявил заявила заявили " +
        "сообщил сообщила сообщили сообщает говорит считает отметил пишет данным источник источники " +
        "the and for with from"
    ).split(" "));

    // стадии события (смотрим только «заголовок», см. dupHeadline):
    // «намерение» — событие ещё не произошло
    const STAGE_INTENT = /планир|может|могут|ожида|намер|собира|должн|рассмотрит|рассмотрят|рассматрива|рассмотрени|обсудит|обсудят|обсуждают|обсуждени|вероятн|готовит|предлага|призыва|хочет|хотят|еще нет|пока нет|пока не |проведут|пройдет|пройдут|состоится|встретится|встретятся|анонсир|примут участие|примет участие/;
    // «началось» — событие идёт прямо сейчас
    const STAGE_START = /начал[аи]?(?![a-zа-я])|началась|начались|стартовал|проводит|проходит/;
    // «завершилось» — событие уже прошло, известны итоги
    const STAGE_RESULT = /провел[аи]?(?![a-zа-я])|состоял(ась|ись|ся)|завершил|по итогам|итоги встречи|рассказал о встрече|встретил(ся|ась|ись)/;
    // рассказ об итогах встречи часто начинается с цитаты, поэтому ищется по всему тексту
    const STAGE_REPORT = /рассказал[аи]? о (встрече|переговорах)|по итогам (встречи|переговоров)|итоги (встречи|переговоров)/;
    // опровержение/отказ — самостоятельная новость, а не пересказ опровергаемой
    const STAGE_DENY = /фейк|опроверг|отклонил|отверг|не соответству|не планируется|дезинформац/;
    // ключевое действие в прошедшем времени (законы, решения, ставки)
    const STAGE_DONE = /(подписал|одобрил|принял|проголосовал|утвердил|согласовал|ввел|отменил|снизил|повысил|сохранил|запустил|завершил|заключил|разместил)[аи]?(?![a-zа-я])/g;
    // синонимы одного и того же свершившегося действия («палата одобрила» = «проголосовала за»)
    const STAGE_DONE_GROUP = { одобрил: "одобрил", проголосовал: "одобрил", принял: "одобрил", утвердил: "одобрил", согласовал: "одобрил" };

    // люди и ведомства, чьи заявления/встречи/прогнозы отличают одну новость от другой:
    // «Макрон настаивает на перемирии» — не дубль «Зеленский будет настаивать на перемирии»,
    // прогноз Минэкономразвития — не дубль прогноза ОЭСР
    const DUP_PERSONS = /трамп|путин|песков|лавров|рябков|зеленск|макрон|мерц|рубио|уиткофф|виткофф|кушнер|дмитриев|арагчи|фон дер ляйен|рютте|орбан|эрдоган|стармер|вэнс|нетаньяху|медведев|захаров|ушаков|набиуллин|силуанов|решетников|вадефул|сырск|буданов|ермак|сибиг|оэср|мвф|всемирн\S* банк|минэкономразвития|минфин|росстат|опек|еврокомисс/g;
    // латинские хэштеги, которые не являются тикерами
    const DUP_NON_TICKERS = new Set(["ipo", "spo", "fx", "ai", "etf", "opec", "nato", "usa", "us", "eu", "uk"]);
    // общие темы из classifyTopic() — это не название компании
    const DUP_GENERIC_TOPICS = new Set(["", "Украина", "Иран", "ЦБ", "Российская компания"]);

    const dupNorm = text => text.toLowerCase().replace(/ё/g, "е");
    // текст без пробелов и знаков, латинские буквы-двойники заменены кириллицей
    // («ДОМ.PФ» с латинской P → «домрф») — для поиска названия компании в тексте
    const LOOKALIKES = { a: "а", c: "с", e: "е", o: "о", p: "р", x: "х", y: "у", k: "к", m: "м", t: "т", b: "в", h: "н" };
    const dupFlat = text => dupNorm(text).replace(/[^a-zа-я0-9]/g, "").replace(/[aceopxykmtbh]/g, c => LOOKALIKES[c]);
    // ключ названия компании для поиска в тексте: первые 5 букв самого длинного слова
    // названия без общих слов («Банк Санкт-Петербург» → «санкт», «ДОМ.РФ» → «домрф») —
    // так он не зависит от падежа («банка Санкт-Петербург»)
    const COMPANY_GENERIC_WORDS = new Set(["банк", "группа", "гк", "компания", "пао", "ао"]);
    function companyKey(name) {
        const words = dupNorm(name).split(/\s+/).filter(w => !COMPANY_GENERIC_WORDS.has(w)).map(dupFlat);
        const longest = words.sort((a, b) => b.length - a.length)[0] || "";
        return longest.length >= 3 ? longest.slice(0, 5) : "";
    }

    function dupRoots(text) {
        const t = dupNorm(text)
            .replace(/https?:\/\/\S+/g, " ")
            .replace(/#[^\s#]+/g, " ")
            .replace(DUP_BOILERPLATE, " ");
        const roots = new Set();
        for (const w of t.match(/[a-zа-я0-9]+/g) || []) {
            if (w.length < 3 || DUP_STOP_WORDS.has(w)) continue;
            roots.add(w.slice(0, 5));
        }
        return roots;
    }

    // «заголовок» — начало текста без хэштегов до указания источника (« — ТАСС»,
    // « -- BBG»): в длинных постах дальше по тексту почти всегда есть «может/планирует»
    // про последствия, а после источника часто идёт уже следующая новость
    const DUP_HEADLINE_LEN = 160;
    function dupHeadline(text) {
        const t = dupNorm(text).replace(/#[^\s#]+/g, " ").replace(/\s+/g, " ").trim();
        const src = t.search(/ (—|--) /);
        return (src >= 30 ? t.slice(0, src) : t).slice(0, DUP_HEADLINE_LEN);
    }

    function dupStage(text) {
        const t = dupHeadline(text);
        const done = new Set();
        for (const m of t.matchAll(STAGE_DONE)) done.add(STAGE_DONE_GROUP[m[1]] || m[1]);
        const intent = STAGE_INTENT.test(t);
        // порядок стадий события: 1 — план, 2 — идёт, 3 — прошло (0 — не определить)
        const level = STAGE_RESULT.test(t) || STAGE_REPORT.test(dupNorm(text)) ? 3 : STAGE_START.test(t) ? 2 : intent ? 1 : 0;
        return { intent, done, level, deny: STAGE_DENY.test(t) };
    }

    // «сущности» новости: тикеры (латинские хэштеги/кэштеги), значимые числа, люди,
    // упомянутые компании (companyKeys — названия компаний из «Темы» всех новостей)
    function dupEntities(it, companyKeys) {
        const t = dupNorm(it.text);
        const tickers = new Set();
        for (const m of t.matchAll(/[#$]([a-z]{2,6})(?![a-z])/g)) if (!DUP_NON_TICKERS.has(m[1])) tickers.add(m[1]);
        // числа: дробные или от 10, кроме годов — у дублей они совпадают (76,6 млрд,
        // 200 руб/акц), а у похожих по шаблону новостей (два аукциона ОФЗ за день) — нет
        const numbers = [];
        for (const m of t.replace(/https?:\/\/\S+/g, " ").matchAll(/\d+(?:[.,]\d+)?/g)) {
            const v = m[0].replace(",", ".");
            if (/^(19|20)\d\d$/.test(v) || (!v.includes(".") && Number(v) < 10)) continue;
            numbers.push(Number(v));
        }
        const persons = new Set(t.match(DUP_PERSONS) || []);
        // компания из колонки «Тема» (первые 5 букв), если новость именно про неё —
        // её название есть в самом тексте, а не только в хэштеге «связанного» тикера
        const flat = dupFlat(it.text);
        const key = DUP_GENERIC_TOPICS.has(it.topic || "") ? "" : companyKey(it.topic.split(", ")[0]);
        const company = key && flat.includes(key) ? key : "";
        const companies = new Set([...companyKeys].filter(k => flat.includes(k)));
        return { tickers, numbers, persons, company, companies, flat };
    }

    const disjoint = (a, b) => a.size > 0 && b.size > 0 && ![...a].some(x => b.has(x));
    // ни одно число не совпадает (с точностью 1% — «22,829 млрд» = «22.83 млрд»); у каждой
    // новости должно быть хотя бы 2 числа, иначе разные показатели одного отчёта
    // («выработка 4,8 млрд кВт-ч» и «нарастила на 2,5%») ошибочно разойдутся
    const numbersDiffer = (a, b) => a.length >= 2 && b.length >= 2 &&
        !a.some(x => b.some(y => Math.abs(x - y) <= 0.01 * Math.max(x, y)));

    // причина, по которой cur не может быть дублем более ранней prev (или "" — если может)
    function dupConflict(cur, prev) {
        const a = cur.ent, b = prev.ent;
        if (disjoint(a.tickers, b.tickers)) return "разные компании";
        // тикер только у одной новости — компания должна упоминаться и во второй
        if (a.tickers.size && !b.tickers.size && a.company && !b.flat.includes(a.company)) return "разные компании";
        if (b.tickers.size && !a.tickers.size && b.company && !a.flat.includes(b.company)) return "разные компании";
        // сводка по многим компаниям («прибыль ВТБ, ТБанка, Совкомбанка…») — не дубль
        // новости про одну из них, и наоборот
        if ((a.companies.size >= DUP_DIGEST_COMPANIES) !== (b.companies.size >= DUP_DIGEST_COMPANIES)) return "сводка по компаниям";
        if (numbersDiffer(a.numbers, b.numbers)) return "разные цифры";
        if (disjoint(a.persons, b.persons)) return "разные люди";
        // «подписал» после «планирует подписать» — новое событие, а не дубль:
        // свершившийся факт может быть дублем только новости о том же свершившемся
        // действии (и без признаков намерения в ней)
        if (cur.stage.done.size && !cur.stage.intent &&
            (prev.stage.intent || ![...cur.stage.done].some(v => prev.stage.done.has(v)))) return "событие свершилось";
        // «встреча началась/прошла» после «встреча ожидается» — следующая стадия события
        if (prev.stage.level > 0 && cur.stage.level > prev.stage.level) return "следующая стадия";
        if (cur.stage.deny && !prev.stage.deny) return "опровержение";
        return "";
    }

    // items: [{ tsSort, importance, text, topic, ... }]. Возвращает Map<item, { origin, match, sim }>
    // только для дублей: origin — самая ранняя новость группы, match — на какую
    // новость текущая оказалась похожа сильнее всего, sim — эта похожесть.
    function markDuplicates(items) {
        const companyKeys = new Set();
        for (const it of items) {
            if (DUP_GENERIC_TOPICS.has(it.topic || "")) continue;
            for (const name of it.topic.split(", ")) {
                const k = companyKey(name);
                if (k) companyKeys.add(k);
            }
        }
        const df = new Map();
        const prepared = items.map(it => {
            const roots = dupRoots(it.text);
            for (const r of roots) df.set(r, (df.get(r) || 0) + 1);
            return { it, roots };
        });
        const n = prepared.length;
        const idf = r => Math.log((n + 1) / (df.get(r) || 1));
        const weight = roots => { let s = 0; for (const r of roots) s += idf(r); return s; };

        const important = prepared
            .filter(p => p.it.importance === "Важно" && p.roots.size >= DUP_MIN_ROOTS)
            .sort((a, b) => a.it.tsSort - b.it.tsSort);
        for (const p of important) {
            p.w = weight(p.roots);
            p.stage = dupStage(p.it.text);
            p.ent = dupEntities(p.it, companyKeys);
        }
        const similarity = (a, b) => {
            let common = 0;
            for (const r of a.roots) if (b.roots.has(r)) common += idf(r);
            const denom = Math.min(a.w, b.w);
            return denom > 0 ? common / denom : 0;
        };

        const origin = new Map();
        for (let i = 0; i < important.length; i++) {
            const cur = important[i];
            let best = null, bestSim = 0;
            for (let j = i - 1; j >= 0; j--) {
                const prev = important[j];
                if (cur.it.tsSort - prev.it.tsSort > DUP_WINDOW_H * 3600) break;
                if (dupConflict(cur, prev)) continue;
                const sim = similarity(cur, prev);
                if (sim > bestSim) { bestSim = sim; best = prev; }
            }
            if (!best || bestSim < DUP_THRESHOLD) continue;
            const root = origin.get(best.it)?.origin || best.it;
            origin.set(cur.it, { origin: root, match: best.it, sim: bestSim });
        }
        return origin;
    }

    // ---------- панель статуса и общая выгрузка ----------
    function channelStats(store) {
        const stats = {};
        for (const it of Object.values(store.items)) {
            const s = stats[it.channel] || (stats[it.channel] = { count: 0, important: 0, from: Infinity, to: 0 });
            s.count++;
            if (it.importance === "Важно") s.important++;
            if (it.tsSort) { s.from = Math.min(s.from, it.tsSort); s.to = Math.max(s.to, it.tsSort); }
        }
        return stats;
    }

    function showStatusPanel(message = "") {
        document.getElementById("tg-store-panel")?.remove();
        const store = storeGet();
        const stats = channelStats(store);
        const names = [...new Set([...EXPECTED_CHANNELS, ...Object.keys(stats)])];

        const rows = names.map(name => {
            const s = stats[name];
            if (!s) return `<tr style="color:#f88;"><td>${esc(name)}</td><td colspan="5">не собран</td><td></td></tr>`;
            const at = store.channels[name]?.lastRunAt;
            return `<tr><td>${esc(name)}</td><td>${s.count}</td><td>${s.important}</td>
                <td>${s.to ? fmtSec(s.from) : "—"}</td><td>${s.to ? fmtSec(s.to) : "—"}</td>
                <td>${at ? fmtSec(at / 1000) : "—"}</td>
                <td><button data-del="${esc(name)}" title="Удалить новости канала из накопления"
                    style="background:none;border:0;color:#f88;cursor:pointer;font-size:14px;">✕</button></td></tr>`;
        }).join("");

        // общий период, за который есть данные всех собранных каналов: дубли ищутся
        // только между собранными новостями, поэтому на краях несовпадающих периодов
        // оригинал может остаться несобранным, а дубль — не найтись
        const warnings = [];
        const missing = EXPECTED_CHANNELS.filter(n => !stats[n]);
        if (missing.length) warnings.push(`Не собраны: ${missing.map(esc).join(", ")}.`);
        const ranges = Object.values(stats).filter(s => s.to);
        if (ranges.length >= 2) {
            const from = Math.max(...ranges.map(s => s.from));
            const to = Math.min(...ranges.map(s => s.to));
            if (from > to) {
                warnings.push("Периоды каналов не пересекаются — дубли между ними не найдутся.");
            } else if (ranges.some(s => s.from < from - 3600 || s.to > to + 3600)) {
                warnings.push(`Периоды каналов различаются — дубли на краях могут не найтись. Общий период: ${fmtSec(from)} — ${fmtSec(to)}.`);
            }
        }

        const btn = "margin:8px 8px 0 0;padding:6px 10px;color:#fff;border:0;border-radius:6px;cursor:pointer;font-weight:bold;";
        const panel = document.createElement("div");
        panel.id = "tg-store-panel";
        panel.style = `position:fixed;top:16px;right:16px;z-index:999999;background:#202020;color:#fff;
                       padding:12px 16px;border-radius:10px;font:13px/1.4 Arial,sans-serif;max-width:90vw;
                       max-height:85vh;overflow:auto;box-shadow:0 4px 18px rgba(0,0,0,.4);`;
        panel.innerHTML = `<b>Накопленные новости</b>
            ${message ? `<div style="margin-top:6px;color:#8f8;">${esc(message)}</div>` : ""}
            <table style="margin-top:8px;border-collapse:collapse;white-space:nowrap;">
                <tr style="color:#aaa;text-align:left;"><th>Канал</th><th>Новостей</th><th>«Важно»</th>
                    <th>С</th><th>По</th><th>Собрано</th><th></th></tr>
                ${rows}
            </table>
            ${warnings.map(w => `<div style="margin-top:6px;color:#fc6;">${w}</div>`).join("")}
            <button id="tg-store-export" style="${btn}background:#2b5278;">Выгрузить все каналы (с дублями)</button>
            <button id="tg-store-clear" style="${btn}background:#d33;">Очистить всё</button>
            <button id="tg-store-close" style="${btn}background:#555;">Закрыть</button>`;
        panel.querySelectorAll("td, th").forEach(c => { c.style.padding = "2px 8px 2px 0"; });
        document.body.appendChild(panel);

        panel.querySelector("#tg-store-close").onclick = () => panel.remove();
        panel.querySelector("#tg-store-export").onclick = () => { exportAll().catch(console.error); };
        panel.querySelector("#tg-store-clear").onclick = () => {
            if (!confirm("Удалить все накопленные новости всех каналов?")) return;
            storeSet({ items: {}, channels: {} });
            showStatusPanel("Накопление очищено.");
        };
        panel.querySelectorAll("[data-del]").forEach(b => {
            b.onclick = () => {
                const name = b.getAttribute("data-del");
                if (!confirm(`Удалить накопленные новости канала «${name}»?`)) return;
                const s = storeGet();
                for (const [k, it] of Object.entries(s.items)) if (it.channel === name) delete s.items[k];
                delete s.channels[name];
                storeSet(s);
                showStatusPanel(`Канал «${name}» удалён из накопления.`);
            };
        });
    }

    async function exportAll() {
        const items = Object.values(storeGet().items);
        if (!items.length) { showStatusPanel("Накопленных новостей нет — сначала соберите каналы."); return; }
        const dups = markDuplicates(items);
        items.sort((a, b) => a.tsSort - b.tsSort || a.channel.localeCompare(b.channel));

        // группы дублей: оригинал (самая ранняя новость) и все его дубли получают один
        // номер «Дубль N»; номера идут по времени оригинала. У оригинала — пометка
        // «(оригинал)», чтобы было видно, какая новость из группы остаётся.
        const groupOf = new Map();
        for (const d of dups.values()) if (!groupOf.has(d.origin)) groupOf.set(d.origin, 0);
        let groups = 0;
        for (const it of items) if (groupOf.has(it)) groupOf.set(it, ++groups);
        const processed = it => {
            if (groupOf.has(it)) return `Дубль ${groupOf.get(it)} (оригинал)`;
            const d = dups.get(it);
            return d ? `Дубль ${groupOf.get(d.origin)}` : "";
        };

        for (const it of items) {
            const d = dups.get(it);
            if (d) console.log(`[TG] Дубль ${groupOf.get(d.origin)} (похожесть ${d.sim.toFixed(2)}): ${it.channel} ${it.timing} «${it.text.slice(0, 80)}»\n` +
                               `     оригинал: ${d.origin.channel} ${d.origin.timing} «${d.origin.text.slice(0, 80)}»`);
        }
        const result = TSV_HEADER + "\n" + items.map(it => tsvLine(it, processed(it))).join("\n");
        const copied = await copyResult(result);
        showStatusPanel(`Выгружено новостей: ${items.length}, групп дублей: ${groups}, дублей (без оригиналов): ${dups.size}. ` +
                        (copied ? "Таблица скопирована в буфер обмена." : "Скопируйте таблицу из поля слева (Ctrl+C)."));
    }

    async function runParser() {
    const SCROLL_RATIO = 2.5;
    const TICK_MS      = 20;
    const IDLE_TICKS   = 1;
    const MIN_WAIT_MS  = 10;
    const MAX_WAIT_MS  = 900;
    const MAX_STEPS    = 5000;
    let DIRECTION      = 1;
    let STOP_DATE      = null;

    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const pad = n => String(n).padStart(2, "0");
    const fmtTime = d => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    const fmtDate = d => `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()}`;
    const parseRuDate = s => {
        const m = s && s.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
        return m ? new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1])) : null;
    };
    const cleanText = t => t.replace(/\r?\n|\r|\t/g, " ").replace(/\s+/g, " ").trim();

    const isShown = el => {
        if (!el || el.offsetParent === null) return false;
        const r = el.getBoundingClientRect();
        return r.width > 10 && r.height > 10;
    };

    // ---------- название канала ----------
    function getChannelName() {
        const selectors = [
            "#column-center .sidebar-header .peer-title",
            "#column-center .chat-info .peer-title",
            ".sidebar-header .peer-title",
            ".chat-info .peer-title",
            ".top .peer-title"
        ];
        for (const sel of selectors) {
            const el = document.querySelector(sel);
            if (el && isShown(el)) {
                const t = cleanText(el.innerText || el.textContent || "");
                if (t) return t;
            }
        }
        return cleanText(document.title || "");
    }
    const CHANNEL = getChannelName();

    // ---------- выбор направления скролла ----------
    // "Вниз" — крутим к новым сообщениям до конца ленты (как раньше по умолчанию).
    // "Вверх" — крутим к старым сообщениям и останавливаемся по достижении даты,
    // выбранной пользователем через нативный календарь (<input type="date">), так
    // как window.prompt() календаря не даёт.
    function chooseDirection() {
        return new Promise(resolve => {
            const overlay = document.createElement("div");
            overlay.style = `position:fixed;inset:0;z-index:9999999;background:rgba(0,0,0,.5);
                             display:flex;align-items:center;justify-content:center;`;
            overlay.innerHTML = `
                <div style="background:#202020;color:#fff;padding:24px;border-radius:12px;
                            font:14px/1.5 Arial,sans-serif;max-width:360px;box-shadow:0 8px 30px rgba(0,0,0,.5);">
                    <b style="font-size:16px;">Направление сбора</b>
                    <div id="tg-dir-step1" style="margin-top:14px;">
                        <p style="margin:0 0 12px;">Куда крутить ленту?</p>
                        <button id="tg-dir-up" style="width:100%;margin-bottom:8px;padding:10px;background:#2b5278;
                                color:#fff;border:0;border-radius:6px;cursor:pointer;font-weight:bold;">
                            Вверх (к старым, до даты)
                        </button>
                        <button id="tg-dir-down" style="width:100%;padding:10px;background:#2b5278;
                                color:#fff;border:0;border-radius:6px;cursor:pointer;font-weight:bold;">
                            Вниз (до конца ленты)
                        </button>
                    </div>
                    <div id="tg-dir-step2" style="margin-top:14px;display:none;">
                        <p style="margin:0 0 12px;">До какой даты крутить (включительно)?</p>
                        <input id="tg-dir-date" type="date" style="width:100%;padding:8px;border-radius:6px;
                               border:0;font-size:14px;box-sizing:border-box;">
                        <button id="tg-dir-ok" style="width:100%;margin-top:10px;padding:10px;background:#2b5278;
                                color:#fff;border:0;border-radius:6px;cursor:pointer;font-weight:bold;">
                            Начать
                        </button>
                    </div>
                </div>`;
            document.body.appendChild(overlay);

            overlay.querySelector("#tg-dir-down").onclick = () => {
                overlay.remove();
                resolve({ direction: 1, stopDate: null });
            };
            overlay.querySelector("#tg-dir-up").onclick = () => {
                overlay.querySelector("#tg-dir-step1").style.display = "none";
                overlay.querySelector("#tg-dir-step2").style.display = "block";
            };
            overlay.querySelector("#tg-dir-ok").onclick = () => {
                const v = overlay.querySelector("#tg-dir-date").value; // YYYY-MM-DD
                if (!v) { alert("Выберите дату."); return; }
                const [y, m, d] = v.split("-").map(Number);
                overlay.remove();
                resolve({ direction: -1, stopDate: new Date(y, m - 1, d) });
            };
        });
    }
    const dirChoice = await chooseDirection();
    DIRECTION = dirChoice.direction;
    STOP_DATE = dirChoice.stopDate;

    alert(
        DIRECTION === 1
            ? "Долистайте канал вручную вверх до самого начала (до первых сообщений) —\n" +
              "скрипт будет скроллить вниз и соберёт то, что идёт после текущей позиции, до конца ленты."
            : "Долистайте канал вручную вниз до самых свежих сообщений —\n" +
              `скрипт будет скроллить вверх, пока не дойдёт до ${fmtDate(STOP_DATE)} (включительно).`
    );

    // ---------- разметка важности ----------
    // Списки ключевых слов/паттернов ниже можно донастраивать под себя —
    // в первую очередь имеет смысл дополнять именно их, а не менять логику функции.
    // Хэштеги в тексте расставляет автор исходного поста в канале, а не тот, кто собирает
    // выгрузку — они бывают неполными или непоследовательными, поэтому это только
    // вспомогательный (слабый) сигнал, а не единственное основание для классификации.
    //
    // ВАЖНО про \b и кириллицу: в JS \w и \b понимают только ASCII-буквы, поэтому
    // конструкции вида /\bнато\b/ или /мета\b/ с кириллицей молча НЕ срабатывают — нет
    // символа "слова" по обе стороны границы. wb() ниже строит границу вручную через
    // lookaround по явному классу символов (латиница + кириллица + цифры).
    const WORD_CHAR = "a-zа-яё0-9";
    function wb(word) {
        return `(?<![${WORD_CHAR}])(?:${word})(?![${WORD_CHAR}])`;
    }
    function wbRe(words, flags = "i") {
        return new RegExp(words.map(wb).join("|"), flags);
    }

    // тикеры компаний, торгующихся на Мосбирже (в латинской транслитерации, как их пишут
    // в хэштегах/кэштегах) — используются, чтобы отличать "свои" тикеры от иностранных.
    // Список выгружен из реального справочника Московской биржи (ISS API, доска TQBR —
    // акции, https://iss.moex.com/iss/engines/stock/markets/shares/boards/TQBR/securities.json),
    // паевые фонды (ПИФ/БПИФ/ОПИФ/ЗПИФ/ИПИФ) и ETF исключены, добавлены несколько
    // исторических алиасов тикеров (novatek, poly/polymetal, qiwi, five, reno, tcsg/tcsi
    // и т.п.), которые могли встречаться в старых постах до ребрендинга/делистинга.
    const MOEX_TICKERS = new Set([
        "abio", "abrd", "afks", "aflt", "akrn", "alrs", "amez", "apri", "aptk", "aqua", "arsa", "assb", "astr",
        "avan", "bane", "banep", "baza", "belu", "bisvp", "blng", "brzl", "bspb", "bspbp", "btbr", "carm", "cbom",
        "chgz", "chkz", "chmf", "chmk", "cnru", "cntl", "cntlp", "data", "deli", "dias", "diod", "domrf", "dvec",
        "dzrd", "dzrdp", "eelt", "elfv", "elmt", "enpg", "etln", "eutr", "evrz", "fees", "fesh", "five", "fixr",
        "flot", "gaza", "gazap", "gazc", "gazp", "gazs", "gazt", "gche", "geco", "gema", "gemc", "glrx", "gmkn",
        "gtrk", "head", "himcp", "hnfg", "hydr", "igst", "igstp", "incb", "irao", "irkt", "ivat", "jnos", "jnosp",
        "kazt", "kaztp", "kbsb", "kche", "kchep", "kfba", "kgkc", "kgkcp", "klsb", "klvz", "kmaz", "kmez", "kogk",
        "krkn", "krknp", "krkop", "krot", "krotp", "krsb", "krsbp", "kube", "kuzb", "kzos", "kzosp", "leas",
        "lent", "life", "lkoh", "lmbz", "lnzl", "lnzlp", "lpsb", "lsng", "lsngp", "lsrg", "lvhk", "mage", "magep",
        "magn", "mbnk", "mdmg", "mfgs", "mfgsp", "mgkl", "mgnt", "mgnz", "mgts", "mgtsp", "misb", "misbp", "moex",
        "mrkc", "mrkk", "mrkp", "mrks", "mrku", "mrkv", "mrky", "mrkz", "mrsb", "msng", "msrs", "mstt", "mtlr",
        "mtlrp", "mtss", "mvid", "nauk", "nfaz", "nkhp", "nknc", "nkncp", "nksh", "nlmk", "nmtp", "nnsb", "nnsbp",
        "novabev", "novatek", "nsvz", "nvtk", "ogkb", "okey", "omzzp", "ozon", "ozph", "ozpn", "paza", "phor",
        "pikk", "plzl", "pmsb", "pmsbp", "poly", "polymetal", "posi", "prfn", "prmb", "prmd", "qiwi", "ragr",
        "rasp", "rbcm", "rdrb", "reni", "reno", "rgss", "rkke", "rnft", "rolo", "rosn", "rost", "rtgz", "rtkm",
        "rtkmp", "rtsb", "rtsbp", "rual", "rusi", "russ", "rzsb", "sago", "sagop", "sare", "sarep", "sber",
        "sberp", "selg", "sfin", "sgzh", "sibn", "slen", "smlt", "sngs", "sngsp", "sofl", "spbe", "stsb", "stsbp",
        "svav", "svcb", "svet", "svetp", "t", "tasb", "tasbp", "tatn", "tatnp", "tcsg", "tcsi", "tgka", "tgkb",
        "tgkbp", "tgkn", "tnse", "tors", "torsp", "trmk", "trnfp", "ttlk", "tuza", "ugld", "ukuz", "unac", "unkl",
        "upro", "urkz", "usbn", "utar", "uwgn", "veon", "vgsb", "vgsbp", "vjgz", "vjgzp", "vkco", "vlhz", "vrsb",
        "vrsbp", "vseh", "vsmo", "vsyd", "vsydp", "vtbr", "wb", "wtcm", "wtcmp", "wush", "x5", "yakg", "ydex",
        "yken", "ykenp", "yndx", "yrsb", "yrsbp", "zaym", "zill", "zvez",
    ]);

    // аббревиатуры и общие термины, которые внешне похожи на тикер (латиница, 2-6 букв),
    // но тикером не являются — чтобы не принять их за иностранную компанию
    const NON_TICKER_ACRONYMS = new Set([
        "ipo", "spo", "pmi", "ism", "cpi", "gdp", "gdpnow", "eth", "btc", "ath", "atl", "ytd", "esg",
        "fx", "etf", "cbdc", "dkp", "vve", "rts", "ofz", "nato", "api", "ai", "it", "eu", "us", "usa",
        "uk", "moex", "imoex", "cot", "vix", "fed", "ecb", "opec", "reit", "ipos", "kpi", "gaap", "ifrs",
        "rsbu", "capex", "ebitda", "ebit", "roe", "irr", "npv", "nft", "defi", "dao", "one", "today",
    ]);

    function extractLatinTickers(t) {
        const out = [];
        const re = /[#$]([a-z]{2,6})\b/g;
        let m;
        while ((m = re.exec(t))) out.push(m[1]);
        return out;
    }

    // крупные компании, торгующиеся на биржах США/Европы/Азии — по названию (англ. и рус.
    // транслитерация), не только по тикеру: многие новости (например, про IPO частных
    // компаний вроде Anthropic/OpenAI/SpaceX или китайских техкомпаний) тикера не имеют
    const FOREIGN_COMPANIES = new RegExp([
        "apple", "эпл", "tesla", "тесла", "amazon", "амазон", "google", "alphabet", "гугл",
        "microsoft", "майкрософт", "meta platforms", wb("meta"), wb("мета"), "nvidia", "нвидиа",
        "netflix", "нетфликс", wb("intel"), wb("интел"), "boeing", "боинг", wb("nike"), wb("найк"),
        "starbucks", "старбакс", "jpmorgan", "jp morgan", "джей пи морган", "goldman sachs", "голдман сакс",
        "morgan stanley", "морган стэнли", "bank of america", wb("bofa"), "бэнк оф америка", "citigroup", "ситигруп",
        "wells fargo", "walmart", "уолмарт", "exxon", "экссон", "chevron", "шеврон", "coca-cola", "кока-кола",
        "pepsico", "пепсико", "disney", "дисней", wb("visa"), wb("виза"), "mastercard", "мастеркард",
        "paypal", "пейпал", wb("oracle"), "оракл", "salesforce", "сейлсфорс", "adobe", "адоб", wb("amd"),
        "qualcomm", "куалкомм", wb("ibm"), wb("ford"), wb("форд"), "general motors", "дженерал моторс",
        "at&t", "verizon", "pfizer", "пфайзер", wb("merck"), "johnson & johnson", "джонсон.{0,3}джонсон",
        "unitedhealth", "home depot", "хоум депо", wb("costco"), "костко", "mcdonald", "макдоналдс",
        "airbnb", "эйрбнб", wb("uber"), wb("убер"), wb("lyft"), wb("snap"), wb("снэп"), "palantir", "палантир",
        "coinbase", "койнбейс", "rivian", "ривиан", wb("lucid"), "люсид", "alibaba", "алибаба",
        "anthropic", "антропик", "openai", "опенай", "spacex", "спейсэкс", "berkshire hathaway",
        "беркшир хэтэуэй", "siemens", "сименс", wb("sap"), "volkswagen", "фольксваген", wb("bmw"),
        "mercedes", "мерседес", wb("shell"), wb("шелл"), wb("bp"), "total energies", "тоталэнерджиз",
        "louis vuitton", wb("lvmh"), "nestle", "нестле", "novo nordisk", wb("asml"), "toyota", "тойота",
        "samsung", "самсунг", wb("tsmc"), "tencent", "тенсент", wb("byd"),
        // Китай/Азия — производители и техкомпании, часто мелькающие в новостях без тикера
        "unitree", "юнитри", "robotera", "робо[тэ]эра", "xiaomi", "сяоми", "huawei", "хуавей",
        "baidu", "байду", "byte[- ]?dance", "байтданс", "tiktok", "тикток", "geely", "джили",
        "foxconn", "фоксконн", wb("smic"), "raytheon", "рейтеон", "lockheed", "локхид", "northrop", "нортроп",
        "general dynamics", "roblox", "роблокс", "reddit", "реддит", "cerebras",
    ].join("|"), "i");

    // криптовалюты пользователю не интересны вообще, независимо от того, кто их упоминает
    // (объявляется до IMPORTANT_PATTERNS — на неё ссылается проверка упоминания персон ниже)
    const CRYPTO_PATTERN = new RegExp([
        wb("btc"), wb("eth"), wb("nft"), wb("defi"), wb("mstr"),
        "крипто", "биткоин", "эфириум", "блокчейн", "стейблкоин", "альткоин", "токеномик",
        "binance", "coinbase", "tether", "bitmine", "ethereum", "bitcoin", "stablecoin", "harmony",
    ].join("|"), "i");

    // страна/компания в тексте считается иностранной, если совпало имя из FOREIGN_COMPANIES,
    // упомянута зарубежная страна (без российского контекста) или среди тикеров-хэштегов есть
    // латинский тикер, которого нет ни в MOEX_TICKERS, ни в NON_TICKER_ACRONYMS (эвристика
    // на случай компании, не попавшей явно в список). Объявляется до IMPORTANT_PATTERNS —
    // на неё ссылаются контекстные проверки ставки ЦБ и санкций ниже.
    const RU_SIGNAL = new RegExp(`росси|рубл|мосбирж|\\bmoex\\b|цб рф|минфин рф|${wb("рф")}`, "i");
    // Иран/Ирак/Израиль намеренно не включены в список "иностранных стран": новости о них
    // слишком тесно переплетены с геополитикой вокруг России, чтобы автоматически считать
    // их "чужими" и уводить в "Не важно" (см. CONFLICT_ZONE_EXEMPT) — при этом сами по себе
    // они не дают и "Важно": слишком много рутинных повторяющихся заявлений о переговорах
    const FOREIGN_COUNTRIES_RE = wbRe([
        "сша", "us", "usa", "американ\\S*", "европа", "китай", "кнр", "германия", "франция",
        "великобритания", "англия", "британ\\S*",
        "япония", "канада", "индия", "бразилия", "тайвань", "коре[яию]|корее|кореей", "кндр", "казахстан", "таджикистан",
        "узбекистан", "кыргызстан", "туркменистан", "австралия", "оаэ", "турция", "индонезия", "вьетнам",
        "швейцария", "италия", "испания", "польша",
        // страны/регионы, где иногда проходят крупные IPO, не имеющие отношения к России
        "нигери\\S*", "африк\\S*", "персидск\\S* залив\\S*",
    ]);
    function isForeignCompany(t) {
        if (FOREIGN_COMPANIES.test(t)) return true;
        return extractLatinTickers(t).some(tk => !MOEX_TICKERS.has(tk) && !NON_TICKER_ACRONYMS.has(tk));
    }
    // Иран/Ормузский пролив — как и Ирак/Израиль выше, тесно переплетены с геополитикой
    // вокруг России (нефть, санкции, НАТО), поэтому даже при упоминании США/др. стран рядом
    // такие новости не должны автоматически уходить в "Не важно" по признаку "страна"
    const CONFLICT_ZONE_EXEMPT = /иран|ормуз/i;
    function isForeignCompanyOrCountry(t) {
        if (isForeignCompany(t)) return true;
        if (RU_SIGNAL.test(t) || CONFLICT_ZONE_EXEMPT.test(t)) return false;
        return FOREIGN_COUNTRIES_RE.test(t);
    }
    // упоминает Россию явно (слово/рубль/Мосбиржа) ИЛИ конкретный тикер Мосбиржи — более
    // широкий сигнал "это про российский рынок", чем один RU_SIGNAL (тот не ловит тикеры)
    function mentionsRussia(t) {
        return RU_SIGNAL.test(t) || extractLatinTickers(t).some(tk => MOEX_TICKERS.has(tk));
    }

    // "Важно": отчётность МСФО/РСБУ российских публичных компаний, ключевая ставка/решения
    // ЦБ РФ (именно российского — не индийского/др.), санкции (когда они касаются России или
    // ирано-американского конфликта), НАТО/конфликт на Украине/СВО, размещение ОФЗ, мобилизация,
    // атаки БПЛА на инфраструктуру, бюджет РФ, визиты первых лиц, выступления Путина/Пескова
    // и др.; IPO/SPO обрабатываются отдельно ниже — важны только для российских эмитентов.
    // Конфликт США-Иран/Ормузский пролив сам по себе НЕ делает новость важной (см. ниже
    // CONFLICT_ZONE_EXEMPT) — слишком много рутинных повторяющихся заявлений о переговорах,
    // различить реально значимую новость от очередного дежурного комментария по ключевым
    // словам надёжно не получилось; такие новости остаются в "Возможно".
    const OFZ_PLACEMENT = new RegExp(`${wb("офз")}.{0,30}(размещ|аукцион|минфин)|(размещ|аукцион|минфин).{0,30}${wb("офз")}`, "i");
    const DRONE_ATTACK = /(?=.*(атак|удар\S*|пожар))(?=.*(дрон|бпла|беспилотник))/i;
    const RU_BUDGET = new RegExp(`бюджет.{0,30}(росси|${wb("рф")})|(росси|${wb("рф")}).{0,30}бюджет`, "i");
    const HIGH_LEVEL_VISIT = /(визит|встреч\S*).{0,40}(глав[а-я]* (мид|государства)|президент\S*|премьер\S*)|(глав[а-я]* (мид|государства)|президент\S*|премьер\S*).{0,40}(визит|встреч\S*)/i;
    // ставка/решения ЦБ — важно только если не назван явно чужой ЦБ (например, "Индия - ставка ЦБ")
    const RATE_PATTERN = /ключевая ставка|ставк\S* цб|цб рф.{0,20}ставк|банк россии.{0,20}ставк/i;
    function isRuRateMention(t) {
        return RATE_PATTERN.test(t) && !FOREIGN_COUNTRIES_RE.test(t);
    }
    // ЦБ РФ сам совершает регуляторное действие — а не просто указан как источник цифры
    // ("... — данные ЦБ РФ" в конце предложения — просто атрибуция, не действие регулятора)
    function isCbRfAction(t) {
        return /цб рф/.test(t) && !/(данные|по данным)\s+цб рф/.test(t);
    }
    // санкции — важно, если они касаются России (явно или через тикер Мосбиржи) или
    // ирано-американского конфликта; санкции между двумя другими странами (напр. Китай-США)
    // сами по себе не входят в круг интересов
    function isRelevantSanctions(t) {
        return /санкци/.test(t) && (mentionsRussia(t) || CONFLICT_ZONE_EXEMPT.test(t));
    }
    // "СВО" как обозначение конфликта — важно; но "до СВО"/"с начала СВО" часто используется
    // просто как временная веха ("работа началась ещё до СВО"), без содержательной новости
    const SVO_MENTION = wbRe(["сво"]);
    const SVO_TIME_REFERENCE = /(до|с начала)\s+сво(?![a-zа-яё0-9])/i;
    function isSvoNews(t) {
        return SVO_MENTION.test(t) && !SVO_TIME_REFERENCE.test(t);
    }
    // Лавров/Рябков — любые их заявления важны (дипломатическая линия, переговоры с США/Европой)
    const PERSON_MENTIONS = /путин|песков|лавров|рябков|фон дер ляйен|урсула/i;
    // возобновление "Северного потока" напрямую влияет на Газпром и газовый рынок
    const NORD_STREAM = /северн\S* пот/i;
    // высказывания руководства ЦБ РФ о ставке — сигнал о будущих решениях по ставке; сам
    // RATE_PATTERN не расширяем, иначе ловятся прогнозы Грефа/Шохина и чужие ЦБ
    const CB_OFFICIAL_RATE = /(?=.*(тремасов|набиуллин|заботкин))(?=.*ставк)/i;
    const IMPORTANT_PATTERNS = [
        /мсфо/, /рсбу/,
        isRuRateMention, isCbRfAction,
        isRelevantSanctions,
        wbRe(["нато", "всу"]), isSvoNews,
        OFZ_PLACEMENT,
        /украин/, /киев/, /спецоперац/, /зеленск/, /донбасс/, /мобилизац/,
        PERSON_MENTIONS, NORD_STREAM, CB_OFFICIAL_RATE,
        DRONE_ATTACK, RU_BUDGET, HIGH_LEVEL_VISIT,
    ];
    function matchesImportant(t) {
        return IMPORTANT_PATTERNS.some(p => (typeof p === "function" ? p(t) : p.test(t)));
    }
    const IPO_SPO_PATTERN = /\bipo\b|\bspo\b/;

    // фактическая отчётность/дивиденды/значимое корпоративное событие российской компании —
    // достаточно самого факта отчётности/консенсуса про конкретную компанию (даже без
    // цифр выручки — например, анонс операционных результатов), но не общей макростатистики
    // вида PMI/запасов нефти/индексов, которую тоже иногда помечают тегом "#отчетность":
    // нужен тикер-хэштег компании или явное финансовое слово (выручка/прибыль/убыток/EBITDA).
    // Плюс реальные (не прогнозные, без префикса "МНЕНИЕ:") дивиденды и лимитная планка
    // (вниз/вверх) на торгах. Отраслевая статистика ("убытки отрасли угольщиков") не считается.
    function isRuCorporateEvent(t) {
        if (/^мнение:/.test(t)) return false;
        if (/отрасл/.test(t)) return false;
        // buyback и новая дивидендная политика влияют на цену акции в будущем; требования
        // ЦБ к дивполитикам компаний в целом — не корпоративное событие конкретного эмитента
        if (/buy ?back|байбэк|бай-бэк/.test(t)) return true;
        if (/дивидендн\S* политик|дивполитик/.test(t) && !/цб|банк россии/.test(t)) return true;
        if (/дивиденд/.test(t) && new RegExp(`${wb("сд")}|совет директоров|${wb("воса")}|руб\\S*\\/акц|\\d[.,]?\\d*\\s*руб\\b`).test(t)) return true;
        if (/отчетност|отчёт\S*|консенсус/.test(t) &&
            (/выручк|чистая прибыл|прибыл\S*|убыт\S*|\bebitda\b|\boibda\b/.test(t) ||
                extractLatinTickers(t).some(tk => MOEX_TICKERS.has(tk)))) return true;
        if (/(=|%).{0,15}планк\S*|планк\S*.{0,15}(=|%)/.test(t)) return true;
        return false;
    }

    // фактические (не "впереди"/анонс) данные по инфляции/дефляции в РФ — реальная цифра,
    // а не просто напоминание о том, что она выйдет позже
    const RU_INFLATION_DATA = new RegExp(`(инфляц\\S*|дефляц\\S*).{0,40}${wb("рф")}|(инфляц\\S*|дефляц\\S*).{0,40}росси|росси.{0,40}(инфляц\\S*|дефляц\\S*)|${wb("рф")}.{0,40}(инфляц\\S*|дефляц\\S*)`, "i");

    // события, не имеющие отношения к фондовому рынку вообще (концерты, реклама и т.п.) —
    // такие сообщения могут случайно содержать слова "путин"/"россия" по касательной
    const OFF_TOPIC_NOISE = /канье уэст|kanye west/i;

    function hasImportantSignal(t) {
        return matchesImportant(t) || RU_INFLATION_DATA.test(t) ||
            (isRuCorporateEvent(t) && !isForeignCompanyOrCountry(t));
    }

    // "Не важно": не биржевая информация (итоги/события дня, анонсы будущих данных), факт
    // курса валют без контекста, движение акции/индекса/сырья пост-фактум без новости, мнения
    // зарубежных инвестдомов и рейтинговых агентств, зарубежные макро-индексы (PMI/ISM/CPI),
    // криптовалюты, ИИ-хайп без привязки к российскому эмитенту, любая иностранная компания/
    // страна и сообщения без содержательного текста (только эмодзи/хэштеги)
    const NOT_IMPORTANT_DAILY_RECAP = new RegExp(
        ["итоги дня", "акции и инвестиции", "событи[яй] дня", "ожидаем следующие события", "сми оценили",
            "календарь на (сегодня|завтра)", "^[^a-zа-яё0-9]*доброе утро", "^[^a-zа-яё0-9]*добрый вечер",
            "^[^a-zа-яё0-9]*мт в max", "^[^a-zа-яё0-9]*mt в max", wb("впереди")].join("|"),
        "i"
    );
    const NOT_IMPORTANT_FX_FACT = /\busd\/?rub\s*=|\beur\/?usd\s*=|\busdcny\s*=|\busdtrub\s*=/;
    const NOT_IMPORTANT_PRICE_MOVE = /^[^\wа-яё]{0,6}#[\wа-яё]+\s*=\s*[+\-]?\d+([.,]\d+)?%/i;
    const COMMODITIES = ["медь", "золото", "серебро", "нефть", "газ", "пшениц\\S*", "кукуруз\\S*", "зерно", "сахар", "хлопок", "уголь", "алмаз\\S*", "кофе", "мясо"];
    const NOT_IMPORTANT_MARKET_CHATTER = new RegExp(
        [wb("imoex"), wb("rts"), wb("rgbi"), "индекс мосбиржи", "индекс офз", ...COMMODITIES.map(wb)].join("|"),
        "i"
    );
    // движение индекса пост-фактум ("📈 Индекс Мосбиржи ускорил рост после заявления ...") —
    // важен момент самой новости, а не реакция рынка на неё; проверяется до важных сигналов,
    // т.к. в таких постах почти всегда упоминается повод (Трамп/Песков/санкции и т.п.)
    const INDEX_MOVE = new RegExp(
        `(индекс мосбиржи|${wb("imoex")}|российский рынок).{0,60}(ускорил|пробил|ралли|взлет|рост|снижени|упал|вырос|[=+\\-−]\\s*\\d)|` +
        "(ралли|антиралли).{0,60}(российский рынок|индекс мосбиржи)",
        "i"
    );
    const PRICE_ARROW_START = /^[^a-zа-яё0-9]*(📈|📉|⬆️|⬇️)/u;
    // заметка об уже опубликованных постах Трампа ("Два поста Трампа в Truth Social ...")
    const TRUMP_POSTS_NOTE = /(пост[аов]*|твит\S*) трампа/i;
    const NOT_IMPORTANT_AI_HYPE = new RegExp(wb("ии"), "i");
    const FOREIGN_INSTITUTIONS = /goldman sachs|jpmorgan|jp morgan|morgan stanley|\bmorgan\b|bank of america|\bbofa\b|citigroup|deutsche bank|barclays|\bubs\b|credit suisse|wells fargo|societe generale|socgen|hsbc|bnp paribas|nomura|wedbush|evercore|moody'?s|fitch\b|\bs&p\b/i;
    const FOREIGN_MACRO = /\bpmi\b|\bism\b|nonfarm|non-farm|нонфарм|chicago pmi|dallas fed|core cpi|индекс потребительского доверия|\bifo\b|индекс делового климата|индекс цен производителей|manufacturing\/services\/composite/;

    // человекочитаемые названия для тикеров MOEX_TICKERS — используются в колонке
    // "Тема". Выгружены из справочника Мосбиржи (см. комментарий у MOEX_TICKERS) с
    // ручными уточнениями для читаемости; для тикера, не попавшего в карту (редкий
    // случай), в качестве темы используется сам тикер в верхнем регистре.
    const TICKER_NAMES = {
        abio: "Артген",
        abrd: "АбрауДюрсо",
        afks: "АФК Система",
        aflt: "Аэрофлот",
        akrn: "Акрон",
        alrs: "АЛРОСА",
        amez: "АшинскийМЗ",
        apri: "АПРИ",
        aptk: "Аптеки36и6",
        aqua: "Инарктика",
        arsa: "Арсагера",
        assb: "АстрЭнСб",
        astr: "Группа Астра",
        avan: "Авангрд",
        bane: "Башнефть",
        banep: "Башнефть",
        baza: "БАЗИС",
        belu: "НоваБев",
        bisvp: "БашИнСв",
        blng: "Белон",
        brzl: "БурЗолото",
        bspb: "Банк Санкт-Петербург",
        bspbp: "Банк Санкт-Петербург",
        btbr: "В2В-РТС",
        carm: "СТГ",
        cbom: "МКБ",
        chgz: "РН-ЗапСиб",
        chkz: "ЧКПЗ",
        chmf: "Северсталь",
        chmk: "ЧМК",
        cnru: "Циан",
        cntl: "Телеграф",
        cntlp: "Телеграф-п",
        data: "Аренадата",
        deli: "Делимобиль",
        dias: "Диасофт",
        diod: "Завод ДИОД",
        domrf: "ДОМ.РФ",
        dvec: "ДЭК",
        dzrd: "ДонскЗР",
        dzrdp: "ДонскЗР п",
        eelt: "ЕвроЭлтех",
        elfv: "ЭЛ5Энер",
        elmt: "Элемент",
        enpg: "Эн+ Групп",
        etln: "Эталон",
        eutr: "ЕвроТранс",
        evrz: "ЕВРАЗ",
        fees: "Россети (ФСК)",
        fesh: "ДВМП (FESCO)",
        five: "X5 Group",
        fixr: "Фикс Прайс",
        flot: "Совкомфлот",
        gaza: "ГАЗ",
        gazap: "ГАЗ",
        gazc: "ГАЗКОН",
        gazp: "Газпром",
        gazs: "ГАЗ-сервис",
        gazt: "ГАЗ-Тек",
        gche: "Черкизово",
        geco: "ГЕНЕТИКО",
        gema: "ММЦБ",
        gemc: "ЮМГ",
        glrx: "ГЛОРАКС",
        gmkn: "Норникель",
        gtrk: "ГТМ",
        head: "HeadHunter",
        himcp: "Химпром",
        hnfg: "Хендерсон",
        hydr: "РусГидро",
        igst: "Ижсталь2",
        igstp: "Ижсталь",
        incb: "Инкаб",
        irao: "Интер РАО",
        irkt: "Яковлев-3",
        ivat: "ИВА",
        jnos: "Славн-ЯНОС",
        jnosp: "Слав-ЯНОСп",
        kazt: "Куйбазот",
        kaztp: "Куйбазот-п",
        kbsb: "ТНСэКубань",
        kche: "КамчатЭ",
        kchep: "КамчатЭ",
        kfba: "ИНГРАД",
        kgkc: "КурганГК",
        kgkcp: "КурганГК",
        klsb: "КалужскСК",
        klvz: "Кристалл",
        kmaz: "КАМАЗ",
        kmez: "КМЗ",
        kogk: "КоршГОК",
        krkn: "СаратНПЗ",
        krknp: "СаратНПЗ-п",
        krkop: "ТКЗКК",
        krot: "КрасОкт",
        krotp: "КрасОкт-1п",
        krsb: "Красэсб",
        krsbp: "Красэсб",
        kube: "Кубаньэнерго",
        kuzb: "КузнецкийБ",
        kzos: "Казаньоргсинтез",
        kzosp: "Казаньоргсинтез",
        leas: "Европлан",
        lent: "Лента",
        life: "Фармсинтез",
        lkoh: "Лукойл",
        lmbz: "Ламбумиз",
        lnzl: "Лензолото",
        lnzlp: "Лензол.",
        lpsb: "ЛЭСК",
        lsng: "Ленэнерго",
        lsngp: "Ленэнерго",
        lsrg: "ЛСР",
        lvhk: "Левенгук",
        mage: "МагадЭн",
        magep: "МагадЭн",
        magn: "ММК",
        mbnk: "МТС Банк",
        mdmg: "МД Медикал Груп",
        mfgs: "Мегион",
        mfgsp: "Мегион",
        mgkl: "МГКЛ",
        mgnt: "Магнит",
        mgnz: "СМЗ",
        mgts: "МГТС-5",
        mgtsp: "МГТС-4",
        misb: "ТНСэнМарЭл",
        misbp: "ТНСэМаЭл-п",
        moex: "Московская биржа",
        mrkc: "РоссЦентр",
        mrkk: "Россети СК",
        mrkp: "РСетиЦП",
        mrks: "РсетСиб",
        mrku: "Россети Ур",
        mrkv: "РсетВол",
        mrky: "РоссЮг",
        mrkz: "РСетиСЗ",
        mrsb: "МордЭнСб",
        msng: "МосЭнерго",
        msrs: "РСетиМР",
        mstt: "Мостотрест",
        mtlr: "Мечел",
        mtlrp: "Мечел",
        mtss: "МТС",
        mvid: "М.Видео",
        nauk: "НПОНаука",
        nfaz: "НЕФАЗ",
        nkhp: "НКХП",
        nknc: "НКНХ",
        nkncp: "НКНХ",
        nksh: "Нижкамшина",
        nlmk: "НЛМК",
        nmtp: "НМТП",
        nnsb: "ТНСэнНН",
        nnsbp: "ТНСэнНН",
        novabev: "НоваБев",
        novatek: "НОВАТЭК",
        nsvz: "НаукаСвяз",
        nvtk: "НОВАТЭК",
        ogkb: "ОГК-2",
        okey: "О'КЕЙ",
        omzzp: "ОМЗ",
        ozon: "Ozon",
        ozph: "Озон Фармацевтика",
        ozpn: "Озон Фармацевтика",
        paza: "ПавлАвт",
        phor: "ФосАгро",
        pikk: "ПИК",
        plzl: "Полюс",
        pmsb: "ПермьЭнСб",
        pmsbp: "ПермьЭнС-п",
        poly: "Полиметалл",
        polymetal: "Полиметалл",
        posi: "Positive Technologies",
        prfn: "ТЕПЛАНТ",
        prmb: "Приморье",
        prmd: "Промомед",
        qiwi: "QIWI",
        ragr: "РусАгро",
        rasp: "Распадская",
        rbcm: "ГК РБК",
        rdrb: "РДБанк",
        reni: "Ренессанс Страхование",
        reno: "Ренессанс Страхование",
        rgss: "РГС СК",
        rkke: "ЭнергияРКК",
        rnft: "РуссНефть",
        rolo: "Русолово",
        rosn: "Роснефть",
        rost: "РОСИНТЕР",
        rtgz: "ГР Ростов",
        rtkm: "Ростелеком",
        rtkmp: "Ростелеком",
        rtsb: "ТНСэнРст",
        rtsbp: "ТНСэнРст-п",
        rual: "РУСАЛ",
        rusi: "ИКРУСС-ИНВ",
        russ: "Русолово",
        rzsb: "РязЭнСб",
        sago: "СамарЭн",
        sagop: "СамарЭн",
        sare: "СаратЭн",
        sarep: "СаратЭн",
        sber: "Сбербанк",
        sberp: "Сбербанк",
        selg: "Селигдар",
        sfin: "ЭсЭфАй",
        sgzh: "Сегежа",
        sibn: "Газпром нефть",
        slen: "Сахэнер",
        smlt: "Самолет",
        sngs: "Сургутнефтегаз",
        sngsp: "Сургутнефтегаз",
        sofl: "Softline",
        spbe: "СПБ Биржа",
        stsb: "ЕГП",
        stsbp: "ЕГП",
        svav: "СОЛЛЕРС",
        svcb: "Совкомбанк",
        svet: "Светофор",
        svetp: "Светофор п",
        t: "Т-Технологии",
        tasb: "ТамбЭнСб",
        tasbp: "ТамбЭнСб-п",
        tatn: "Татнефть",
        tatnp: "Татнефть",
        tcsg: "Т-Технологии",
        tcsi: "Т-Технологии",
        tgka: "ТГК-1",
        tgkb: "ТГК-2",
        tgkbp: "ТГК-2",
        tgkn: "ТГК-14",
        tnse: "ТНСэнрг",
        tors: "РСТомск",
        torsp: "РСТомск",
        trmk: "ТМК",
        trnfp: "Транснефть",
        ttlk: "Таттел.",
        tuza: "ТЗА",
        ugld: "ЮГК",
        ukuz: "ЮжКузб.",
        unac: "ОАК",
        unkl: "ЮУНК",
        upro: "Юнипро",
        urkz: "УрКузница",
        usbn: "УралСиб",
        utar: "ЮТэйр",
        uwgn: "ОВК",
        veon: "VEON",
        vgsb: "ВолгЭнСб",
        vgsbp: "ВолгЭнСб-п",
        vjgz: "Варьеган",
        vjgzp: "Варьеган-п",
        vkco: "VK",
        vlhz: "ВХЗ",
        vrsb: "ТНСэнВорон",
        vrsbp: "ТНСэнВор-п",
        vseh: "ВИ.ру",
        vsmo: "ВСМПО-АВИСМА",
        vsyd: "ВыбСудЗ",
        vsydp: "ВыбСудЗ",
        vtbr: "ВТБ",
        wb: "Wildberries",
        wtcm: "ЦМТ",
        wtcmp: "ЦМТ",
        wush: "Whoosh",
        x5: "X5 Group",
        yakg: "ЯТЭК",
        ydex: "Яндекс",
        yken: "Якутскэнрг",
        ykenp: "Якутскэн-п",
        yndx: "Яндекс",
        yrsb: "ТНСэнЯр",
        yrsbp: "ТНСэнЯр-п",
        zaym: "Займер",
        zill: "ЗИЛ",
        zvez: "ЗВЕЗДА",
    };

    // конфликт Россия-Украина: НАТО/ВСУ/СВО/санкции-повод, дроны и т.п.
    function isUkraineConflict(t) {
        return wbRe(["нато", "всу"]).test(t) || isSvoNews(t) ||
            /украин|киев|спецоперац|зеленск|донбасс|мобилизац/.test(t) || DRONE_ATTACK.test(t);
    }
    // конфликт США-Иран (Ормузский пролив и т.п.)
    function isIranConflict(t) {
        return CONFLICT_ZONE_EXEMPT.test(t);
    }
    // тема ЦБ: ставка, действия ЦБ РФ, заявления руководства ЦБ о ставке, инфляция, бюджет РФ
    function isCbTopic(t) {
        return isRuRateMention(t) || isCbRfAction(t) || CB_OFFICIAL_RATE.test(t) || RU_INFLATION_DATA.test(t) || RU_BUDGET.test(t);
    }
    // название российской компании — по тикеру-хэштегу из MOEX_TICKERS (переводится в
    // читаемое имя через TICKER_NAMES) либо, если тикера в тексте нет, но событие явно
    // корпоративное (isRuCorporateEvent), обобщённой пометкой
    function getCompanyTopic(t) {
        const tickers = [...new Set(extractLatinTickers(t).filter(tk => MOEX_TICKERS.has(tk)))];
        if (tickers.length) return tickers.map(tk => TICKER_NAMES[tk] || tk.toUpperCase()).join(", ");
        if (isRuCorporateEvent(t)) return "Российская компания";
        return "";
    }
    // тема новости — заполняется только для "Важно": название компании, "Украина", "Иран"
    // или "ЦБ" (порядок проверки соответствует приоритету, заданному пользователем)
    function classifyTopic(t, importance) {
        if (importance !== "Важно") return "";
        const company = getCompanyTopic(t);
        if (company) return company;
        if (isUkraineConflict(t)) return "Украина";
        if (isIranConflict(t)) return "Иран";
        if (isCbTopic(t)) return "ЦБ";
        return "";
    }

    function classifyImportance(rawText) {
        const t = rawText.toLowerCase();

        if (OFF_TOPIC_NOISE.test(t)) return "Не важно";

        // сообщение без содержательного текста — только эмодзи/хэштеги/пунктуация
        const stripped = t.replace(/#[a-zа-яё0-9_]+/gi, "").replace(/[^a-zа-яё0-9]/gi, "").trim();
        if (stripped.length < 3) return "Не важно";

        if (NOT_IMPORTANT_DAILY_RECAP.test(t)) return "Не важно";

        if (PRICE_ARROW_START.test(t) && INDEX_MOVE.test(t)) return "Не важно";

        if (TRUMP_POSTS_NOTE.test(t)) return "Не важно";

        if ((/#fx\b/.test(t) || NOT_IMPORTANT_FX_FACT.test(t)) && !hasImportantSignal(t)) return "Не важно";

        if (NOT_IMPORTANT_PRICE_MOVE.test(t) && t.length < 160 && !hasImportantSignal(t)) return "Не важно";

        if (NOT_IMPORTANT_MARKET_CHATTER.test(t) && t.length < 200 && !hasImportantSignal(t)) return "Не важно";

        if (RU_INFLATION_DATA.test(t)) return "Важно";

        if (matchesImportant(t)) return "Важно";

        // IPO/SPO — важно только для российских эмитентов, иностранные размещения не интересны
        if (IPO_SPO_PATTERN.test(t)) return isForeignCompanyOrCountry(t) ? "Не важно" : "Важно";

        if (CRYPTO_PATTERN.test(t)) return "Не важно";

        // конкретная отчётность/дивиденды/лимитная планка российской компании — важно,
        // даже если явных слов "МСФО"/"РСБУ" в тексте нет
        if (isRuCorporateEvent(t) && !isForeignCompanyOrCountry(t)) return "Важно";

        if (FOREIGN_INSTITUTIONS.test(t)) return "Не важно";
        if (FOREIGN_MACRO.test(t)) return "Не важно";
        if (isForeignCompanyOrCountry(t)) return "Не важно";

        if (NOT_IMPORTANT_AI_HYPE.test(t) && !RU_SIGNAL.test(t)) return "Не важно";

        return "Возможно";
    }

    function fmtTiming(dateStr, timeStr, ts) {
        let h, mm, ss;
        if (ts) {
            const d = new Date(ts * 1000);
            h = d.getHours();
            mm = pad(d.getMinutes());
            ss = pad(d.getSeconds());
        } else {
            const m = timeStr.match(/^(\d{1,2}):(\d{2})$/);
            h = m ? Number(m[1]) : 0;
            mm = m ? m[2] : "00";
            ss = "00";
        }
        return `${dateStr} ${h}:${mm}:${ss}`;
    }

    // ---------- поиск контейнера ----------
    function scrollableAncestors(el) {
        const out = [];
        let cur = el;
        while (cur && cur !== document.body) {
            if (cur.scrollHeight > cur.clientHeight + 20) out.push(cur);
            cur = cur.parentElement;
        }
        return out;
    }

    function candidates() {
        const set = new Set();

        // только видимые баблы — отсекает скрытые чаты
        const bubbles = [...document.querySelectorAll(".bubble[data-mid]")].filter(isShown);
        for (const b of bubbles.slice(0, 40)) scrollableAncestors(b).forEach(a => set.add(a));

        document.querySelectorAll(".bubbles .scrollable-y, .bubbles .scrollable, .bubbles")
            .forEach(e => { if (isShown(e) && e.scrollHeight > e.clientHeight + 20) set.add(e); });

        return [...set]
            .map(el => ({ el, n: [...el.querySelectorAll(".bubble[data-mid]")].filter(isShown).length }))
            .filter(c => c.n > 0)
            .sort((a, b) => b.n - a.n)
            .map(c => c.el);
    }

    function wheelScroll(el, dy) {
        el.dispatchEvent(new WheelEvent("wheel", { deltaY: dy, bubbles: true, cancelable: true }));
    }

    // эмулирует непрерывный тачпад-скролл: много маленьких сдвигов с короткими паузами
    // вместо одного большого прыжка — Telegram Web видит постепенное движение позиции
    // и подгружает (prefetch) сообщения по ходу дела, как при ручной прокрутке
    const SUBSTEPS = 12;
    const SUBSTEP_DELAY_MS = 12;
    async function smoothScroll(el, totalDelta, onSubstep) {
        const chunk = totalDelta / SUBSTEPS;
        for (let i = 0; i < SUBSTEPS; i++) {
            el.scrollTop += chunk;
            onSubstep();
            await sleep(SUBSTEP_DELAY_MS);
        }
    }

    async function probe(el) {
        const t = el.scrollTop;
        el.scrollTop = t + 150;
        await sleep(70);
        let ok = Math.abs(el.scrollTop - t) > 1;
        if (!ok) { el.scrollTop = Math.max(0, t - 150); await sleep(70); ok = Math.abs(el.scrollTop - t) > 1; }
        el.scrollTop = t;
        return ok;
    }

    // ждём, пока чат вообще отрисуется (до 8 с)
    let list = [];
    for (let i = 0; i < 40 && !list.length; i++) { list = candidates(); if (!list.length) await sleep(200); }
    if (!list.length) { alert("Не найдено ни одного видимого сообщения.\nОткройте канал и дождитесь загрузки."); return; }

    let scroller = null;
    for (const c of list) { if (await probe(c)) { scroller = c; break; } }
    if (!scroller) scroller = list[0];   // лента короче экрана — соберём что есть
    console.log("[TG-K] Контейнер:", scroller, "| кандидатов:", list.length);

    // ---------- парсинг ----------
    const data = new Map();
    const pending = new Set();
    let mutated = false;
    let minSeenDate = null; // при скролле вверх — самая старая дата из уже собранных

    const isRealMessage = b =>
        !b.classList.contains("service") && !b.classList.contains("is-date") &&
        !b.classList.contains("is-sponsored") && !b.classList.contains("sponsored");

    function extractMessageText(b) {
        const el = b.querySelector(".message");
        if (!el) return "";
        const c = el.cloneNode(true);
        c.querySelectorAll(".time, .time-inner, reactions-element, .reactions, .reply-markup, " +
                           ".webpage, .web, .message-views, .post-views, button").forEach(n => n.remove());
        return cleanText(c.innerText || c.textContent || "");
    }

    const MONTHS_RU = {
        "янв": 1, "февр": 2, "фев": 2, "март": 3, "мар": 3, "апр": 4, "ма": 5, "май": 5, "мая": 5,
        "июн": 6, "июл": 7, "авг": 8, "сент": 9, "сен": 9, "окт": 10, "нояб": 11, "ноя": 11, "дек": 12
    };

    // ищем ближайший видимый разделитель даты (".is-date") перед сообщением b
    function findNearestDateSeparator(b) {
        let cur = b.previousElementSibling;
        while (!cur) {
            const parent = b.parentElement;
            if (!parent) break;
            cur = parent.previousElementSibling;
            b = parent;
        }
        while (cur) {
            if (cur.classList && cur.classList.contains("is-date")) {
                const raw = cleanText(cur.innerText || cur.textContent || "").toLowerCase();
                const m = raw.match(/(\d{1,2})\s+([а-яё]+)(?:\s+(\d{4}))?/i);
                if (m) {
                    const day = Number(m[1]);
                    const monthKey = Object.keys(MONTHS_RU).find(k => m[2].startsWith(k));
                    const month = monthKey ? MONTHS_RU[monthKey] : null;
                    const year = m[3] ? Number(m[3]) : new Date().getFullYear();
                    if (month) return `${pad(day)}.${pad(month)}.${year}`;
                }
                if (/сегодня|today/i.test(raw)) return fmtDate(new Date());
                if (/вчера|yesterday/i.test(raw)) { const d = new Date(); d.setDate(d.getDate() - 1); return fmtDate(d); }
            }
            cur = cur.previousElementSibling;
        }
        return null;
    }

    function extractStamp(b) {
        const ts = Number(b.dataset.timestamp || b.getAttribute("data-timestamp"));
        if (ts) { const d = new Date(ts * 1000); return { time: fmtTime(d), date: fmtDate(d), ts }; }
        const t = b.querySelector(".time-inner") || b.querySelector(".time");
        const raw = cleanText(t ? (t.innerText || "") : "");
        const m = raw.match(/\b([01]?\d|2[0-3]):[0-5]\d\b/);
        const date = findNearestDateSeparator(b) || fmtDate(new Date());
        return { time: m ? m[0] : "", date, ts: 0 };
    }

    function tryParse(b) {
        if (!isRealMessage(b)) return true;
        const id = b.getAttribute("data-mid") || b.getAttribute("data-message-id") || "";
        if (id && data.has(id)) return true;
        const text = extractMessageText(b);
        const { time, date, ts } = extractStamp(b);
        if (!text || !time) { b.__t = (b.__t || 0) + 1; return b.__t > 25; }
        if (DIRECTION === -1 && STOP_DATE) {
            const d = parseRuDate(date);
            if (d && (!minSeenDate || d < minSeenDate)) minSeenDate = d;
        }
        const key = id || `${time}||${text.slice(0, 200)}`;
        // ts (unix-секунды, ~1.7e9) и порядковый номер живут в разных диапазонах,
        // чтобы сообщения без timestamp не перемешивались с сообщениями, у которых он есть
        const timing = fmtTiming(date, time, ts);
        const importance = classifyImportance(text);
        const topic = classifyTopic(text.toLowerCase(), importance);
        if (!data.has(key)) data.set(key, { sort: ts || (1e12 + data.size), id, channel: CHANNEL, text, date, time, timing, importance, topic });
        return true;
    }

    function flush() {
        for (const b of pending) if (tryParse(b)) pending.delete(b);
        // ВАЖНО: ищем по всему документу, а не внутри scroller
        document.querySelectorAll(".bubble[data-mid], .bubble[data-message-id]").forEach(tryParse);
        const c = document.getElementById("tg-export-count");
        if (c) c.innerText = String(data.size);
    }

    const observer = new MutationObserver(muts => {
        mutated = true;
        for (const m of muts) for (const n of m.addedNodes) {
            if (n.nodeType !== 1) continue;
            if (n.classList?.contains("bubble")) pending.add(n);
            n.querySelectorAll?.(".bubble[data-mid]").forEach(x => pending.add(x));
        }
    });
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });

    async function waitRender() {
        const t0 = performance.now();
        await sleep(MIN_WAIT_MS);
        let idle = 0;
        while (performance.now() - t0 < MAX_WAIT_MS) {
            flush();
            if (mutated) { mutated = false; idle = 0; }
            else if (++idle >= IDLE_TICKS) break;
            await sleep(TICK_MS);
        }
        flush();
    }

    const panel = document.createElement("div");
    panel.style = `position:fixed;top:16px;right:16px;z-index:999999;background:#202020;color:#fff;
                   padding:12px 16px;border-radius:10px;font:14px/1.4 Arial,sans-serif;
                   box-shadow:0 4px 18px rgba(0,0,0,.4);`;
    panel.innerHTML = `<b>TG Export (Web K)</b><br>
        Собрано: <span id="tg-export-count">0</span><br>
        Шаг: <span id="tg-export-step">0</span> <span id="tg-export-eta"></span><br>
        ${STOP_DATE ? `Дошли до: <span id="tg-export-date">—</span> (цель: ${fmtDate(STOP_DATE)})<br>` : ""}
        <button id="tg-export-stop" style="margin-top:8px;padding:6px 10px;background:#d33;color:#fff;
                border:0;border-radius:6px;cursor:pointer;font-weight:bold;">Остановить и выгрузить</button>`;
    document.body.appendChild(panel);
    let stopped = false;
    document.getElementById("tg-export-stop").onclick = () => { stopped = true; };

    flush();
    const started = performance.now();
    let same = 0;

    for (let step = 1; step <= MAX_STEPS && !stopped; step++) {
        document.getElementById("tg-export-step").innerText = String(step);

        const before = scroller.scrollTop;
        const delta = Math.round(scroller.clientHeight * SCROLL_RATIO) * DIRECTION;

        await smoothScroll(scroller, delta, flush);
        if (Math.abs(scroller.scrollTop - before) < 1) {   // запасной способ
            wheelScroll(scroller, delta);
            await sleep(80);
        }

        await waitRender();

        if (Math.abs(scroller.scrollTop - before) < 1) same++; else same = 0;
        if (same >= 5) { console.log("[TG-K] Конец ленты или скролл заблокирован."); break; }

        // докручиваем на один день дальше цели, чтобы гарантированно догрузить
        // ВСЕ сообщения самого целевого дня (иначе можно остановиться на середине
        // дня, пока часть его сообщений ещё не подгрузилась) — лишний день потом
        // отрезается фильтром при формировании итоговой таблицы
        if (DIRECTION === -1 && STOP_DATE && minSeenDate && minSeenDate < STOP_DATE) {
            console.log("[TG-K] Достигнута заданная дата остановки:", fmtDate(STOP_DATE));
            break;
        }

        document.getElementById("tg-export-eta").innerText =
            `${((performance.now() - started) / 1000).toFixed(1)} c`;
        if (STOP_DATE && minSeenDate) {
            const dEl = document.getElementById("tg-export-date");
            if (dEl) dEl.innerText = fmtDate(minSeenDate);
        }
    }

    await waitRender();
    await sleep(300);
    flush();
    observer.disconnect();
    panel.remove();

    if (!data.size) {
        alert("Собрано 0 сообщений.\nВыполните в консоли диагностику:\n" +
              "[...document.querySelectorAll('.bubbles')].map(e=>[e.className,e.querySelectorAll('.bubble[data-mid]').length,e.offsetParent!==null])");
        return;
    }

    // при скролле вверх до даты мы намеренно докручиваем на один день дальше цели
    // (см. цикл выше) — теперь отрезаем всё, что старше выбранной даты, оставляя
    // её включительно
    let values = Array.from(data.values());
    if (DIRECTION === -1 && STOP_DATE) {
        values = values.filter(v => {
            const d = parseRuDate(v.date);
            return !d || d >= STOP_DATE;
        });
    }
    const rows = values.sort((a, b) => a.sort - b.sort).map(v => tsvLine(v));
    const result = TSV_HEADER + "\n" + rows.join("\n");
    console.log(result);

    // кладём канал в накопление — общая выгрузка всех каналов с пометкой дублей
    // делается из панели статуса (пункт меню «Статус сбора / общая выгрузка»)
    const total = mergeIntoStore(CHANNEL, values);
    const secs = ((performance.now() - started) / 1000).toFixed(1);
    const copied = await copyResult(result);
    showStatusPanel(`Готово за ${secs} c. «${CHANNEL}»: собрано ${values.length}, ` +
                    (copied ? "таблица канала скопирована в буфер обмена." : "скопируйте таблицу канала из поля слева (Ctrl+C).") +
                    ` Всего в накоплении: ${total}.`);
    }

    if (typeof GM_registerMenuCommand === "function") {
        GM_registerMenuCommand("Собрать новости с канала", () => { runParser().catch(console.error); });
        GM_registerMenuCommand("Статус сбора / общая выгрузка", () => showStatusPanel());
    } else {
        console.warn("[TG-K] GM_registerMenuCommand недоступен — запустите runParser() или showStatusPanel() вручную из консоли.");
        window.runParser = runParser;
        window.showStatusPanel = showStatusPanel;
    }
})();
