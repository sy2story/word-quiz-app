// Google Sheets API v4 ラッパー。
// GAS の doGet / doPost が担っていた処理（行の正規化・該当行更新）を
// ブラウザ側で行う。アクセストークンは WQAuth から取得。

(function () {
  "use strict";

  const SHEET_NAME = "words";
  const READ_RANGE = SHEET_NAME + "!A1:O5000";

  // 列名 → 内部キー（GAS の COLUMN_MAP と同じ）
  const HEADER_TO_KEY = {
    "id": "id",
    "word": "word",
    "meaning_ja": "meaningJa",
    "phrase_en": "phraseEn",
    "phrase_ja": "phraseJa",
    "example_en": "exampleEn",
    "example_ja": "exampleJa",
    "section": "section",
    "enabled": "enabled",
    "correct_count": "correctCount",
    "wrong_count": "wrongCount",
    "last_result": "lastResult",
    "last_answered_at": "lastAnsweredAt",
    "is_weak": "isWeak",
    "consecutive_correct_count": "consecutiveCorrectCount"
  };

  // ----------------------------------------------------
  // ユーティリティ
  // ----------------------------------------------------
  function toNumber(v) {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }

  function toBoolean(v) {
    if (v === true) return true;
    if (v === false) return false;
    return String(v == null ? "" : v).toUpperCase() === "TRUE";
  }

  function isEnabled(rawEnabled) {
    if (rawEnabled === "" || rawEnabled == null) return true;
    if (rawEnabled === true) return true;
    return String(rawEnabled).toUpperCase() === "TRUE";
  }

  function colLetter(idx) {
    // 0→A, 1→B, ..., 25→Z, 26→AA
    let s = "";
    let n = idx + 1;
    while (n > 0) {
      const m = (n - 1) % 26;
      s = String.fromCharCode(65 + m) + s;
      n = Math.floor((n - 1) / 26);
    }
    return s;
  }

  // ----------------------------------------------------
  // 認証付き fetch（401 でサイレント再取得 → 1回だけリトライ）
  // ----------------------------------------------------
  async function authedFetch(url, options) {
    options = options || {};
    const token = await window.WQAuth.getAccessToken();
    let res = await doFetch(url, options, token);
    if (res.status === 401) {
      // トークン失効 → サイレント再取得して再試行
      const fresh = await window.WQAuth.getAccessToken();
      res = await doFetch(url, options, fresh);
    }
    return res;
  }

  function doFetch(url, options, token) {
    const headers = Object.assign({}, options.headers || {}, {
      Authorization: "Bearer " + token
    });
    return fetch(url, Object.assign({}, options, { headers: headers }));
  }

  // ----------------------------------------------------
  // 読み込み（GAS の doGet 相当）
  // ----------------------------------------------------
  async function loadWords(spreadsheetId) {
    if (!spreadsheetId) throw new Error("spreadsheetId is required.");

    const url = "https://sheets.googleapis.com/v4/spreadsheets/" +
      encodeURIComponent(spreadsheetId) +
      "/values/" + encodeURIComponent(READ_RANGE);

    const res = await authedFetch(url, { method: "GET" });
    if (!res.ok) {
      const errBody = await safeJson(res);
      const msg = (errBody && errBody.error && errBody.error.message) || ("HTTP " + res.status);
      const e = new Error(msg);
      if (res.status === 404) e.code = "SHEET_NOT_FOUND";
      else if (res.status === 403) e.code = "FORBIDDEN";
      else if (res.status === 400 && /Unable to parse range/i.test(msg)) e.code = "TAB_NOT_FOUND";
      else e.code = "FETCH_FAILED";
      e.status = res.status;
      throw e;
    }
    const json = await res.json();
    const values = json.values || [];
    if (values.length === 0) {
      const e = new Error("シートにデータが1行もありません。");
      e.code = "EMPTY_SHEET";
      throw e;
    }

    const headers = values[0].map(h => String(h).trim());
    const headerIndex = {};
    headers.forEach((h, i) => { headerIndex[h] = i; });

    const requiredHeaders = ["id", "word", "meaning_ja", "phrase_en", "phrase_ja"];
    const missing = requiredHeaders.filter(h => !(h in headerIndex));
    if (missing.length > 0) {
      const e = new Error("必要な列が見つかりません: " + missing.join(", "));
      e.code = "MISSING_COLUMNS";
      e.missing = missing;
      throw e;
    }

    const data = [];
    const rowIndexById = {};

    for (let r = 1; r < values.length; r++) {
      const row = values[r];
      const raw = {};
      headers.forEach((h, i) => { raw[h] = row[i]; });

      if (!isEnabled(raw.enabled)) continue;
      if (!raw.id || !raw.word || !raw.meaning_ja || !raw.phrase_en || !raw.phrase_ja) continue;

      const item = normalizeRow(raw);
      data.push(item);
      // シート上の行番号は 1始まり、ヘッダが1行目なので r+1
      rowIndexById[item.id] = r + 1;
    }

    return {
      data: data,
      headers: headers,
      headerIndex: headerIndex,
      rowIndexById: rowIndexById,
      updatedAt: new Date().toISOString()
    };
  }

  function normalizeRow(raw) {
    return {
      id: String(raw.id).trim(),
      word: String(raw.word).trim().toLowerCase(),
      meaningJa: String(raw.meaning_ja).trim(),
      phraseEn: String(raw.phrase_en).trim(),
      phraseJa: String(raw.phrase_ja).trim(),
      exampleEn: String(raw.example_en || "").trim(),
      exampleJa: String(raw.example_ja || "").trim(),
      section: raw.section ? String(raw.section).trim() : "",
      correctCount: toNumber(raw.correct_count),
      wrongCount: toNumber(raw.wrong_count),
      lastResult: String(raw.last_result || "").trim(),
      lastAnsweredAt: raw.last_answered_at
        ? (raw.last_answered_at instanceof Date
          ? raw.last_answered_at.toISOString()
          : String(raw.last_answered_at).trim())
        : "",
      isWeak: toBoolean(raw.is_weak),
      consecutiveCorrectCount: toNumber(raw.consecutive_correct_count)
    };
  }

  // ----------------------------------------------------
  // 書き込み（GAS の doPost 相当）
  // ----------------------------------------------------
  // word は state.words 内のオブジェクト（loadWords 後の正規化済み）。
  // ctx は { headerIndex, rowIndexById }。
  async function recordAnswer(spreadsheetId, word, result, ctx, answeredAt) {
    if (!spreadsheetId) throw new Error("spreadsheetId is required.");
    if (!ctx || !ctx.headerIndex || !ctx.rowIndexById) {
      throw new Error("context (headerIndex/rowIndexById) is required.");
    }

    const rowIdx = ctx.rowIndexById[word.id];
    if (!rowIdx) throw new Error("word not found in sheet: " + word.id);

    const isCorrect = result === "correct";
    const next = {
      correct_count: word.correctCount + (isCorrect ? 1 : 0),
      wrong_count:   word.wrongCount   + (isCorrect ? 0 : 1),
      last_result:   result,
      last_answered_at: answeredAt || new Date().toISOString(),
      is_weak:       !isCorrect,
      consecutive_correct_count: isCorrect ? word.consecutiveCorrectCount + 1 : 0
    };

    // ヘッダに存在する列だけ書き戻す（任意列は無視）
    const data = [];
    Object.keys(next).forEach(headerName => {
      const colIdx = ctx.headerIndex[headerName];
      if (colIdx == null || colIdx < 0) return;
      data.push({
        range: SHEET_NAME + "!" + colLetter(colIdx) + rowIdx,
        values: [[next[headerName]]]
      });
    });

    if (data.length === 0) return { next: next };

    const url = "https://sheets.googleapis.com/v4/spreadsheets/" +
      encodeURIComponent(spreadsheetId) + "/values:batchUpdate";

    const res = await authedFetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ valueInputOption: "RAW", data: data })
    });

    if (!res.ok) {
      const errBody = await safeJson(res);
      const msg = (errBody && errBody.error && errBody.error.message) || ("HTTP " + res.status);
      throw new Error(msg);
    }

    return { next: next };
  }

  async function safeJson(res) {
    try { return await res.json(); } catch (e) { return null; }
  }

  // ----------------------------------------------------
  // 生セル書き込み（オフラインキュー再送用）
  // cells: [{ range: "words!K5", value: <number|string|boolean> }]
  // ----------------------------------------------------
  async function writeCells(spreadsheetId, cells) {
    if (!spreadsheetId) throw new Error("spreadsheetId is required.");
    if (!Array.isArray(cells) || cells.length === 0) return;

    const data = cells.map(c => ({
      range: c.range,
      values: [[c.value]]
    }));

    const url = "https://sheets.googleapis.com/v4/spreadsheets/" +
      encodeURIComponent(spreadsheetId) + "/values:batchUpdate";

    const res = await authedFetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ valueInputOption: "RAW", data: data })
    });

    if (!res.ok) {
      const errBody = await safeJson(res);
      const msg = (errBody && errBody.error && errBody.error.message) || ("HTTP " + res.status);
      throw new Error(msg);
    }
  }

  // recordAnswer の書き込み内容を「再送可能な cells 配列」に変換するヘルパー。
  // app.js はこれを使ってオフラインキューを構築する。
  function buildAnswerCells(word, result, ctx, answeredAt) {
    const rowIdx = ctx.rowIndexById[word.id];
    if (!rowIdx) throw new Error("word not found in sheet: " + word.id);

    const isCorrect = result === "correct";
    const next = {
      correct_count: word.correctCount + (isCorrect ? 1 : 0),
      wrong_count:   word.wrongCount   + (isCorrect ? 0 : 1),
      last_result:   result,
      last_answered_at: answeredAt || new Date().toISOString(),
      is_weak:       !isCorrect,
      consecutive_correct_count: isCorrect ? word.consecutiveCorrectCount + 1 : 0
    };

    const cells = [];
    Object.keys(next).forEach(headerName => {
      const colIdx = ctx.headerIndex[headerName];
      if (colIdx == null || colIdx < 0) return;
      cells.push({
        range: SHEET_NAME + "!" + colLetter(colIdx) + rowIdx,
        value: next[headerName]
      });
    });

    return { cells: cells, next: next };
  }

  // ----------------------------------------------------
  // 新規語の追加 (AI 抽出機能用)
  // ----------------------------------------------------
  // items: [{ word, meaning_ja, phrase_en, phrase_ja, example_en?, example_ja? }]
  // ctx:   loadWords が返した { headers, headerIndex, rowIndexById }
  // 戻り値: { appendedIds: ["053","054",...] }
  async function appendWords(spreadsheetId, items, ctx) {
    if (!spreadsheetId) throw new Error("spreadsheetId is required.");
    if (!Array.isArray(items) || items.length === 0) return { appendedIds: [] };
    if (!ctx || !ctx.headers || !ctx.headerIndex) throw new Error("ctx is required.");

    // 次の ID = 既存 ID 中の数値最大 + 1。形式は 3 桁ゼロ埋め文字列。
    let maxId = 0;
    Object.keys(ctx.rowIndexById || {}).forEach(function (idStr) {
      const n = parseInt(String(idStr), 10);
      if (Number.isFinite(n) && n > maxId) maxId = n;
    });

    function pad3(n) {
      const s = String(n);
      return s.length >= 3 ? s : "000".slice(s.length) + s;
    }

    const headers = ctx.headers;
    const idx = ctx.headerIndex;
    const appendedIds = [];

    const rows = items.map(function (it, i) {
      const nextId = pad3(maxId + 1 + i);
      appendedIds.push(nextId);
      const row = new Array(headers.length).fill("");
      function put(headerName, value) {
        const c = idx[headerName];
        if (c != null && c >= 0) row[c] = value;
      }
      put("id", nextId);
      put("word", String(it.word || "").trim().toLowerCase());
      put("meaning_ja", String(it.meaning_ja || "").trim());
      put("phrase_en",  String(it.phrase_en  || "").trim());
      put("phrase_ja",  String(it.phrase_ja  || "").trim());
      put("example_en", String(it.example_en || "").trim());
      put("example_ja", String(it.example_ja || "").trim());
      put("section", "");
      put("enabled", true);
      put("correct_count", 0);
      put("wrong_count", 0);
      put("last_result", "");
      put("last_answered_at", "");
      put("is_weak", false);
      put("consecutive_correct_count", 0);
      return row;
    });

    const url = "https://sheets.googleapis.com/v4/spreadsheets/" +
      encodeURIComponent(spreadsheetId) +
      "/values/" + encodeURIComponent(SHEET_NAME + "!A:A") +
      ":append?valueInputOption=RAW&insertDataOption=INSERT_ROWS";

    const res = await authedFetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ values: rows })
    });

    if (!res.ok) {
      const errBody = await safeJson(res);
      const msg = (errBody && errBody.error && errBody.error.message) || ("HTTP " + res.status);
      throw new Error(msg);
    }
    return { appendedIds: appendedIds };
  }

  // ----------------------------------------------------
  // words シートの存在保証 + ヘッダ書き込み
  // ----------------------------------------------------
  // - words タブが無ければ addSheet で作成
  // - A1 が空ならヘッダ 15 列を書き込み
  // - 既にヘッダがある場合は何もしない（既存データは触らない）
  // 戻り値: { created: bool, headerWritten: bool }
  async function ensureWordsSheet(spreadsheetId) {
    if (!spreadsheetId) throw new Error("spreadsheetId is required.");

    const WORDS_HEADERS = [
      "id", "word", "meaning_ja", "phrase_en", "phrase_ja",
      "example_en", "example_ja", "section", "enabled",
      "correct_count", "wrong_count", "last_result", "last_answered_at",
      "is_weak", "consecutive_correct_count"
    ];

    // 1) シート一覧を取得
    const metaUrl = "https://sheets.googleapis.com/v4/spreadsheets/" +
      encodeURIComponent(spreadsheetId) +
      "?fields=" + encodeURIComponent("sheets.properties(title,sheetId)");

    const metaRes = await authedFetch(metaUrl, { method: "GET" });
    if (!metaRes.ok) {
      const errBody = await safeJson(metaRes);
      throw new Error((errBody && errBody.error && errBody.error.message) || ("HTTP " + metaRes.status));
    }
    const meta = await metaRes.json();
    const sheets = (meta && meta.sheets) || [];
    const hasWords = sheets.some(function (s) {
      return s && s.properties && s.properties.title === SHEET_NAME;
    });

    let created = false;
    if (!hasWords) {
      const batchUrl = "https://sheets.googleapis.com/v4/spreadsheets/" +
        encodeURIComponent(spreadsheetId) + ":batchUpdate";
      const addRes = await authedFetch(batchUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          requests: [{ addSheet: { properties: { title: SHEET_NAME } } }]
        })
      });
      if (!addRes.ok) {
        const errBody = await safeJson(addRes);
        throw new Error((errBody && errBody.error && errBody.error.message) || ("HTTP " + addRes.status));
      }
      created = true;
    }

    // 2) ヘッダの有無を確認（既存データを上書きしないため）
    let headerEmpty = created;  // 新規作成時は当然空
    if (!created) {
      const checkUrl = "https://sheets.googleapis.com/v4/spreadsheets/" +
        encodeURIComponent(spreadsheetId) +
        "/values/" + encodeURIComponent(SHEET_NAME + "!A1:O1");
      const checkRes = await authedFetch(checkUrl, { method: "GET" });
      if (!checkRes.ok) {
        const errBody = await safeJson(checkRes);
        throw new Error((errBody && errBody.error && errBody.error.message) || ("HTTP " + checkRes.status));
      }
      const checkJson = await checkRes.json();
      const vals = checkJson.values || [];
      // 1行目が無い or 1行目が完全に空ならヘッダ書き込み対象
      headerEmpty = vals.length === 0 ||
        !vals[0].some(function (c) { return String(c == null ? "" : c).trim() !== ""; });
    }

    let headerWritten = false;
    if (headerEmpty) {
      const headerUrl = "https://sheets.googleapis.com/v4/spreadsheets/" +
        encodeURIComponent(spreadsheetId) +
        "/values/" + encodeURIComponent(SHEET_NAME + "!A1:O1") +
        "?valueInputOption=RAW";
      const headerRes = await authedFetch(headerUrl, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ values: [WORDS_HEADERS] })
      });
      if (!headerRes.ok) {
        const errBody = await safeJson(headerRes);
        throw new Error((errBody && errBody.error && errBody.error.message) || ("HTTP " + headerRes.status));
      }
      headerWritten = true;
    }

    return { created: created, headerWritten: headerWritten };
  }

  // ----------------------------------------------------
  // diary シートの存在保証 + 既存内容のサマリ
  // ----------------------------------------------------
  // 戻り値: { headerIndex: {id, date, script_ja, script_en}, maxId: number, created: bool }
  async function ensureDiarySheet(spreadsheetId) {
    if (!spreadsheetId) throw new Error("spreadsheetId is required.");

    // 1) シート一覧を取得
    const metaUrl = "https://sheets.googleapis.com/v4/spreadsheets/" +
      encodeURIComponent(spreadsheetId) +
      "?fields=" + encodeURIComponent("sheets.properties(title,sheetId)");

    const metaRes = await authedFetch(metaUrl, { method: "GET" });
    if (!metaRes.ok) {
      const errBody = await safeJson(metaRes);
      throw new Error((errBody && errBody.error && errBody.error.message) || ("HTTP " + metaRes.status));
    }
    const meta = await metaRes.json();
    const sheets = (meta && meta.sheets) || [];
    const hasDiary = sheets.some(function (s) {
      return s && s.properties && s.properties.title === "diary";
    });

    let created = false;
    if (!hasDiary) {
      // 2a) 無ければ作成 + ヘッダ行を書き込む
      const batchUrl = "https://sheets.googleapis.com/v4/spreadsheets/" +
        encodeURIComponent(spreadsheetId) + ":batchUpdate";
      const addRes = await authedFetch(batchUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          requests: [{ addSheet: { properties: { title: "diary" } } }]
        })
      });
      if (!addRes.ok) {
        const errBody = await safeJson(addRes);
        throw new Error((errBody && errBody.error && errBody.error.message) || ("HTTP " + addRes.status));
      }

      const headerUrl = "https://sheets.googleapis.com/v4/spreadsheets/" +
        encodeURIComponent(spreadsheetId) +
        "/values/" + encodeURIComponent("diary!A1:D1") +
        "?valueInputOption=RAW";
      const headerRes = await authedFetch(headerUrl, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ values: [["id", "date", "script_ja", "script_en"]] })
      });
      if (!headerRes.ok) {
        const errBody = await safeJson(headerRes);
        throw new Error((errBody && errBody.error && errBody.error.message) || ("HTTP " + headerRes.status));
      }
      created = true;
    }

    // 3) ヘッダと既存 ID を読む (max を計算)
    const readUrl = "https://sheets.googleapis.com/v4/spreadsheets/" +
      encodeURIComponent(spreadsheetId) +
      "/values/" + encodeURIComponent("diary!A1:D");
    const readRes = await authedFetch(readUrl, { method: "GET" });
    if (!readRes.ok) {
      const errBody = await safeJson(readRes);
      throw new Error((errBody && errBody.error && errBody.error.message) || ("HTTP " + readRes.status));
    }
    const readJson = await readRes.json();
    const values = readJson.values || [];

    let headerIndex = { id: -1, date: -1, script_ja: -1, script_en: -1 };
    if (values.length > 0) {
      const headers = values[0].map(function (h) { return String(h).trim(); });
      headers.forEach(function (h, i) {
        if (h in headerIndex) headerIndex[h] = i;
      });
    }
    // 既存ヘッダが揃っていなければ補正 (新規作成直後は問題なし)
    if (headerIndex.id < 0) headerIndex = { id: 0, date: 1, script_ja: 2, script_en: 3 };

    let maxId = 0;
    for (let r = 1; r < values.length; r++) {
      const v = values[r][headerIndex.id];
      const n = parseInt(String(v || "").trim(), 10);
      if (Number.isFinite(n) && n > maxId) maxId = n;
    }

    return { headerIndex: headerIndex, maxId: maxId, created: created };
  }

  // ----------------------------------------------------
  // diary に 1 行追加
  // ----------------------------------------------------
  async function appendDiary(spreadsheetId, diaryCtx, entry) {
    if (!spreadsheetId) throw new Error("spreadsheetId is required.");
    if (!diaryCtx || !diaryCtx.headerIndex) throw new Error("diaryCtx is required.");

    function pad3(n) {
      const s = String(n);
      return s.length >= 3 ? s : "000".slice(s.length) + s;
    }
    const nextId = pad3((diaryCtx.maxId || 0) + 1);

    // タイムゾーンの曖昧さを避けるため、ローカル日付を YYYY-MM-DD で生成
    const d = new Date();
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    const date = yyyy + "-" + mm + "-" + dd;

    const row = ["", "", "", ""];
    row[diaryCtx.headerIndex.id]        = nextId;
    row[diaryCtx.headerIndex.date]      = date;
    row[diaryCtx.headerIndex.script_ja] = String((entry && entry.script_ja) || "");
    row[diaryCtx.headerIndex.script_en] = String((entry && entry.script_en) || "");

    const url = "https://sheets.googleapis.com/v4/spreadsheets/" +
      encodeURIComponent(spreadsheetId) +
      "/values/" + encodeURIComponent("diary!A:A") +
      ":append?valueInputOption=RAW&insertDataOption=INSERT_ROWS";

    const res = await authedFetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ values: [row] })
    });
    if (!res.ok) {
      const errBody = await safeJson(res);
      throw new Error((errBody && errBody.error && errBody.error.message) || ("HTTP " + res.status));
    }
    return { id: nextId, date: date };
  }

  // ----------------------------------------------------
  // 公開 API
  // ----------------------------------------------------
  window.WQSheets = {
    loadWords: loadWords,
    recordAnswer: recordAnswer,
    writeCells: writeCells,
    buildAnswerCells: buildAnswerCells,
    appendWords: appendWords,
    ensureWordsSheet: ensureWordsSheet,
    ensureDiarySheet: ensureDiarySheet,
    appendDiary: appendDiary
  };
})();
