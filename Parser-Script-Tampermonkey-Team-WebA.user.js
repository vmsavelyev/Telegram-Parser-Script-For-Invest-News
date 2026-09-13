// ==UserScript==
// @name         Telegram Web A — экспорт новостей канала
// @namespace    telegram-parser-script-for-invest-news
// @version      1.8.0
// @description  Выгружает текст сообщений из открытого канала/чата в веб-версии Telegram (Web A) в таблицу с колонками «Надо брать», «Текст сообщения», «Дата», «Время», «Канал», «Тайминг», «Тема» и копирует результат в буфер обмена (TSV).
// @author       vmsavelyev
// @match        https://web.telegram.org/a/*
// @grant        GM_registerMenuCommand
// @grant        GM_setClipboard
// @run-at       document-idle
// ==/UserScript==

// Логика идентична консольной/K-версии скрипта (см. файлы Parser-Script и
// Parser-Script-Tampermonkey-Team.user.js в репозитории) — отличия только в разметке
// DOM, под которую заточен разбор сообщений, т.к. Web A и Web K это два разных
// фронтенда Telegram с разной вёрсткой (Web A: .Message[data-message-id], .text-content,
// .message-time с форматом 12ч AM/PM — вместо .bubble[data-mid]/.time-inner в Web K).
// Поиск разделителя даты сделан по общему паттерну "класс содержит date + текст похож
// на дату" (не привязан к конкретному имени класса) — если в вашей сборке Web A даты
// в колонке "Дата" определяются неверно, пришлите outerHTML плашки-разделителя даты
// из ленты, чтобы уточнить findNearestDateSeparator().

(function () {
    "use strict";

    // метка сборки — печатается в консоль при старте, чтобы было видно, какая именно
    // версия скрипта реально выполняется в браузере (Tampermonkey хранит свою копию,
    // и правки файла на диске в него сами не попадают)
    const BUILD = "1.8.0 / scroll-snap-off";

    async function runParser() {
    console.log("[TG-A] build:", BUILD);
    // тайминги приведены к тем же значениям, что и в K-версии — вдали от края уже
    // отрендеренного диапазона Web A прекрасно успевает за быстрым скроллом, разница
    // была не в общей скорости, а в двух конкретных багах (см. историю правок ниже):
    // дублирующий wheel-event ломал внутреннюю логику Teact, а условие "конец ленты"
    // срабатывало слишком рано. У самого края всё ещё чуть придерживаем скорость
    // (см. nearEdge ниже) — там Web A реально может не успевать дозагружать историю.
    const SCROLL_RATIO = 2.5;
    const TICK_MS      = 20;
    const IDLE_TICKS   = 1;
    const MIN_WAIT_MS  = 10;
    const MAX_WAIT_MS  = 900;
    const MAX_STEPS    = 5000;
    // сколько подряд шагов у самого края диапазона без новых собранных сообщений
    // считать "точно конец ленты" — с запасом, т.к. подгрузка следующей пачки
    // сообщений с сервера может занять больше одного цикла ожидания
    const SAME_LIMIT   = 6;
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
            ".MiddleHeader .fullName",
            ".MiddleHeader .title .fullName",
            ".MiddleHeader .title",
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
    const PERSON_MENTIONS = /путин|песков|фон дер ляйен|урсула/i;
    const IMPORTANT_PATTERNS = [
        /мсфо/, /рсбу/,
        isRuRateMention, isCbRfAction,
        isRelevantSanctions,
        wbRe(["нато", "всу"]), isSvoNews,
        OFZ_PLACEMENT,
        /украин/, /спецоперац/, /зеленск/, /донбасс/, /мобилизац/,
        PERSON_MENTIONS,
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
        ["итоги дня", "событи[яй] дня", "календарь на (сегодня|завтра)", "^доброе утро", "^добрый вечер",
            "^мт в max", "^mt в max", wb("впереди")].join("|"),
        "i"
    );
    const NOT_IMPORTANT_FX_FACT = /\busd\/?rub\s*=|\beur\/?usd\s*=|\busdcny\s*=|\busdtrub\s*=/;
    const NOT_IMPORTANT_PRICE_MOVE = /^[^\wа-яё]{0,6}#[\wа-яё]+\s*=\s*[+\-]?\d+([.,]\d+)?%/i;
    const COMMODITIES = ["медь", "золото", "серебро", "нефть", "газ", "пшениц\\S*", "кукуруз\\S*", "зерно", "сахар", "хлопок", "уголь", "алмаз\\S*", "кофе", "мясо"];
    const NOT_IMPORTANT_MARKET_CHATTER = new RegExp(
        [wb("imoex"), wb("rts"), wb("rgbi"), "индекс мосбиржи", "индекс офз", ...COMMODITIES.map(wb)].join("|"),
        "i"
    );
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
            /украин|спецоперац|зеленск|донбасс|мобилизац/.test(t) || DRONE_ATTACK.test(t);
    }
    // конфликт США-Иран (Ормузский пролив и т.п.)
    function isIranConflict(t) {
        return CONFLICT_ZONE_EXEMPT.test(t);
    }
    // тема ЦБ: ставка, действия ЦБ РФ, инфляция, бюджет РФ
    function isCbTopic(t) {
        return isRuRateMention(t) || isCbRfAction(t) || RU_INFLATION_DATA.test(t) || RU_BUDGET.test(t);
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
    // ВАЖНО: одного условия scrollHeight > clientHeight недостаточно — в Web A между
    // лентой (.MessageList, у неё реальный overflow) и сообщениями есть обёртки
    // (.Transition_slide, .messages-container) с таким же большим scrollHeight, но БЕЗ
    // overflow. Присваивание scrollTop такой обёртке молча игнорируется и всегда
    // читается как 0 — если выбрать её контейнером, скролл просто не работает.
    function isScrollable(el) {
        if (el.scrollHeight <= el.clientHeight + 20) return false;
        const oy = getComputedStyle(el).overflowY;
        return oy === "auto" || oy === "scroll" || oy === "overlay";
    }

    function candidates() {
        // только видимые сообщения — отсекает скрытые чаты; поиск скролл-контейнера
        // намеренно не завязан на конкретный класс ленты (в отличие от K, где есть
        // ".bubbles") — Web A ищем через скроллящийся предок сообщений
        const messages = [...document.querySelectorAll(".Message[data-message-id]")].filter(isShown);

        const collect = strict => {
            const set = new Set();
            for (const b of messages.slice(0, 40)) {
                let cur = b;
                while (cur && cur !== document.body) {
                    if (strict ? isScrollable(cur) : cur.scrollHeight > cur.clientHeight + 20) set.add(cur);
                    cur = cur.parentElement;
                }
            }
            return [...set]
                .map(el => ({ el, n: [...el.querySelectorAll(".Message[data-message-id]")].filter(isShown).length }))
                .filter(c => c.n > 0)
                .sort((a, b) => b.n - a.n)
                .map(c => c.el);
        };

        // сначала только элементы с настоящим overflow, и лишь если таких нет —
        // старая, более широкая проверка (на случай нестандартной сборки Web A)
        const strict = collect(true);
        return strict.length ? strict : collect(false);
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

    // Проверку читаем СИНХРОННО, без sleep: присваивание scrollTop применяется сразу,
    // а вот Telegram, когда лента стоит в самом низу, через несколько миллисекунд
    // возвращает позицию обратно (держит вид "прилипшим" к последнему сообщению) — с
    // паузой внутри проверки это выглядело как "элемент не скроллится", и скрипт
    // сваливался на первую попавшуюся обёртку. Именно поэтому режим "вверх" (в нём
    // старт как раз из самого низа ленты) не работал, а "вниз" работал.
    function probe(el) {
        const t = el.scrollTop;
        el.scrollTop = t + 150;
        let ok = Math.abs(el.scrollTop - t) > 1;
        if (!ok) {
            el.scrollTop = Math.max(0, t - 150);
            ok = Math.abs(el.scrollTop - t) > 1;
        }
        el.scrollTop = t;
        return ok;
    }

    // ждём, пока чат вообще отрисуется (до 8 с)
    let list = [];
    for (let i = 0; i < 40 && !list.length; i++) { list = candidates(); if (!list.length) await sleep(200); }
    if (!list.length) { alert("Не найдено ни одного видимого сообщения.\nОткройте канал и дождитесь загрузки."); return; }

    console.log("[TG-A] Кандидаты в контейнер (" + list.length + "):", list.map(el => ({
        tag: el.tagName, id: el.id, cls: el.className, overflowY: getComputedStyle(el).overflowY,
        scrollHeight: el.scrollHeight, clientHeight: el.clientHeight,
        msgCount: el.querySelectorAll(".Message[data-message-id]").length
    })));

    let scroller = null;
    for (const c of list) { if (probe(c)) { scroller = c; break; } }
    if (!scroller) scroller = list[0];   // лента короче экрана — соберём что есть
    console.log("[TG-A] Выбран контейнер:", scroller, {
        tag: scroller.tagName, id: scroller.id, cls: scroller.className,
        overflowY: getComputedStyle(scroller).overflowY,
        scrollSnapType: getComputedStyle(scroller).scrollSnapType,
        scrollHeight: scroller.scrollHeight, clientHeight: scroller.clientHeight, scrollTop: scroller.scrollTop
    });

    // Telegram вешает на ленту CSS scroll-snap (класс with-bottom-snap), чтобы вид
    // "прилипал" к последнему сообщению. При программном изменении scrollTop браузер
    // тут же возвращает позицию к точке привязки — из-за этого скролл ВВЕРХ вообще не
    // двигался с места, а вниз (к той же нижней привязке) работал. Снимаем привязку на
    // время сбора: инлайновый стиль + правило с !important, т.к. класс с привязкой
    // Telegram может навешивать заново при перерисовке.
    const snapKiller = document.createElement("style");
    snapKiller.textContent = `.MessageList, .MessageList > *, .messages-container, .messages-container > * {
        scroll-snap-type: none !important;
        scroll-snap-align: none !important;
    }`;
    document.head.appendChild(snapKiller);
    const prevSnapType = scroller.style.scrollSnapType;
    scroller.style.scrollSnapType = "none";
    console.log("[TG-A] scroll-snap отключён, стало:", getComputedStyle(scroller).scrollSnapType);

    // ---------- парсинг ----------
    const data = new Map();
    const pending = new Set();
    let mutated = false;
    let minSeenDate = null; // при скролле вверх — самая старая дата из уже собранных

    const isRealMessage = b => !/sponsor/i.test(b.className || "");

    function extractMessageText(b) {
        const el = b.querySelector(".text-content");
        if (!el) return "";
        const c = el.cloneNode(true);
        // кастомные эмодзи в Web A рендерятся как <img>, alt-текст (сам эмодзи) не
        // попадает в innerText/textContent — подменяем такие узлы на текстовый узел
        // с их alt, чтобы эмодзи со смыслом (❗️, 🏦 и т.п.) не терялись из текста
        c.querySelectorAll("[data-alt]").forEach(n => {
            const alt = n.getAttribute("data-alt");
            if (alt) n.replaceWith(document.createTextNode(alt));
        });
        c.querySelectorAll(".MessageMeta, .Reactions, .message-action-buttons, .message-action-buttons-container, " +
                           ".CommentButton, .svg-appendix, .quick-reaction, button").forEach(n => n.remove());
        return cleanText(c.innerText || c.textContent || "");
    }

    const MONTHS_RU = {
        "янв": 1, "февр": 2, "фев": 2, "март": 3, "мар": 3, "апр": 4, "ма": 5, "май": 5, "мая": 5,
        "июн": 6, "июл": 7, "авг": 8, "сент": 9, "сен": 9, "окт": 10, "нояб": 11, "ноя": 11, "дек": 12
    };
    const MONTHS_EN = {
        jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
        jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12
    };
    // порядок как у Date#getDay(): 0=воскресенье
    const WEEKDAYS_EN = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

    // разбирает текст плашки-разделителя даты в "дд.мм.гггг"; возвращает null, если
    // текст не похож на дату (используется и для поиска кандидатов, и для парсинга).
    // Web A (в отличие от K) вместо "12 сентября" под датой последней недели показывает
    // название дня недели по-английски ("Tuesday"), а более старые даты — в английском
    // формате месяца ("12 September"/"September 12") — нужно распознавать оба варианта,
    // иначе разделитель молча отбрасывается и все сообщения проваливаются в fallback
    // "сегодня" (это и было причиной, что все даты в выгрузке совпадали).
    function parseDateSeparatorText(raw) {
        raw = raw.toLowerCase().trim();

        // русский формат: "12 сентября" / "12 сентября 2026"
        let m = raw.match(/(\d{1,2})\s+([а-яё]+)(?:\s+(\d{4}))?/i);
        if (m) {
            const monthKey = Object.keys(MONTHS_RU).find(k => m[2].startsWith(k));
            if (monthKey) {
                const year = m[3] ? Number(m[3]) : new Date().getFullYear();
                return `${pad(Number(m[1]))}.${pad(MONTHS_RU[monthKey])}.${year}`;
            }
        }

        // английский формат: "12 September" / "September 12" (год опционален)
        m = raw.match(/(\d{1,2})\s+([a-z]+)\.?,?\s*(\d{4})?/i) ||
            raw.match(/([a-z]+)\.?\s+(\d{1,2}),?\s*(\d{4})?/i);
        if (m) {
            const isDayFirst = /^\d/.test(m[0]);
            const day = Number(isDayFirst ? m[1] : m[2]);
            const monthWord = isDayFirst ? m[2] : m[1];
            const year = m[3] ? Number(m[3]) : new Date().getFullYear();
            const monthKey = Object.keys(MONTHS_EN).find(k => monthWord.startsWith(k));
            if (monthKey && day >= 1 && day <= 31) {
                return `${pad(day)}.${pad(MONTHS_EN[monthKey])}.${year}`;
            }
        }

        if (/сегодня|^today$/i.test(raw)) return fmtDate(new Date());
        if (/вчера|^yesterday$/i.test(raw)) { const d = new Date(); d.setDate(d.getDate() - 1); return fmtDate(d); }

        // день недели ("Tuesday") — Web A показывает так даты за последние ~6 дней;
        // берём ближайшее ПРОШЕДШЕЕ (или сегодняшнее) число с этим днём недели
        const wIdx = WEEKDAYS_EN.indexOf(raw);
        if (wIdx !== -1) {
            const now = new Date();
            const diff = (now.getDay() - wIdx + 7) % 7;
            const d = new Date(now);
            d.setDate(d.getDate() - diff);
            return fmtDate(d);
        }

        return null;
    }

    // Web A группирует сообщения по датам без стабильного класса, известного заранее
    // (в отличие от K, где это всегда ".is-date") — поэтому ищем generic: любой элемент,
    // в className которого встречается "date", с коротким текстом, похожим на дату.
    // Кандидаты кэшируются и обновляются в refreshDateCandidates() раз за flush(), а не
    // на каждое сообщение, иначе querySelectorAll по всему документу на каждый вызов
    // был бы слишком дорогим при тысячах сообщений в ленте.
    let dateCandidates = [];
    function refreshDateCandidates() {
        dateCandidates = [...document.querySelectorAll('[class*="date" i]')]
            .filter(el => {
                if (el.children.length > 3) return false; // не контейнер с кучей сообщений внутри
                const raw = cleanText(el.innerText || el.textContent || "");
                return raw.length > 0 && raw.length < 40 && parseDateSeparatorText(raw) !== null;
            });
    }
    // ближайший кандидат, стоящий в DOM раньше b (по document position)
    function findNearestDateSeparator(b) {
        let best = null;
        for (const el of dateCandidates) {
            const pos = el.compareDocumentPosition(b);
            if (pos & Node.DOCUMENT_POSITION_FOLLOWING) { // b идёт после el
                if (!best || (best.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING)) best = el;
            }
        }
        if (!best) return null;
        return parseDateSeparatorText(cleanText(best.innerText || best.textContent || ""));
    }

    // время в Web A — 12-часовой формат с AM/PM ("09:50 AM"), в отличие от 24-часового в K
    function parseTime12(raw) {
        const m = raw.match(/\b(\d{1,2}):(\d{2})\s*(AM|PM)?\b/i);
        if (!m) return null;
        let h = Number(m[1]);
        const mm = m[2];
        const ap = m[3] ? m[3].toUpperCase() : null;
        if (ap === "PM" && h !== 12) h += 12;
        if (ap === "AM" && h === 12) h = 0;
        return `${h}:${mm}`;
    }

    function extractStamp(b) {
        const ts = Number(b.dataset.timestamp || b.getAttribute("data-timestamp"));
        if (ts) { const d = new Date(ts * 1000); return { time: fmtTime(d), date: fmtDate(d), ts }; }
        const t = b.querySelector(".message-time");
        const raw = cleanText(t ? (t.innerText || t.textContent || "") : "");
        const time = parseTime12(raw);
        const date = findNearestDateSeparator(b) || fmtDate(new Date());
        return { time: time || "", date, ts: 0 };
    }

    function tryParse(b) {
        if (!isRealMessage(b)) return true;
        const id = b.getAttribute("data-message-id") || "";
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
        if (!data.has(key)) data.set(key, { sort: ts || (1e12 + data.size), date, line: `${importance}\t${text}\t${date}\t${time}\t${CHANNEL}\t${timing}\t${topic}` });
        return true;
    }

    function flush() {
        refreshDateCandidates();
        for (const b of pending) if (tryParse(b)) pending.delete(b);
        // ВАЖНО: ищем по всему документу, а не внутри scroller
        document.querySelectorAll(".Message[data-message-id]").forEach(tryParse);
        const c = document.getElementById("tg-export-count");
        if (c) c.innerText = String(data.size);
    }

    const observer = new MutationObserver(muts => {
        mutated = true;
        for (const m of muts) {
            for (const n of m.addedNodes) {
                if (n.nodeType !== 1) continue;
                if (n.classList?.contains("Message")) pending.add(n);
                n.querySelectorAll?.(".Message[data-message-id]").forEach(x => pending.add(x));
            }
            // виртуализация Web A может переиспользовать существующий DOM-узел под
            // новое сообщение (просто меняя data-message-id и содержимое) вместо
            // добавления нового узла — такое изменение childList/characterData не
            // ловит, поэтому отдельно следим за самим атрибутом data-message-id
            if (m.type === "attributes" && m.attributeName === "data-message-id" &&
                m.target.nodeType === 1 && m.target.classList?.contains("Message")) {
                pending.add(m.target);
            }
        }
    });
    observer.observe(document.body, {
        childList: true, subtree: true, characterData: true,
        attributes: true, attributeFilter: ["data-message-id"], attributeOldValue: true
    });

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
    panel.innerHTML = `<b>TG Export (Web A)</b><br>
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
    let dataStallSteps = 0;
    let stuckSteps = 0;
    let lastDataSize = data.size;

    for (let step = 1; step <= MAX_STEPS && !stopped; step++) {
        document.getElementById("tg-export-step").innerText = String(step);

        // у самого края уже подгруженного диапазона (там, где Web A должна досылать
        // следующую пачку истории) двигаемся заметно мельче — резкий прыжок через
        // эту зону, судя по диагностике, может проскочить момент, когда триггерится
        // подгрузка следующей пачки, и заодно вызывать внутренние ошибки Teact
        // (Cannot read properties of undefined (reading 'storyData') и т.п.) —
        // похоже, что именно от слишком агрессивного скролла
        const gapToEdge = DIRECTION === 1
            ? scroller.scrollHeight - (scroller.scrollTop + scroller.clientHeight)
            : scroller.scrollTop;
        const nearEdge = gapToEdge < scroller.clientHeight * 1.5;
        const ratio = nearEdge ? SCROLL_RATIO * 0.3 : SCROLL_RATIO;

        const before = scroller.scrollTop;
        const delta = Math.round(scroller.clientHeight * ratio) * DIRECTION;

        await smoothScroll(scroller, delta, flush);
        // wheel-событие — только как запасной способ, если scrollTop вообще не
        // сдвинулся; дублировать его на каждом шаге поверх ручного scrollTop
        // оказалось вредно (см. комментарий выше про ошибки Teact)
        if (Math.abs(scroller.scrollTop - before) < 1) {
            wheelScroll(scroller, delta);
            await sleep(80);

            // упёрлись в край (обычно scrollTop=0 у самого верха) — повторное
            // присваивание того же значения не создаёт нового "scroll"-события в
            // браузере, поэтому Web A не получает сигнала "мы всё ещё у края, нужно
            // подгружать дальше". Слегка отодвигаемся от края и возвращаемся —
            // это даёт настоящий переход значения scrollTop, похожий на "отскок"
            // при упоре в край во время ручной прокрутки.
            if (nearEdge && Math.abs(scroller.scrollTop - before) < 1) {
                const nudge = -DIRECTION * 60;
                scroller.scrollTop = before + nudge;
                await sleep(60);
                scroller.scrollTop = before;
                await sleep(250);
                flush();
            }
        }

        await waitRender();

        // позиция не двигается ВДАЛИ от края — это не "конец ленты", а признак, что
        // скролл чем-то заблокирован (например, снова включившимся scroll-snap).
        // Раньше такой случай приводил к молчаливому бесконечному циклу без единой
        // строчки в логе, поэтому сообщаем явно и прекращаем сбор.
        if (Math.abs(scroller.scrollTop - before) < 1) stuckSteps++; else stuckSteps = 0;
        if (stuckSteps >= SAME_LIMIT && !nearEdge) {
            console.warn(`[TG-A] Скролл заблокирован: позиция не меняется ${stuckSteps} шагов подряд ` +
                `вдали от края (scrollTop=${scroller.scrollTop.toFixed(0)}, ` +
                `scrollHeight=${scroller.scrollHeight}, clientHeight=${scroller.clientHeight}, ` +
                `snap=${getComputedStyle(scroller).scrollSnapType}, cls=${scroller.className}).`);
            break;
        }

        // временная диагностика именно для скролла вверх (см. вопрос про
        // .backwards-trigger — сенсор, по которому Web A подгружает более старые
        // сообщения) — логируем только у самого верха, чтобы не спамить
        if (DIRECTION === -1 && nearEdge) {
            const trigger = document.querySelector(".backwards-trigger");
            const tRect = trigger ? trigger.getBoundingClientRect() : null;
            const scRect = scroller.getBoundingClientRect();
            console.log(`[TG-A] up/nearEdge step ${step}: scrollTop=${scroller.scrollTop.toFixed(0)} ` +
                `scrollHeight=${scroller.scrollHeight} data=${data.size} ` +
                `trigger=${trigger ? "found" : "MISSING"} ` +
                (trigger ? `triggerTopRel=${Math.round(tRect.top - scRect.top)} triggerH=${Math.round(tRect.height)}` : ""));
        }

        // "конец ленты" проверяем ТОЛЬКО когда мы реально близко к краю — вдали от
        // края отсутствие новых сообщений это норма (мы ещё просто не доехали до
        // уже загруженного, но пока не смонтированного контента), а не признак
        // остановки подгрузки
        if (nearEdge) {
            if (data.size > lastDataSize) dataStallSteps = 0; else dataStallSteps++;
            lastDataSize = data.size;
            if (dataStallSteps >= SAME_LIMIT) {
                // даём ещё один долгий шанс — подгрузка следующей пачки истории с сервера
                // может занять больше одного цикла ожидания
                await sleep(1200);
                flush();
                if (data.size === lastDataSize) {
                    console.log("[TG-A] Конец ленты или подгрузка застряла.");
                    break;
                }
                dataStallSteps = 0;
                lastDataSize = data.size;
            }
        } else {
            dataStallSteps = 0;
            lastDataSize = data.size;
        }

        // докручиваем на один день дальше цели, чтобы гарантированно догрузить
        // ВСЕ сообщения самого целевого дня (иначе можно остановиться на середине
        // дня, пока часть его сообщений ещё не подгрузилась) — лишний день потом
        // отрезается фильтром при формировании итоговой таблицы
        if (DIRECTION === -1 && STOP_DATE && minSeenDate && minSeenDate < STOP_DATE) {
            console.log("[TG-A] Достигнута заданная дата остановки:", fmtDate(STOP_DATE));
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
    // возвращаем ленте её обычное "прилипание" к последнему сообщению
    snapKiller.remove();
    scroller.style.scrollSnapType = prevSnapType;

    if (!data.size) {
        alert("Собрано 0 сообщений.\nВыполните в консоли диагностику:\n" +
              "[...document.querySelectorAll('.Message[data-message-id]')].length");
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
    const rows = values.sort((a, b) => a.sort - b.sort).map(v => v.line);
    const result = "Надо брать\tТекст сообщения\tДата\tВремя\tКанал\tТайминг\tТема\n" + rows.join("\n");
    console.log(result);

    const secs = ((performance.now() - started) / 1000).toFixed(1);
    try {
        if (typeof GM_setClipboard === "function") {
            GM_setClipboard(result, "text");
        } else {
            await navigator.clipboard.writeText(result);
        }
        alert(`Готово за ${secs} c. Собрано: ${data.size}\nСкопировано в буфер обмена.`);
    } catch (e) {
        const a = document.createElement("textarea");
        a.value = result;
        a.style = `position:fixed;top:20px;left:20px;width:80vw;height:70vh;z-index:999999;
                   background:#fff;color:#000;font-size:14px;padding:10px;border:3px solid red;`;
        document.body.appendChild(a); a.focus(); a.select();
        alert(`Готово за ${secs} c. Собрано: ${data.size}\nНажмите Ctrl+C.`);
    }
    }

    if (typeof GM_registerMenuCommand === "function") {
        GM_registerMenuCommand("Собрать новости с канала", () => { runParser().catch(console.error); });
    } else {
        console.warn("[TG-A] GM_registerMenuCommand недоступен — запустите runParser() вручную из консоли.");
        window.runParser = runParser;
    }
})();
