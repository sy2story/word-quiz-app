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
  // 公開 API
  // ----------------------------------------------------
  window.WQSheets = {
    loadWords: loadWords,
    recordAnswer: recordAnswer,
    writeCells: writeCells,
    buildAnswerCells: buildAnswerCells
  };
})();
