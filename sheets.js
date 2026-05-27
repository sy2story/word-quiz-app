// Google Sheets API v4 ラッパー。
// GAS の doGet / doPost が担っていた処理（行の正規化・該当行更新）を
// ブラウザ側で行う。アクセストークンは WQAuth から取得。

(function () {
  "use strict";

  const SHEET_NAME = "words";
  const READ_RANGE = SHEET_NAME + "!A1:S5000";

  // ランダムクイズ（間隔反復）の出題間隔。
  // 出題後の randam_quiz_count の値 → 最終解答日時に加算する日数。
  const RANDOM_QUIZ_INTERVAL_DAYS = { 1: 4, 2: 7, 3: 16, 4: 39, 5: 51, 6: 60 };
  // この回数に達したら出題を打ち切る（is_finished=true）。
  const RANDOM_QUIZ_FINISH_COUNT = 7;

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
    "consecutive_correct_count": "consecutiveCorrectCount",
    "randam_quiz_last_answered_at": "randamQuizLastAnsweredAt",
    "randam_quiz_count": "randamQuizCount",
    "randam_quiz_next_date_at": "randamQuizNextDateAt",
    "randam_quiz_is_finished": "randamQuizIsFinished"
  };

  // ----------------------------------------------------
  // ユーティリティ
  // ----------------------------------------------------
  function toNumber(v) {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }

  // id は数値で統一。既存の "001" のようなゼロ埋め文字列も parseInt で 1 に正規化する。
  function toIntId(v) {
    const n = parseInt(String(v == null ? "" : v).trim(), 10);
    return Number.isFinite(n) ? n : NaN;
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

  // fetch 自体がネットワークレベルで reject するケース（Safari の
  // "Load failed" / Chrome の "Failed to fetch"。ダウンロード発火直後の
  // リクエストキャンセル等）に対し、300ms 待って 1 回だけ再試行する。
  async function doFetch(url, options, token) {
    const headers = Object.assign({}, options.headers || {}, {
      Authorization: "Bearer " + token
    });
    const req = Object.assign({}, options, { headers: headers });
    try {
      return await fetch(url, req);
    } catch (err) {
      if (!(err instanceof TypeError)) throw err;
      await new Promise(function (r) { setTimeout(r, 300); });
      return await fetch(url, req);
    }
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
      if (!Number.isFinite(item.id)) continue;
      data.push(item);
      // シート上の行番号は 1始まり、ヘッダが1行目なので r+1
      // item.id は number。Object キーは内部で文字列化されるので、後段の rowIndexById[word.id] アクセスでも一致する
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
      id: toIntId(raw.id),
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
      consecutiveCorrectCount: toNumber(raw.consecutive_correct_count),
      randamQuizLastAnsweredAt: normalizeDateStr(raw.randam_quiz_last_answered_at),
      randamQuizCount: toNumber(raw.randam_quiz_count),
      randamQuizNextDateAt: normalizeDateStr(raw.randam_quiz_next_date_at),
      randamQuizIsFinished: toBoolean(raw.randam_quiz_is_finished)
    };
  }

  // Date / ISO 文字列 / 空 を ISO 文字列（または ""）に正規化する。
  function normalizeDateStr(v) {
    if (!v) return "";
    if (v instanceof Date) return v.toISOString();
    return String(v).trim();
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
  // ランダムクイズ回答の書き込みセル組み立て
  // ----------------------------------------------------
  // 既存統計列（buildAnswerCells と同じ）に加え、間隔反復用の randam_quiz_* 列も更新する。
  // 出題回数は正解・不正解に関わらず +1 し、出題後カウントに応じて次回出題日時を決める。
  // 戻り値: { cells, next, randamNext }（randamNext はローカル word 同期用）
  function buildRandomQuizCells(word, result, ctx, answeredAt) {
    const built = buildAnswerCells(word, result, ctx, answeredAt);
    const now = built.next.last_answered_at; // ISO 文字列（buildAnswerCells が確定済み）
    const newCount = toNumber(word.randamQuizCount) + 1;
    const finished = newCount >= RANDOM_QUIZ_FINISH_COUNT;

    const randamNext = {
      randam_quiz_last_answered_at: now,
      randam_quiz_count: newCount,
      randam_quiz_is_finished: finished
    };
    // 打ち切り時は次回出題日時を更新しない（既存値を保持）。
    if (!finished) {
      const days = RANDOM_QUIZ_INTERVAL_DAYS[newCount] || 0;
      randamNext.randam_quiz_next_date_at = addDaysIso(now, days);
    }

    Object.keys(randamNext).forEach(headerName => {
      const colIdx = ctx.headerIndex[headerName];
      if (colIdx == null || colIdx < 0) return;
      built.cells.push({
        range: SHEET_NAME + "!" + colLetter(colIdx) + ctx.rowIndexById[word.id],
        value: randamNext[headerName]
      });
    });

    return { cells: built.cells, next: built.next, randamNext: randamNext };
  }

  function addDaysIso(iso, days) {
    const base = iso ? new Date(iso) : new Date();
    const t = base.getTime();
    return new Date((Number.isFinite(t) ? t : Date.now()) + days * 86400000).toISOString();
  }

  // 単語の「今後出題しない」フラグだけを書き込むセルを組み立てる。
  function buildExcludeFromRandomQuizCells(word, ctx) {
    const rowIdx = ctx.rowIndexById[word.id];
    if (!rowIdx) throw new Error("word not found in sheet: " + word.id);
    const colIdx = ctx.headerIndex["randam_quiz_is_finished"];
    if (colIdx == null || colIdx < 0) return { cells: [] };
    return {
      cells: [{
        range: SHEET_NAME + "!" + colLetter(colIdx) + rowIdx,
        value: true
      }]
    };
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

    // 次の ID = 既存 ID 中の数値最大 + 1。number で採番・書き込み。
    let maxId = 0;
    Object.keys(ctx.rowIndexById || {}).forEach(function (idStr) {
      const n = parseInt(String(idStr), 10);
      if (Number.isFinite(n) && n > maxId) maxId = n;
    });

    const headers = ctx.headers;
    const idx = ctx.headerIndex;
    const appendedIds = [];

    const rows = items.map(function (it, i) {
      const nextId = maxId + 1 + i;
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
      // ランダムクイズ: 登録日時を次回出題日時の初期値に設定（wrong_count>=1 になり次第すぐ対象になる）
      put("randam_quiz_last_answered_at", "");
      put("randam_quiz_count", 0);
      put("randam_quiz_next_date_at", new Date().toISOString());
      put("randam_quiz_is_finished", false);
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
      "is_weak", "consecutive_correct_count",
      "randam_quiz_last_answered_at", "randam_quiz_count",
      "randam_quiz_next_date_at", "randam_quiz_is_finished"
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
        "/values/" + encodeURIComponent(SHEET_NAME + "!A1:S1");
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
        "/values/" + encodeURIComponent(SHEET_NAME + "!A1:S1") +
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
  // 新規スプレッドシート作成
  // ----------------------------------------------------
  // - Sheets API で新しいスプレッドシートを作成し、最初のタブを "words" にする
  // - 続けて ensureWordsSheet を呼び、ヘッダ 19 列を書き込む
  // - drive.file スコープでもアプリ作成ファイルはアクセス可
  // 戻り値: { id, name, url }
  async function createSpreadsheet(name) {
    const title = String(name || "").trim() || "英単語クイズ";
    const url = "https://sheets.googleapis.com/v4/spreadsheets";
    const res = await authedFetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        properties: { title: title },
        sheets: [{ properties: { title: SHEET_NAME } }]
      })
    });
    if (!res.ok) {
      const errBody = await safeJson(res);
      throw new Error((errBody && errBody.error && errBody.error.message) || ("HTTP " + res.status));
    }
    const meta = await res.json();
    const id = meta.spreadsheetId;
    const sheetUrl = meta.spreadsheetUrl ||
      ("https://docs.google.com/spreadsheets/d/" + encodeURIComponent(id) + "/edit");
    const resolvedName = (meta.properties && meta.properties.title) || title;

    // ヘッダを書き込む (words タブは作成済みなので addSheet はスキップされる)
    await ensureWordsSheet(id);

    return { id: id, name: resolvedName, url: sheetUrl };
  }

  // ----------------------------------------------------
  // diary シートの存在保証 + 既存内容のサマリ
  // ----------------------------------------------------
  // 戻り値: { headerIndex: {id, date, title, script_ja, script_en, explanation}, maxId: number, created: bool }
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
        "/values/" + encodeURIComponent("diary!A1:G1") +
        "?valueInputOption=RAW";
      const headerRes = await authedFetch(headerUrl, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ values: [["id", "date", "title", "script_ja", "script_en", "explanation", "audio_downloaded_at"]] })
      });
      if (!headerRes.ok) {
        const errBody = await safeJson(headerRes);
        throw new Error((errBody && errBody.error && errBody.error.message) || ("HTTP " + headerRes.status));
      }
      created = true;
    }

    // 3) ヘッダと既存 ID を読む (max を計算)
    //    title / audio_downloaded_at は末尾列に来ることがあるので広めに読む
    const readUrl = "https://sheets.googleapis.com/v4/spreadsheets/" +
      encodeURIComponent(spreadsheetId) +
      "/values/" + encodeURIComponent("diary!A1:Z");
    const readRes = await authedFetch(readUrl, { method: "GET" });
    if (!readRes.ok) {
      const errBody = await safeJson(readRes);
      throw new Error((errBody && errBody.error && errBody.error.message) || ("HTTP " + readRes.status));
    }
    const readJson = await readRes.json();
    const values = readJson.values || [];

    let headerIndex = { id: -1, date: -1, title: -1, script_ja: -1, script_en: -1, explanation: -1, audio_downloaded_at: -1 };
    if (values.length > 0) {
      const headers = values[0].map(function (h) { return String(h).trim(); });
      headers.forEach(function (h, i) {
        if (h in headerIndex) headerIndex[h] = i;
      });
    }
    // 既存ヘッダが揃っていなければ補正 (新規作成直後は問題なし)
    if (headerIndex.id < 0) headerIndex = { id: 0, date: 1, title: 2, script_ja: 3, script_en: 4, explanation: 5, audio_downloaded_at: 6 };

    // 旧シートに無い任意列 (title / explanation / audio_downloaded_at) を末尾へ順に追加する。
    // 新列位置は「既知キーの max」ではなく実ヘッダ行の幅を起点にする。
    // 既知キーだけで判断すると、末尾にある未知列 (旧 audio_downloaded_at 等) を
    // 上書きしてしまうため。追加成功ごとに幅を +1 する。
    let headerWidth = (values[0] ? values[0].length : 0);
    const optionalCols = ["title", "explanation", "audio_downloaded_at"];
    for (let ci = 0; ci < optionalCols.length; ci++) {
      const key = optionalCols[ci];
      if (headerIndex[key] >= 0) continue;
      const newCol = headerWidth;
      const colHeaderUrl = "https://sheets.googleapis.com/v4/spreadsheets/" +
        encodeURIComponent(spreadsheetId) +
        "/values/" + encodeURIComponent("diary!" + colLetter(newCol) + "1") +
        "?valueInputOption=RAW";
      const colRes = await authedFetch(colHeaderUrl, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ values: [[key]] })
      });
      if (!colRes.ok) {
        const errBody = await safeJson(colRes);
        throw new Error((errBody && errBody.error && errBody.error.message) || ("HTTP " + colRes.status));
      }
      headerIndex[key] = newCol;
      headerWidth = newCol + 1;
    }

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

    const nextId = (diaryCtx.maxId || 0) + 1;

    // タイムゾーンの曖昧さを避けるため、ローカル日付を YYYY-MM-DD で生成
    const d = new Date();
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    const date = yyyy + "-" + mm + "-" + dd;

    const hi = diaryCtx.headerIndex;
    // 使用するヘッダの最大列に合わせて行配列を確保 (title 列が末尾にあるケースに対応)
    const maxCol = Math.max(
      hi.id, hi.date, hi.script_ja, hi.script_en,
      (hi.title != null ? hi.title : -1),
      (hi.explanation != null ? hi.explanation : -1)
    );
    const row = new Array(maxCol + 1).fill("");
    row[hi.id]        = nextId;
    row[hi.date]      = date;
    row[hi.script_ja] = String((entry && entry.script_ja) || "");
    row[hi.script_en] = String((entry && entry.script_en) || "");
    if (hi.title != null && hi.title >= 0) {
      row[hi.title]   = String((entry && entry.title) || "");
    }
    if (hi.explanation != null && hi.explanation >= 0) {
      row[hi.explanation] = String((entry && entry.explanation) || "");
    }

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
  // sentence シートの存在保証 + 既存内容のサマリ
  // ----------------------------------------------------
  // 戻り値: { headerIndex: {id, diary_id, sentence_ja, sentence_en, last_practiced_at}, maxId: number, created: bool }
  const SENTENCE_HEADERS = ["id", "diary_id", "sentence_ja", "sentence_en", "last_practiced_at"];

  async function ensureSentenceSheet(spreadsheetId) {
    if (!spreadsheetId) throw new Error("spreadsheetId is required.");

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
    const hasSentence = sheets.some(function (s) {
      return s && s.properties && s.properties.title === "sentence";
    });

    let created = false;
    if (!hasSentence) {
      const batchUrl = "https://sheets.googleapis.com/v4/spreadsheets/" +
        encodeURIComponent(spreadsheetId) + ":batchUpdate";
      const addRes = await authedFetch(batchUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          requests: [{ addSheet: { properties: { title: "sentence" } } }]
        })
      });
      if (!addRes.ok) {
        const errBody = await safeJson(addRes);
        throw new Error((errBody && errBody.error && errBody.error.message) || ("HTTP " + addRes.status));
      }

      const headerUrl = "https://sheets.googleapis.com/v4/spreadsheets/" +
        encodeURIComponent(spreadsheetId) +
        "/values/" + encodeURIComponent("sentence!A1:E1") +
        "?valueInputOption=RAW";
      const headerRes = await authedFetch(headerUrl, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ values: [SENTENCE_HEADERS] })
      });
      if (!headerRes.ok) {
        const errBody = await safeJson(headerRes);
        throw new Error((errBody && errBody.error && errBody.error.message) || ("HTTP " + headerRes.status));
      }
      created = true;
    }

    const readUrl = "https://sheets.googleapis.com/v4/spreadsheets/" +
      encodeURIComponent(spreadsheetId) +
      "/values/" + encodeURIComponent("sentence!A1:E");
    const readRes = await authedFetch(readUrl, { method: "GET" });
    if (!readRes.ok) {
      const errBody = await safeJson(readRes);
      throw new Error((errBody && errBody.error && errBody.error.message) || ("HTTP " + readRes.status));
    }
    const readJson = await readRes.json();
    const values = readJson.values || [];

    let headerIndex = { id: -1, diary_id: -1, sentence_ja: -1, sentence_en: -1, last_practiced_at: -1 };
    if (values.length > 0) {
      const headers = values[0].map(function (h) { return String(h).trim(); });
      headers.forEach(function (h, i) {
        if (h in headerIndex) headerIndex[h] = i;
      });
    }
    if (headerIndex.id < 0) {
      headerIndex = { id: 0, diary_id: 1, sentence_ja: 2, sentence_en: 3, last_practiced_at: 4 };
    }

    let maxId = 0;
    for (let r = 1; r < values.length; r++) {
      const n = toIntId(values[r][headerIndex.id]);
      if (Number.isFinite(n) && n > maxId) maxId = n;
    }

    return { headerIndex: headerIndex, maxId: maxId, created: created };
  }

  // ----------------------------------------------------
  // sentence シートへ複数行を一括追加
  // ----------------------------------------------------
  // items: [{sentence_ja, sentence_en}, ...]
  // 戻り値: { appendedIds: number[] }
  async function appendSentences(spreadsheetId, ctx, diaryId, items) {
    if (!spreadsheetId) throw new Error("spreadsheetId is required.");
    if (!ctx || !ctx.headerIndex) throw new Error("sentenceCtx is required.");
    if (!Array.isArray(items) || items.length === 0) return { appendedIds: [] };
    const did = toIntId(diaryId);
    if (!Number.isFinite(did)) throw new Error("invalid diaryId: " + diaryId);

    const idx = ctx.headerIndex;
    const baseId = ctx.maxId || 0;
    const appendedIds = [];

    const rows = items.map(function (it, i) {
      const nextId = baseId + 1 + i;
      appendedIds.push(nextId);
      const row = new Array(5).fill("");
      row[idx.id]                = nextId;
      row[idx.diary_id]          = did;
      row[idx.sentence_ja]       = String((it && it.sentence_ja) || "").trim();
      row[idx.sentence_en]       = String((it && it.sentence_en) || "").trim();
      row[idx.last_practiced_at] = "";
      return row;
    });

    const url = "https://sheets.googleapis.com/v4/spreadsheets/" +
      encodeURIComponent(spreadsheetId) +
      "/values/" + encodeURIComponent("sentence!A:A") +
      ":append?valueInputOption=RAW&insertDataOption=INSERT_ROWS";

    const res = await authedFetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ values: rows })
    });
    if (!res.ok) {
      const errBody = await safeJson(res);
      throw new Error((errBody && errBody.error && errBody.error.message) || ("HTTP " + res.status));
    }
    return { appendedIds: appendedIds };
  }

  // ----------------------------------------------------
  // sentence シート全件読み込み
  // ----------------------------------------------------
  // 戻り値: { rows: [{id, diaryId, sentenceJa, sentenceEn, lastPracticedAt}], headerIndex, rowIndexById, maxId, exists }
  // シート/タブが無い場合は { rows: [], exists: false } を返す（呼び出し側で ensureSentenceSheet 起動の判断）
  async function loadSentences(spreadsheetId) {
    if (!spreadsheetId) throw new Error("spreadsheetId is required.");

    const url = "https://sheets.googleapis.com/v4/spreadsheets/" +
      encodeURIComponent(spreadsheetId) +
      "/values/" + encodeURIComponent("sentence!A1:E5000");

    const res = await authedFetch(url, { method: "GET" });
    if (!res.ok) {
      if (res.status === 400) {
        // タブが存在しない (Unable to parse range)
        return { rows: [], headerIndex: null, rowIndexById: {}, maxId: 0, exists: false };
      }
      const errBody = await safeJson(res);
      throw new Error((errBody && errBody.error && errBody.error.message) || ("HTTP " + res.status));
    }
    const json = await res.json();
    const values = json.values || [];
    if (values.length === 0) {
      return { rows: [], headerIndex: null, rowIndexById: {}, maxId: 0, exists: true };
    }

    const headers = values[0].map(function (h) { return String(h).trim(); });
    const headerIndex = { id: -1, diary_id: -1, sentence_ja: -1, sentence_en: -1, last_practiced_at: -1 };
    headers.forEach(function (h, i) { if (h in headerIndex) headerIndex[h] = i; });
    const required = ["id", "diary_id", "sentence_ja", "sentence_en"];
    const missing = required.filter(function (h) { return headerIndex[h] < 0; });
    if (missing.length > 0) {
      const e = new Error("sentence シートに必要な列がありません: " + missing.join(", "));
      e.code = "MISSING_COLUMNS";
      throw e;
    }

    const rows = [];
    const rowIndexById = {};
    let maxId = 0;
    for (let r = 1; r < values.length; r++) {
      const row = values[r];
      const id = toIntId(row[headerIndex.id]);
      const diaryId = toIntId(row[headerIndex.diary_id]);
      if (!Number.isFinite(id) || !Number.isFinite(diaryId)) continue;
      const sentenceJa = String(row[headerIndex.sentence_ja] || "").trim();
      const sentenceEn = String(row[headerIndex.sentence_en] || "").trim();
      if (!sentenceJa || !sentenceEn) continue;
      const lastPracticedAt = headerIndex.last_practiced_at >= 0
        ? String(row[headerIndex.last_practiced_at] || "").trim()
        : "";
      rows.push({
        id: id,
        diaryId: diaryId,
        sentenceJa: sentenceJa,
        sentenceEn: sentenceEn,
        lastPracticedAt: lastPracticedAt
      });
      rowIndexById[id] = r + 1;
      if (id > maxId) maxId = id;
    }

    return { rows: rows, headerIndex: headerIndex, rowIndexById: rowIndexById, maxId: maxId, exists: true };
  }

  // ----------------------------------------------------
  // sentence の last_practiced_at セル 1 箇所だけ更新
  // ----------------------------------------------------
  async function recordSentencePracticed(spreadsheetId, ctx, sentenceId, practicedAt) {
    if (!spreadsheetId) throw new Error("spreadsheetId is required.");
    if (!ctx || !ctx.headerIndex || !ctx.rowIndexById) {
      throw new Error("sentence context is required.");
    }
    const rowIdx = ctx.rowIndexById[sentenceId];
    if (!rowIdx) throw new Error("sentence not found: " + sentenceId);
    const colIdx = ctx.headerIndex.last_practiced_at;
    if (colIdx == null || colIdx < 0) throw new Error("last_practiced_at column missing");

    const url = "https://sheets.googleapis.com/v4/spreadsheets/" +
      encodeURIComponent(spreadsheetId) +
      "/values/" + encodeURIComponent("sentence!" + colLetter(colIdx) + rowIdx) +
      "?valueInputOption=RAW";
    const res = await authedFetch(url, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ values: [[practicedAt || new Date().toISOString()]] })
    });
    if (!res.ok) {
      const errBody = await safeJson(res);
      throw new Error((errBody && errBody.error && errBody.error.message) || ("HTTP " + res.status));
    }
  }

  // ----------------------------------------------------
  // diary シート全件読み込み（本文確認・音声DL用）
  // ----------------------------------------------------
  // 戻り値: { rows: [{id, date, title, scriptJa, scriptEn, explanation, downloadedAt, rowIndex}], headerIndex, rowIndexById, exists }
  // headerIndex.audio_downloaded_at は列が無ければ -1
  // シート/タブが無い場合は { rows: [], exists: false } を返す
  async function loadDiary(spreadsheetId) {
    if (!spreadsheetId) throw new Error("spreadsheetId is required.");

    const url = "https://sheets.googleapis.com/v4/spreadsheets/" +
      encodeURIComponent(spreadsheetId) +
      "/values/" + encodeURIComponent("diary!A1:Z5000");

    const res = await authedFetch(url, { method: "GET" });
    if (!res.ok) {
      if (res.status === 400) {
        // タブが存在しない (Unable to parse range)
        return { rows: [], headerIndex: null, rowIndexById: {}, exists: false };
      }
      const errBody = await safeJson(res);
      throw new Error((errBody && errBody.error && errBody.error.message) || ("HTTP " + res.status));
    }
    const json = await res.json();
    const values = json.values || [];
    if (values.length === 0) {
      return { rows: [], headerIndex: null, rowIndexById: {}, exists: true };
    }

    const headers = values[0].map(function (h) { return String(h).trim(); });
    const headerIndex = { id: -1, date: -1, title: -1, script_ja: -1, script_en: -1, explanation: -1, audio_downloaded_at: -1 };
    headers.forEach(function (h, i) { if (h in headerIndex) headerIndex[h] = i; });
    const required = ["id", "script_ja", "script_en"];
    const missing = required.filter(function (h) { return headerIndex[h] < 0; });
    if (missing.length > 0) {
      const e = new Error("diary シートに必要な列がありません: " + missing.join(", "));
      e.code = "MISSING_COLUMNS";
      throw e;
    }

    const rows = [];
    const rowIndexById = {};
    for (let r = 1; r < values.length; r++) {
      const row = values[r];
      const id = toIntId(row[headerIndex.id]);
      if (!Number.isFinite(id)) continue;
      const scriptJa = String(row[headerIndex.script_ja] || "").trim();
      const scriptEn = String(row[headerIndex.script_en] || "").trim();
      if (!scriptJa && !scriptEn) continue;
      const date = headerIndex.date >= 0 ? String(row[headerIndex.date] || "").trim() : "";
      const title = headerIndex.title >= 0 ? String(row[headerIndex.title] || "").trim() : "";
      const explanation = headerIndex.explanation >= 0 ? String(row[headerIndex.explanation] || "").trim() : "";
      const downloadedAt = headerIndex.audio_downloaded_at >= 0
        ? String(row[headerIndex.audio_downloaded_at] || "").trim()
        : "";
      // 旧バグ (列追加時の上書き) で title/explanation に DL 日時の残骸が
      // 入っている可能性。検知したら警告のみ出す（データは変更しない）。
      if (/^\d{4}-\d\d-\d\dT/.test(title) || /^\d{4}-\d\d-\d\dT/.test(explanation)) {
        console.warn("[diary] id=" + id + " (row " + (r + 1) + ") の title/explanation に ISO 日時らしき値が入っています。旧バグの残骸の可能性があるので手動確認してください。");
      }
      rows.push({
        id: id,
        date: date,
        title: title,
        scriptJa: scriptJa,
        scriptEn: scriptEn,
        explanation: explanation,
        downloadedAt: downloadedAt,
        rowIndex: r + 1
      });
      rowIndexById[id] = r + 1;
    }

    return { rows: rows, headerIndex: headerIndex, rowIndexById: rowIndexById, exists: true };
  }

  // ----------------------------------------------------
  // diary に audio_downloaded_at 列が無ければ末尾に追加し、その列インデックスを返す
  // ----------------------------------------------------
  async function ensureDiaryDownloadColumn(spreadsheetId, headerIndex) {
    if (!spreadsheetId) throw new Error("spreadsheetId is required.");

    // 渡された headerIndex は stale な可能性があるため信用せず、実ヘッダ行を読み直す。
    const readUrl = "https://sheets.googleapis.com/v4/spreadsheets/" +
      encodeURIComponent(spreadsheetId) +
      "/values/" + encodeURIComponent("diary!A1:Z1");
    const readRes = await authedFetch(readUrl, { method: "GET" });
    if (!readRes.ok) {
      const errBody = await safeJson(readRes);
      throw new Error((errBody && errBody.error && errBody.error.message) || ("HTTP " + readRes.status));
    }
    const readJson = await readRes.json();
    const headers = (readJson.values && readJson.values[0]) || [];
    const trimmed = headers.map(function (h) { return String(h).trim(); });

    // 既に存在すればその位置を返す（冪等）。
    let colIdx = trimmed.indexOf("audio_downloaded_at");
    if (colIdx >= 0) {
      if (headerIndex) headerIndex.audio_downloaded_at = colIdx;
      return colIdx;
    }

    // 無ければ実ヘッダ幅の末尾へ追加する（未知の末尾列も上書きしない）。
    colIdx = trimmed.length;
    const headerUrl = "https://sheets.googleapis.com/v4/spreadsheets/" +
      encodeURIComponent(spreadsheetId) +
      "/values/" + encodeURIComponent("diary!" + colLetter(colIdx) + "1") +
      "?valueInputOption=RAW";
    const res = await authedFetch(headerUrl, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ values: [["audio_downloaded_at"]] })
    });
    if (!res.ok) {
      const errBody = await safeJson(res);
      throw new Error((errBody && errBody.error && errBody.error.message) || ("HTTP " + res.status));
    }
    if (headerIndex) headerIndex.audio_downloaded_at = colIdx;
    return colIdx;
  }

  // ----------------------------------------------------
  // diary の audio_downloaded_at セル 1 箇所だけ更新
  // ----------------------------------------------------
  async function recordDiaryDownloaded(spreadsheetId, colIdx, rowIdx, ts) {
    if (!spreadsheetId) throw new Error("spreadsheetId is required.");
    if (colIdx == null || colIdx < 0) throw new Error("audio_downloaded_at column missing");
    if (!rowIdx) throw new Error("diary row not found");

    const url = "https://sheets.googleapis.com/v4/spreadsheets/" +
      encodeURIComponent(spreadsheetId) +
      "/values/" + encodeURIComponent("diary!" + colLetter(colIdx) + rowIdx) +
      "?valueInputOption=RAW";
    const res = await authedFetch(url, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ values: [[ts || new Date().toISOString()]] })
    });
    if (!res.ok) {
      const errBody = await safeJson(res);
      throw new Error((errBody && errBody.error && errBody.error.message) || ("HTTP " + res.status));
    }
  }

  // ----------------------------------------------------
  // 公開 API
  // ----------------------------------------------------
  window.WQSheets = {
    loadWords: loadWords,
    recordAnswer: recordAnswer,
    writeCells: writeCells,
    buildAnswerCells: buildAnswerCells,
    buildRandomQuizCells: buildRandomQuizCells,
    buildExcludeFromRandomQuizCells: buildExcludeFromRandomQuizCells,
    appendWords: appendWords,
    ensureWordsSheet: ensureWordsSheet,
    createSpreadsheet: createSpreadsheet,
    ensureDiarySheet: ensureDiarySheet,
    appendDiary: appendDiary,
    loadDiary: loadDiary,
    ensureDiaryDownloadColumn: ensureDiaryDownloadColumn,
    recordDiaryDownloaded: recordDiaryDownloaded,
    ensureSentenceSheet: ensureSentenceSheet,
    appendSentences: appendSentences,
    loadSentences: loadSentences,
    recordSentencePracticed: recordSentencePracticed
  };
})();
