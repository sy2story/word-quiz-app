// 英単語クイズ メインロジック
// 仕様書: english_word_quiz_app_spec_updated.md

(function () {
  "use strict";

  // ====================================================
  // 定数
  // ====================================================
  const SECTION_SIZE = 10;
  const STORAGE_KEYS = {
    weakIds: "wordQuiz_weakIds",
    startedSectionIds: "wordQuiz_startedSectionIds",
    lastStudiedAt: "wordQuiz_lastStudiedAt",
    cachedWords: "wordQuiz_cachedWords",
    cachedWordsUpdatedAt: "wordQuiz_cachedWordsUpdatedAt",
    pendingAnswerLogs: "wordQuiz_pendingAnswerLogs",
    spreadsheetId: "wordQuiz_spreadsheetId",
    spreadsheetName: "wordQuiz_spreadsheetName",
    spreadsheetUrl: "wordQuiz_spreadsheetUrl"
  };

  // ====================================================
  // 状態
  // ====================================================
  const state = {
    words: [],
    sections: [],
    updatedAt: "",
    quiz: null,  // { sectionId, mode, words[], index, answered: bool }
    spreadsheetId: "",
    spreadsheetName: "",
    spreadsheetUrl: "",
    sheetCtx: null,    // { headers, headerIndex, rowIndexById }
    signedIn: false,
    loadError: null,   // { message, kind: "structure" | "network" | "auth" | "other" }
    autoCreateDeclinedFor: null,  // 同一シートで自動作成 confirm を拒否されたら再プロンプトしない
    sentences: null,   // スピーキング練習用 sentence シートのキャッシュ。{ rows, ctx } / null は未ロード
    speak: null        // { diaryId, items[], index, revealed: bool, sentenceCtx, startedAt }
  };

  // ====================================================
  // LocalStorage ラッパー
  // ====================================================
  const storageAvailable = (function () {
    try {
      const k = "__wq_test__";
      localStorage.setItem(k, "1");
      localStorage.removeItem(k);
      return true;
    } catch (e) {
      return false;
    }
  })();

  function lsGet(key, fallback) {
    if (!storageAvailable) return fallback;
    try {
      const raw = localStorage.getItem(key);
      return raw == null ? fallback : JSON.parse(raw);
    } catch (e) {
      return fallback;
    }
  }

  function lsSet(key, value) {
    if (!storageAvailable) return;
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch (e) {
      // ignore
    }
  }

  // id は number で統一。旧バージョンで "001" 文字列配列が保存されている場合も parseInt で number 化して返す。
  function normalizeIdList(arr) {
    if (!Array.isArray(arr)) return [];
    const seen = new Set();
    const out = [];
    arr.forEach(function (v) {
      const n = parseInt(String(v), 10);
      if (Number.isFinite(n) && !seen.has(n)) {
        seen.add(n);
        out.push(n);
      }
    });
    return out;
  }

  function getWeakIds() {
    return normalizeIdList(lsGet(STORAGE_KEYS.weakIds, []));
  }

  function setWeakIds(ids) {
    lsSet(STORAGE_KEYS.weakIds, normalizeIdList(ids));
  }

  function addWeakId(id) {
    const n = parseInt(String(id), 10);
    if (!Number.isFinite(n)) return;
    const ids = getWeakIds();
    if (!ids.includes(n)) {
      ids.push(n);
      setWeakIds(ids);
    }
  }

  function removeWeakId(id) {
    const n = parseInt(String(id), 10);
    if (!Number.isFinite(n)) return;
    setWeakIds(getWeakIds().filter(x => x !== n));
  }

  // 旧バージョンで保存された "001" 文字列の weakIds を number 配列に書き戻し、
  // 同じく文字列 id を含む cachedWords は型不整合を避けるため一度クリア。
  // 初回起動時に 1 度だけ走らせれば十分。
  function migrateIdStorageOnce() {
    if (!storageAvailable) return;
    const FLAG = "wordQuiz_idMigratedToNumber";
    try {
      if (localStorage.getItem(FLAG) === "1") return;
    } catch (e) {
      return;
    }
    setWeakIds(getWeakIds());
    try {
      localStorage.removeItem(STORAGE_KEYS.cachedWords);
      localStorage.removeItem(STORAGE_KEYS.cachedWordsUpdatedAt);
      localStorage.setItem(FLAG, "1");
    } catch (e) {
      // ignore
    }
  }

  function getStartedSectionIds() {
    const arr = lsGet(STORAGE_KEYS.startedSectionIds, []);
    return Array.isArray(arr) ? arr : [];
  }

  function addStartedSectionId(id) {
    const ids = getStartedSectionIds();
    if (!ids.includes(id)) {
      ids.push(id);
      lsSet(STORAGE_KEYS.startedSectionIds, ids);
    }
  }

  function getPendingLogs() {
    const arr = lsGet(STORAGE_KEYS.pendingAnswerLogs, []);
    return Array.isArray(arr) ? arr : [];
  }

  function setPendingLogs(logs) {
    lsSet(STORAGE_KEYS.pendingAnswerLogs, logs);
  }

  function addPendingLog(log) {
    const logs = getPendingLogs();
    logs.push(log);
    setPendingLogs(logs);
  }

  // ====================================================
  // データ取得（Sheets API 経由）
  // ====================================================
  async function loadWords() {
    if (!state.spreadsheetId) {
      return { data: [], updatedAt: "", source: "no-sheet" };
    }

    try {
      const result = await window.WQSheets.loadWords(state.spreadsheetId);

      state.sheetCtx = {
        headers: result.headers,
        headerIndex: result.headerIndex,
        rowIndexById: result.rowIndexById
      };
      state.loadError = null;

      // キャッシュ保存（オフライン表示用）
      lsSet(STORAGE_KEYS.cachedWords, result.data);
      lsSet(STORAGE_KEYS.cachedWordsUpdatedAt, result.updatedAt);

      return { data: result.data, updatedAt: result.updatedAt, source: "api" };
    } catch (err) {
      // 自動作成オファー: words タブ欠落 or 完全に空のときだけ
      const autoCreatable = err && (err.code === "TAB_NOT_FOUND" || err.code === "EMPTY_SHEET");
      if (autoCreatable && state.autoCreateDeclinedFor !== state.spreadsheetId) {
        const msg = err.code === "TAB_NOT_FOUND"
          ? "'words' シートが見つかりません。ヘッダ付きで自動作成しますか？"
          : "'words' シートが空です。ヘッダ行を自動で書き込みますか？";
        if (window.confirm(msg)) {
          try {
            await window.WQSheets.ensureWordsSheet(state.spreadsheetId);
            const result = await window.WQSheets.loadWords(state.spreadsheetId);
            state.sheetCtx = {
              headers: result.headers,
              headerIndex: result.headerIndex,
              rowIndexById: result.rowIndexById
            };
            state.loadError = null;
            lsSet(STORAGE_KEYS.cachedWords, result.data);
            lsSet(STORAGE_KEYS.cachedWordsUpdatedAt, result.updatedAt);
            showError("words シートを作成しました。単語を追加すると学習を開始できます。", "info");
            return { data: result.data, updatedAt: result.updatedAt, source: "api" };
          } catch (e2) {
            console.warn("ensureWordsSheet failed:", e2);
            err = e2;  // 既存エラー処理にフォールスルー
          }
        } else {
          state.autoCreateDeclinedFor = state.spreadsheetId;
        }
      }

      console.warn("Sheets API fetch failed:", err);
      state.loadError = classifyLoadError(err);

      // ネットワーク系エラーはキャッシュにフォールバック（構造エラーはキャッシュも使わない）
      const isRecoverable = state.loadError.kind === "network" ||
        state.loadError.kind === "auth";
      if (isRecoverable) {
        const cached = lsGet(STORAGE_KEYS.cachedWords, null);
        if (Array.isArray(cached) && cached.length > 0) {
          state.loadError = null;
          showError("オフラインのため、前回キャッシュで表示しています。", "info");
          return {
            data: cached,
            updatedAt: lsGet(STORAGE_KEYS.cachedWordsUpdatedAt, "") || "",
            source: "cache"
          };
        }
      }

      return { data: [], updatedAt: "", source: "error" };
    }
  }

  function classifyLoadError(err) {
    const code = err && err.code;
    if (code === "MISSING_COLUMNS") {
      return {
        kind: "structure",
        message: "選んだシートには必要な列が揃っていません: " + (err.missing || []).join(", ") +
          "。シート名は 'words'、1行目に必須列のヘッダがある状態にしてください。"
      };
    }
    if (code === "EMPTY_SHEET") {
      return {
        kind: "structure",
        message: "シートにデータが1行もありません。1行目にヘッダを書き、2行目以降に単語を追加してください。"
      };
    }
    if (code === "TAB_NOT_FOUND") {
      return {
        kind: "structure",
        message: "シート名 'words' のタブが見つかりません。タブ名を 'words' に変更するか、別のシートを選んでください。"
      };
    }
    if (code === "FORBIDDEN") {
      return {
        kind: "auth",
        message: "シートへのアクセス権限がありません。シートのオーナーで再度サインインしてください。"
      };
    }
    if (code === "SHEET_NOT_FOUND") {
      return {
        kind: "structure",
        message: "シートが見つかりません。削除された可能性があります。別のシートを選んでください。"
      };
    }
    return {
      kind: "network",
      message: "シートの読み込みに失敗しました: " + (err.message || err)
    };
  }

  // ====================================================
  // 回答書き込み（Sheets API batchUpdate）
  // ====================================================
  async function recordAnswerToSheet(word, result, answeredAt) {
    if (!state.spreadsheetId || !state.sheetCtx) {
      console.warn("recordAnswer skipped: sheet not loaded");
      return null;
    }

    // 失敗時オフラインキュー用に、書き込み内容を先に組み立てる
    let built;
    try {
      built = window.WQSheets.buildAnswerCells(word, result, state.sheetCtx, answeredAt);
    } catch (err) {
      console.warn("buildAnswerCells failed:", err);
      return null;
    }

    try {
      await window.WQSheets.writeCells(state.spreadsheetId, built.cells);
      return built.next;
    } catch (err) {
      console.warn("write failed, queueing for retry:", err);
      addPendingLog({
        spreadsheetId: state.spreadsheetId,
        cells: built.cells,
        queuedAt: new Date().toISOString()
      });
      return null;
    }
  }

  async function retryPendingLogs() {
    if (!window.WQAuth || !window.WQAuth.isSignedIn()) return;

    const logs = getPendingLogs();
    if (logs.length === 0) return;

    const remaining = [];
    for (const log of logs) {
      // 互換性: 旧 GAS 形式（wordId/result/answeredAt）は破棄
      if (!log.spreadsheetId || !Array.isArray(log.cells)) continue;
      try {
        await window.WQSheets.writeCells(log.spreadsheetId, log.cells);
      } catch (e) {
        remaining.push(log);
      }
    }
    setPendingLogs(remaining);
  }

  // ====================================================
  // セクション分割
  // ====================================================
  function splitIntoSections(words) {
    const sections = [];
    for (let i = 0; i < words.length; i += SECTION_SIZE) {
      const slice = words.slice(i, i + SECTION_SIZE);
      const num = Math.floor(i / SECTION_SIZE) + 1;
      sections.push({
        id: "section-" + num,
        label: "Section " + num,
        rangeText: (i + 1) + "〜" + (i + slice.length) + "問目",
        words: slice
      });
    }
    return sections;
  }

  // ====================================================
  // 苦手判定
  // ====================================================
  function isWordWeak(word) {
    if (word.isWeak === true) return true;
    return getWeakIds().includes(word.id);
  }

  function countWeak(words) {
    return words.filter(isWordWeak).length;
  }

  function isSectionStarted(section) {
    if (getStartedSectionIds().includes(section.id)) return true;
    return section.words.some(w => w.lastResult);
  }

  // ====================================================
  // ホーム画面レンダリング
  // ====================================================
  function renderHome() {
    const sectionsList = document.getElementById("sections-list");
    sectionsList.innerHTML = "";

    document.getElementById("total-count").textContent = state.words.length + " 語";

    const updatedLabel = state.updatedAt
      ? "最終取得: " + formatDateTime(state.updatedAt)
      : "データ読み込み中…";
    document.getElementById("last-updated").textContent = updatedLabel;

    if (state.sections.length === 0) {
      sectionsList.innerHTML =
        '<div class="bg-white rounded-xl shadow-sm p-4 text-center text-slate-500">' +
        '出題できる単語がありません。</div>';
      return;
    }

    state.sections.forEach(section => {
      const weakCount = countWeak(section.words);
      const started = isSectionStarted(section);

      let statusLabel;
      let statusClass;
      if (!started) {
        statusLabel = "未着手";
        statusClass = "text-slate-500";
      } else if (weakCount === 0) {
        statusLabel = "マスター済み ✨";
        statusClass = "text-green-600 font-semibold";
      } else {
        statusLabel = "残り苦手: " + weakCount + "問";
        statusClass = "text-red-600 font-semibold";
      }

      const primaryLabel = started ? "もう一度解く" : "解いてみる";
      const weakDisabled = weakCount === 0 ? "opacity-40 cursor-not-allowed" : "";

      const card = document.createElement("div");
      card.className = "bg-white rounded-xl shadow-sm p-4";
      card.innerHTML =
        '<div class="flex items-center justify-between mb-1">' +
          '<h2 class="text-base font-semibold">' + escapeHtml(section.label) + '</h2>' +
          '<span class="text-xs text-slate-400">' + escapeHtml(section.rangeText) + '</span>' +
        '</div>' +
        '<p class="text-sm ' + statusClass + ' mb-3">' + escapeHtml(statusLabel) + '</p>' +
        '<div class="grid grid-cols-2 gap-2">' +
          '<button type="button" data-action="start" data-section-id="' + section.id + '" ' +
            'class="bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium py-2 rounded-lg">' +
            escapeHtml(primaryLabel) +
          '</button>' +
          '<button type="button" data-action="weak" data-section-id="' + section.id + '" ' +
            (weakCount === 0 ? "disabled " : "") +
            'class="bg-white border border-blue-200 text-blue-600 text-sm font-medium py-2 rounded-lg ' + weakDisabled + '">' +
            '苦手のみ' +
          '</button>' +
        '</div>';

      sectionsList.appendChild(card);
    });
  }

  function handleSectionsClick(e) {
    const btn = e.target.closest("button[data-action]");
    if (!btn) return;
    const sectionId = btn.dataset.sectionId;
    const action = btn.dataset.action;
    const section = state.sections.find(s => s.id === sectionId);
    if (!section) return;

    if (action === "start") {
      addStartedSectionId(sectionId);
      startQuiz({ sectionId: sectionId, mode: "all", words: section.words.slice() });
    } else if (action === "weak") {
      const weakWords = section.words.filter(isWordWeak);
      if (weakWords.length === 0) return;
      startQuiz({ sectionId: sectionId, mode: "weak", words: weakWords });
    }
  }

  // ====================================================
  // クイズ画面
  // ====================================================
  function startQuiz(quizConfig) {
    state.quiz = {
      sectionId: quizConfig.sectionId,
      mode: quizConfig.mode,
      words: quizConfig.words,
      index: 0,
      answered: false
    };
    document.getElementById("home-screen").hidden = true;
    document.getElementById("quiz-screen").hidden = false;
    document.getElementById("quiz-summary").classList.add("hidden");
    document.getElementById("quiz-card").classList.remove("hidden");
    renderQuiz();
  }

  function renderQuiz() {
    if (!state.quiz) return;
    const q = state.quiz;
    const word = q.words[q.index];

    document.getElementById("quiz-progress").textContent =
      (q.index + 1) + " / " + q.words.length;
    document.getElementById("quiz-meaning").textContent = word.meaningJa;
    document.getElementById("quiz-phrase-ja").textContent = word.phraseJa;
    document.getElementById("quiz-phrase-blank").textContent =
      buildBlank(word.word, word.phraseEn).blank;

    const wordCount = String(word.word || "").trim().split(/\s+/).filter(Boolean).length;
    const input = document.getElementById("answer-input");
    input.placeholder = wordCount >= 2
      ? "(____) に入る単語を入力 (" + wordCount + "語)"
      : "(____) に入る単語を入力";

    // 入力欄リセット、フォーカス
    input.value = "";
    document.getElementById("submit-btn").disabled = true;

    q.answered = false;
    document.getElementById("input-area").classList.remove("hidden");
    document.getElementById("answer-area").classList.add("hidden");

    // モバイル含めフォーカスを当てる（autofocusは画面遷移時に効きづらいので明示）
    setTimeout(() => input.focus(), 0);
  }

  function normalizeAnswer(s) {
    return String(s || "").trim().toLowerCase();
  }

  function submitAnswer() {
    if (!state.quiz || state.quiz.answered) return;
    const word = state.quiz.words[state.quiz.index];
    const input = document.getElementById("answer-input");
    const userInput = input.value;
    if (!userInput.trim()) return;

    const isCorrect = normalizeAnswer(userInput) === normalizeAnswer(word.word);
    showResult(isCorrect ? "correct" : "wrong", userInput);
  }

  function skipAnswer() {
    if (!state.quiz || state.quiz.answered) return;
    showResult("wrong", "");
  }

  function showResult(result, userInput) {
    if (!state.quiz) return;
    const word = state.quiz.words[state.quiz.index];
    const built = buildBlank(word.word, word.phraseEn);
    const answeredAt = new Date().toISOString();

    // 結果カードの見た目
    const card = document.getElementById("result-card");
    const badge = document.getElementById("result-badge");
    if (result === "correct") {
      card.className = "rounded-xl shadow-sm p-5 bg-green-50 border border-green-200";
      badge.textContent = "◯ 正解!";
      badge.className = "text-lg font-bold mb-3 text-green-700";
    } else {
      card.className = "rounded-xl shadow-sm p-5 bg-red-50 border border-red-200";
      badge.textContent = "✕ 不正解";
      badge.className = "text-lg font-bold mb-3 text-red-700";
    }

    const yourBlock = document.getElementById("your-answer-block");
    if (result === "wrong" && userInput.trim()) {
      yourBlock.classList.remove("hidden");
      document.getElementById("your-answer-text").textContent = userInput;
    } else {
      yourBlock.classList.add("hidden");
    }

    document.getElementById("answer-word").textContent = word.word;
    document.getElementById("answer-phrase").textContent = built.complete;

    state.quiz.answered = true;
    document.getElementById("input-area").classList.add("hidden");
    document.getElementById("answer-area").classList.remove("hidden");

    // LocalStorage更新
    if (result === "wrong") {
      addWeakId(word.id);
      word.isWeak = true;
    } else {
      removeWeakId(word.id);
      word.isWeak = false;
    }
    lsSet(STORAGE_KEYS.lastStudiedAt, answeredAt);

    // バックグラウンドで Sheets API に書き込み
    recordAnswerToSheet(word, result, answeredAt).then(next => {
      if (next) {
        // ローカル状態を最新値で同期
        word.correctCount = next.correct_count;
        word.wrongCount = next.wrong_count;
        word.lastResult = next.last_result;
        word.lastAnsweredAt = next.last_answered_at;
        word.isWeak = next.is_weak;
        word.consecutiveCorrectCount = next.consecutive_correct_count;
      }
    });
  }

  function advanceQuestion() {
    if (!state.quiz) return;
    state.quiz.index++;
    if (state.quiz.index >= state.quiz.words.length) {
      finishQuiz();
    } else {
      renderQuiz();
    }
  }

  function finishQuiz() {
    document.getElementById("answer-area").classList.add("hidden");
    document.getElementById("quiz-card").classList.add("hidden");

    const remainingWeak = state.quiz.words.filter(isWordWeak).length;
    const text = remainingWeak === 0
      ? "全問おつかれさまでした！このセクションは苦手0です ✨"
      : "おつかれさまでした！残り苦手: " + remainingWeak + "問";
    document.getElementById("quiz-summary-text").textContent = text;
    document.getElementById("quiz-summary").classList.remove("hidden");
  }

  function backToHome() {
    state.quiz = null;
    document.getElementById("quiz-screen").hidden = true;
    document.getElementById("home-screen").hidden = false;
    renderHome();
  }

  // ====================================================
  // 穴埋め生成（仕様書 §15）
  // ====================================================
  function buildBlank(word, phraseEn) {
    const BLANK = "(____)";
    if (!word || !phraseEn) {
      return { blank: phraseEn + " " + BLANK, complete: phraseEn + " " + (word || "") };
    }

    // 大文字小文字を無視し、word の出現位置を単語境界で検出（最初の一致のみ）
    const re = new RegExp("(^|[^A-Za-z])(" + escapeRegExp(word) + ")(?=[^A-Za-z]|$)", "i");
    const match = phraseEn.match(re);

    if (!match) {
      // 仕様書 §15.4: 含まれない場合は末尾に空欄
      return {
        blank: phraseEn + " " + BLANK,
        complete: phraseEn + " " + word.toLowerCase()
      };
    }

    const matchedWord = match[2];
    const wordIndex = match.index + match[1].length;
    const isAtStart = wordIndex === 0;

    const before = phraseEn.slice(0, wordIndex);
    const after = phraseEn.slice(wordIndex + matchedWord.length);

    const completeWord = isAtStart
      ? word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()
      : word.toLowerCase();

    return {
      blank: before + BLANK + after,
      complete: before + completeWord + after
    };
  }

  // ====================================================
  // 音声再生（Web Speech API）
  // ====================================================
  const speechSupported = "speechSynthesis" in window;

  function speak(text) {
    if (!speechSupported) {
      alert("このブラウザは音声読み上げに対応していません。");
      return;
    }
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = "en-US";
    u.rate = 1.0;
    u.pitch = 1.0;
    u.volume = 1.0;
    window.speechSynthesis.speak(u);
  }

  // ====================================================
  // ユーティリティ
  // ====================================================
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
    );
  }

  function escapeRegExp(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function formatDateTime(iso) {
    if (!iso) return "";
    const d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    const pad = n => String(n).padStart(2, "0");
    return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) +
      " " + pad(d.getHours()) + ":" + pad(d.getMinutes());
  }

  function showError(message, kind) {
    const el = document.getElementById("error-banner");
    if (!el) return;
    if (!message) {
      el.classList.add("hidden");
      el.textContent = "";
      return;
    }
    el.textContent = message;
    el.classList.remove("hidden");
    if (kind === "info") {
      el.classList.remove("bg-red-50", "border-red-200", "text-red-700");
      el.classList.add("bg-blue-50", "border-blue-200", "text-blue-700");
    } else {
      el.classList.remove("bg-blue-50", "border-blue-200", "text-blue-700");
      el.classList.add("bg-red-50", "border-red-200", "text-red-700");
    }
  }

  // ====================================================
  // AI: 日本語 → 英訳 + 語彙抽出 + シート追加
  // ====================================================
  const ai = {
    open: false,
    lastInputText: "",      // 最後に「生成」or「再生成」したテキスト
    regenCountForText: 0,   // 同一 lastInputText に対する再生成回数 (上限 2 = (F))
    items: [],              // [{...item, _selected: bool}]
    translation_en: "",
    sentences: [],          // [{sentence_en, sentence_ja}, ...] スピーキング練習素材
    cooldownTimer: null,
    writing: false
  };
  const AI_MAX_REGEN_PER_TEXT = 2;

  function showAiCardIfReady() {
    const card = document.getElementById("ai-card");
    if (!card) return;
    const ready = window.WQAi && window.WQAi.isEnabled() &&
      state.signedIn && state.spreadsheetId && !state.loadError;
    if (ready) card.classList.remove("hidden");
    else card.classList.add("hidden");
  }

  function aiSetError(msg) {
    const el = document.getElementById("ai-error");
    if (!el) return;
    if (msg) {
      el.textContent = msg;
      el.classList.remove("hidden");
    } else {
      el.textContent = "";
      el.classList.add("hidden");
    }
  }

  function aiUpdateRemaining() {
    const el = document.getElementById("ai-remaining");
    if (!el) return;
    const r = window.WQAi.getRemaining();
    el.textContent = (r == null) ? "今日 残り - 回" : ("今日 残り " + r + " 回");
  }

  function aiUpdateInputCount() {
    const input = document.getElementById("ai-input");
    const count = document.getElementById("ai-input-count");
    const btn = document.getElementById("ai-generate-btn");
    const msg = document.getElementById("ai-input-msg");
    const max = (window.WQAi && window.WQAi.MAX_INPUT_CHARS) || 500;
    const len = input.value.length;
    count.textContent = len + " / " + max;
    count.classList.toggle("text-red-500", len > max);
    count.classList.toggle("text-slate-400", len <= max);
    if (len > max) {
      msg.textContent = "文字数が上限を超えています。";
      msg.classList.remove("hidden");
    } else {
      msg.classList.add("hidden");
    }
    btn.disabled = !(len > 0 && len <= max) || ai.writing;
  }

  function aiStartCooldownTick() {
    aiTickCooldown();
    if (ai.cooldownTimer) clearInterval(ai.cooldownTimer);
    ai.cooldownTimer = setInterval(aiTickCooldown, 500);
  }

  function aiStopCooldownTick() {
    if (ai.cooldownTimer) {
      clearInterval(ai.cooldownTimer);
      ai.cooldownTimer = null;
    }
  }

  function aiTickCooldown() {
    const btn = document.getElementById("ai-regenerate-btn");
    const hint = document.getElementById("ai-regen-hint");
    if (!btn || !hint) return;

    if (ai.regenCountForText >= AI_MAX_REGEN_PER_TEXT) {
      // (F): 同一テキストでの再生成回数上限。ボタン非表示にして文言で案内。
      btn.classList.add("hidden");
      aiStopCooldownTick();
      return;
    }
    btn.classList.remove("hidden");

    const cdRemain = window.WQAi.getCooldownRemainingSec();
    const regenLeft = AI_MAX_REGEN_PER_TEXT - ai.regenCountForText;
    if (cdRemain > 0) {
      btn.disabled = true;
      hint.textContent = "(" + cdRemain + "秒)";
    } else {
      btn.disabled = ai.writing;
      hint.textContent = "(残り " + regenLeft + " 回)";
      aiStopCooldownTick();
    }
  }

  function openAiModal() {
    if (!window.WQAi || !window.WQAi.isEnabled()) {
      showError("AI 機能の URL (AI_PROXY_URL) が設定されていません。");
      return;
    }
    ai.open = true;
    ai.lastInputText = "";
    ai.regenCountForText = 0;
    ai.items = [];
    ai.translation_en = "";
    ai.sentences = [];
    document.getElementById("ai-input").value = "";
    document.getElementById("ai-result").classList.add("hidden");
    document.getElementById("ai-footer").classList.add("hidden");
    aiSetError("");
    aiUpdateInputCount();
    aiUpdateRemaining();
    document.getElementById("ai-modal").classList.remove("hidden");
    setTimeout(() => document.getElementById("ai-input").focus(), 50);
  }

  function closeAiModal() {
    ai.open = false;
    aiStopCooldownTick();
    document.getElementById("ai-modal").classList.add("hidden");
  }

  function aiRenderResult() {
    document.getElementById("ai-translation").textContent = ai.translation_en || "(英訳なし)";
    const ul = document.getElementById("ai-items");
    ul.innerHTML = "";
    ai.items.forEach((it, idx) => {
      const li = document.createElement("li");
      li.className = "border border-slate-200 rounded-md p-2";
      li.innerHTML =
        '<label class="flex items-start gap-2 cursor-pointer">' +
          '<input type="checkbox" data-idx="' + idx + '" class="ai-item-check mt-1" ' +
            (it._selected ? "checked" : "") + '>' +
          '<div class="min-w-0 flex-1">' +
            '<p class="text-sm font-semibold">' + escapeHtml(it.word) +
              ' <span class="text-xs text-slate-500 font-normal">— ' + escapeHtml(it.meaning_ja) + '</span></p>' +
            '<p class="text-xs text-slate-600 mt-0.5">' + escapeHtml(it.phrase_en) +
              ' <span class="text-slate-400">/ ' + escapeHtml(it.phrase_ja) + '</span></p>' +
            (it.example_en
              ? '<p class="text-xs text-slate-500 mt-0.5 italic">例: ' + escapeHtml(it.example_en) + '</p>'
              : "") +
          '</div>' +
        '</label>';
      ul.appendChild(li);
    });

    // チェック変更ハンドラ
    ul.querySelectorAll(".ai-item-check").forEach(cb => {
      cb.addEventListener("change", e => {
        const i = parseInt(e.target.dataset.idx, 10);
        if (!Number.isFinite(i)) return;
        ai.items[i]._selected = e.target.checked;
      });
    });

    document.getElementById("ai-result").classList.remove("hidden");
    document.getElementById("ai-footer").classList.remove("hidden");
    aiUpdateRemaining();
    aiTickCooldown();
    aiStartCooldownTick();
  }

  async function aiCallGenerate(isRegenerate) {
    const input = document.getElementById("ai-input");
    const text = input.value;
    if (!text.trim()) return;

    // 新規生成 or テキストが変わった再生成 → カウンタリセット
    if (!isRegenerate || text !== ai.lastInputText) {
      ai.regenCountForText = 0;
    }

    ai.writing = true;
    aiSetError("");
    document.getElementById("ai-generate-btn").disabled = true;
    document.getElementById("ai-regenerate-btn").disabled = true;

    const result = await window.WQAi.generate(text);

    ai.writing = false;
    aiUpdateInputCount();

    if (!result.success) {
      aiSetError(result.error || "失敗しました");
      aiUpdateRemaining();
      // クールダウン中エラーでも UI を進める
      if (ai.items.length > 0) aiTickCooldown();
      return;
    }

    // 成功 → 状態更新
    ai.lastInputText = text;
    if (isRegenerate) ai.regenCountForText += 1;
    ai.translation_en = result.translation_en || "";
    ai.items = (result.items || []).map(it => Object.assign({}, it, { _selected: true }));
    ai.sentences = Array.isArray(result.sentences) ? result.sentences : [];
    aiRenderResult();
  }

  async function aiConfirm() {
    if (ai.writing) return;
    if (!state.spreadsheetId || !state.sheetCtx) {
      aiSetError("スプレッドシートが読み込まれていません。");
      return;
    }
    const selected = ai.items.filter(it => it._selected);
    const scriptJa = ai.lastInputText;
    const scriptEn = ai.translation_en;

    ai.writing = true;
    aiSetError("");
    document.getElementById("ai-confirm-btn").disabled = true;
    document.getElementById("ai-cancel-btn").disabled = true;
    document.getElementById("ai-regenerate-btn").disabled = true;

    const sentences = Array.isArray(ai.sentences) ? ai.sentences.slice() : [];
    let sentencesWritten = 0;
    let sentenceWriteFailed = false;

    try {
      // diary を先に保証してから 2 つの append を順に。
      const diaryCtx = await window.WQSheets.ensureDiarySheet(state.spreadsheetId);
      const diaryResult = await window.WQSheets.appendDiary(state.spreadsheetId, diaryCtx, {
        script_ja: scriptJa, script_en: scriptEn
      });
      if (selected.length > 0) {
        await window.WQSheets.appendWords(state.spreadsheetId, selected, state.sheetCtx);
      }

      // sentence シートにも対訳ペアを追加（任意・失敗してもメインフローは止めない）
      if (sentences.length > 0 && diaryResult && Number.isFinite(diaryResult.id)) {
        try {
          const sentenceCtx = await window.WQSheets.ensureSentenceSheet(state.spreadsheetId);
          const sentenceRes = await window.WQSheets.appendSentences(
            state.spreadsheetId, sentenceCtx, diaryResult.id, sentences
          );
          sentencesWritten = (sentenceRes && sentenceRes.appendedIds && sentenceRes.appendedIds.length) || 0;
          // sentence シートの内容が変わったのでキャッシュをクリアして次回開いたときに再ロード
          state.sentences = null;
        } catch (sentenceErr) {
          console.warn("sentence sheet write failed:", sentenceErr);
          sentenceWriteFailed = true;
        }
      }

      closeAiModal();
      await refresh();

      const parts = [];
      if (selected.length > 0) parts.push(selected.length + " 件の単語");
      if (sentencesWritten > 0) parts.push(sentencesWritten + " 文のスピーキング素材");
      const summary = parts.length > 0
        ? parts.join(" と ") + "を追加しました。"
        : "日記を記録しました。";
      showError(
        sentenceWriteFailed
          ? summary + " (スピーキング素材の保存に失敗しました)"
          : summary,
        sentenceWriteFailed ? "error" : "info"
      );
    } catch (err) {
      console.error("ai confirm failed:", err);
      aiSetError("書き込みに失敗しました: " + (err.message || err));
    } finally {
      ai.writing = false;
      document.getElementById("ai-confirm-btn").disabled = false;
      document.getElementById("ai-cancel-btn").disabled = false;
      aiTickCooldown();
    }
  }

  // ====================================================
  // スピーキング練習モード
  // ====================================================
  function showSpeakCardIfReady() {
    const card = document.getElementById("speak-card");
    if (!card) return;
    const ready = state.signedIn && state.spreadsheetId && !state.loadError;
    if (ready) card.classList.remove("hidden");
    else card.classList.add("hidden");
  }

  async function openSpeakList() {
    if (!state.spreadsheetId) {
      showError("スプレッドシートに接続してください。");
      return;
    }
    document.getElementById("home-screen").hidden = true;
    document.getElementById("speak-list-screen").hidden = false;

    const loading = document.getElementById("speak-list-loading");
    const empty = document.getElementById("speak-list-empty");
    const list = document.getElementById("speak-list");

    if (state.sentences && Array.isArray(state.sentences.rows)) {
      loading.classList.add("hidden");
      renderSpeakList();
      return;
    }

    loading.classList.remove("hidden");
    empty.classList.add("hidden");
    list.classList.add("hidden");

    try {
      let res = await window.WQSheets.loadSentences(state.spreadsheetId);
      if (!res.exists) {
        // タブが無い場合はここで作成しておく（次回以降の append が速くなる）
        const ctx = await window.WQSheets.ensureSentenceSheet(state.spreadsheetId);
        res = { rows: [], headerIndex: ctx.headerIndex, rowIndexById: {}, maxId: ctx.maxId, exists: true };
      }
      state.sentences = res;
      loading.classList.add("hidden");
      renderSpeakList();
    } catch (err) {
      console.error("loadSentences failed:", err);
      loading.classList.add("hidden");
      empty.classList.remove("hidden");
      document.getElementById("speak-list-empty").innerHTML =
        '読み込みに失敗しました。<br><span class="text-xs">' + escapeHtml(err.message || String(err)) + '</span>';
    }
  }

  function closeSpeakList() {
    document.getElementById("speak-list-screen").hidden = true;
    document.getElementById("home-screen").hidden = false;
  }

  function renderSpeakList() {
    const list = document.getElementById("speak-list");
    const empty = document.getElementById("speak-list-empty");
    const rows = (state.sentences && state.sentences.rows) || [];

    if (rows.length === 0) {
      empty.classList.remove("hidden");
      empty.textContent = "まだ練習素材がありません。「日本語からAIで単語を追加」から日記を登録すると、ここに表示されます。";
      list.classList.add("hidden");
      list.innerHTML = "";
      return;
    }

    // diary_id ごとにグルーピング
    const groups = new Map();
    rows.forEach(function (r) {
      if (!groups.has(r.diaryId)) groups.set(r.diaryId, []);
      groups.get(r.diaryId).push(r);
    });

    // 新しい diary_id (= 後に追加された) を上に
    const sortedDiaryIds = Array.from(groups.keys()).sort(function (a, b) { return b - a; });

    list.innerHTML = "";
    sortedDiaryIds.forEach(function (diaryId) {
      const items = groups.get(diaryId);
      const previewJa = items[0] ? items[0].sentenceJa : "";
      const card = document.createElement("button");
      card.type = "button";
      card.dataset.diaryId = String(diaryId);
      card.className = "block w-full text-left bg-white rounded-xl shadow-sm p-4 hover:bg-blue-50 transition";
      card.innerHTML =
        '<div class="flex items-center justify-between mb-1">' +
          '<h3 class="text-sm font-semibold text-slate-700">Diary #' + diaryId + '</h3>' +
          '<span class="text-xs text-blue-600 font-medium">' + items.length + ' 文</span>' +
        '</div>' +
        '<p class="text-sm text-slate-600 line-clamp-2">' + escapeHtml(previewJa) + '</p>';
      list.appendChild(card);
    });

    empty.classList.add("hidden");
    list.classList.remove("hidden");
  }

  function handleSpeakListClick(e) {
    const btn = e.target.closest("button[data-diary-id]");
    if (!btn) return;
    const diaryId = parseInt(btn.dataset.diaryId, 10);
    if (!Number.isFinite(diaryId)) return;
    startSpeakingPractice(diaryId);
  }

  function startSpeakingPractice(diaryId) {
    const rows = (state.sentences && state.sentences.rows) || [];
    const items = rows.filter(function (r) { return r.diaryId === diaryId; });
    if (items.length === 0) {
      showError("この日記には練習可能な文がありません。");
      return;
    }

    state.speak = {
      diaryId: diaryId,
      items: items,
      index: 0,
      revealed: false
    };

    document.getElementById("speak-list-screen").hidden = true;
    document.getElementById("speak-screen").hidden = false;
    document.getElementById("speak-summary").classList.add("hidden");
    document.getElementById("speak-question-card").classList.remove("hidden");
    renderSpeakQuestion();
  }

  function renderSpeakQuestion() {
    if (!state.speak) return;
    const s = state.speak;
    const item = s.items[s.index];

    document.getElementById("speak-progress").textContent =
      (s.index + 1) + " / " + s.items.length;
    document.getElementById("speak-ja").textContent = item.sentenceJa;

    const input = document.getElementById("speak-input");
    input.value = "";

    s.revealed = false;
    document.getElementById("speak-input-area").classList.remove("hidden");
    document.getElementById("speak-answer-area").classList.add("hidden");

    setTimeout(function () { input.focus(); }, 0);
  }

  function revealSpeakAnswer() {
    if (!state.speak || state.speak.revealed) return;
    const s = state.speak;
    const item = s.items[s.index];
    const userInput = document.getElementById("speak-input").value;

    const yourBlock = document.getElementById("speak-your-block");
    if (userInput.trim()) {
      yourBlock.classList.remove("hidden");
      document.getElementById("speak-your-input").textContent = userInput;
    } else {
      yourBlock.classList.add("hidden");
    }

    document.getElementById("speak-en").textContent = item.sentenceEn;

    s.revealed = true;
    document.getElementById("speak-input-area").classList.add("hidden");
    document.getElementById("speak-answer-area").classList.remove("hidden");

    // 最終練習日を非同期で更新（失敗しても UI は止めない）
    const practicedAt = new Date().toISOString();
    item.lastPracticedAt = practicedAt;
    if (state.sentences && state.sentences.rowIndexById && state.sentences.headerIndex) {
      window.WQSheets.recordSentencePracticed(
        state.spreadsheetId,
        { headerIndex: state.sentences.headerIndex, rowIndexById: state.sentences.rowIndexById },
        item.id,
        practicedAt
      ).catch(function (err) {
        console.warn("recordSentencePracticed failed:", err);
      });
    }
  }

  function advanceSpeakQuestion() {
    if (!state.speak) return;
    state.speak.index++;
    if (state.speak.index >= state.speak.items.length) {
      finishSpeakingPractice();
    } else {
      renderSpeakQuestion();
    }
  }

  function finishSpeakingPractice() {
    if (!state.speak) return;
    document.getElementById("speak-answer-area").classList.add("hidden");
    document.getElementById("speak-input-area").classList.add("hidden");
    document.getElementById("speak-question-card").classList.add("hidden");
    document.getElementById("speak-summary-text").textContent =
      state.speak.items.length + " 文を練習しました。";
    document.getElementById("speak-summary").classList.remove("hidden");
  }

  function backFromSpeakToList() {
    state.speak = null;
    document.getElementById("speak-screen").hidden = true;
    document.getElementById("speak-list-screen").hidden = false;
  }

  function speakCurrentEn() {
    if (!state.speak) return;
    const item = state.speak.items[state.speak.index];
    if (item) speak(item.sentenceEn);
  }

  // ====================================================
  // 接続状態 UI
  // ====================================================
  function updateConnectionUi() {
    const connectBanner = document.getElementById("connect-banner");
    const pickBanner = document.getElementById("pick-banner");
    const sheetInfo = document.getElementById("sheet-info");
    const sheetError = document.getElementById("sheet-error");
    const statsPanel = document.getElementById("stats-panel");
    const sectionsList = document.getElementById("sections-list");

    const hide = el => { if (el) el.classList.add("hidden"); };
    const show = el => { if (el) el.classList.remove("hidden"); };

    // 初期化：全部隠す
    hide(connectBanner);
    hide(pickBanner);
    hide(sheetInfo);
    hide(sheetError);
    hide(statsPanel);

    if (!state.signedIn) {
      show(connectBanner);
      sectionsList.innerHTML = "";
      document.getElementById("last-updated").textContent = "Google に接続して開始してください";
      return;
    }

    if (!state.spreadsheetId) {
      show(pickBanner);
      sectionsList.innerHTML = "";
      document.getElementById("last-updated").textContent = "シートを選択してください";
      return;
    }

    // シート選択済み → 情報パネルを表示
    show(sheetInfo);
    document.getElementById("sheet-name").textContent =
      state.spreadsheetName || "(名称未取得)";

    const openLink = document.getElementById("sheet-open-link");
    if (state.spreadsheetUrl) {
      openLink.href = state.spreadsheetUrl;
      openLink.classList.remove("hidden");
    } else {
      openLink.classList.add("hidden");
    }

    if (state.loadError) {
      show(sheetError);
      document.getElementById("sheet-error-message").textContent = state.loadError.message;
      sectionsList.innerHTML = "";
      document.getElementById("last-updated").textContent = "シート読み込みエラー";
      showAiCardIfReady();
      showSpeakCardIfReady();
      return;
    }

    show(statsPanel);
    showAiCardIfReady();
    showSpeakCardIfReady();
  }

  async function handleSignIn() {
    try {
      await window.WQAuth.signIn();
      state.signedIn = true;
      updateConnectionUi();

      // 以前選んだシートがあれば自動でロード
      const savedId = lsGet(STORAGE_KEYS.spreadsheetId, "");
      const savedName = lsGet(STORAGE_KEYS.spreadsheetName, "");
      const savedUrl = lsGet(STORAGE_KEYS.spreadsheetUrl, "");
      if (savedId) {
        state.spreadsheetId = savedId;
        state.spreadsheetName = savedName;
        state.spreadsheetUrl = savedUrl;
        await refresh();
      } else {
        updateConnectionUi();
      }
    } catch (err) {
      console.error("signIn failed:", err);
      showError("サインインに失敗しました: " + (err.message || err.type || err));
    }
  }

  async function handlePickSheet() {
    try {
      const file = await window.WQAuth.pickSpreadsheet();
      if (!file) return;  // キャンセル
      state.spreadsheetId = file.id;
      state.spreadsheetName = file.name || "";
      state.spreadsheetUrl = file.url || "";
      state.loadError = null;
      state.autoCreateDeclinedFor = null;
      lsSet(STORAGE_KEYS.spreadsheetId, state.spreadsheetId);
      lsSet(STORAGE_KEYS.spreadsheetName, state.spreadsheetName);
      lsSet(STORAGE_KEYS.spreadsheetUrl, state.spreadsheetUrl);
      await refresh();
    } catch (err) {
      console.error("pickSheet failed:", err);
      showError("シート選択に失敗しました: " + (err.message || err));
    }
  }

  async function handleSignOut() {
    try { await window.WQAuth.signOut(); } catch (e) { /* ignore */ }
    state.signedIn = false;
    state.spreadsheetId = "";
    state.spreadsheetName = "";
    state.spreadsheetUrl = "";
    state.sheetCtx = null;
    state.words = [];
    state.sections = [];
    state.loadError = null;
    state.autoCreateDeclinedFor = null;
    state.sentences = null;
    state.speak = null;
    lsSet(STORAGE_KEYS.spreadsheetId, "");
    lsSet(STORAGE_KEYS.spreadsheetName, "");
    lsSet(STORAGE_KEYS.spreadsheetUrl, "");
    updateConnectionUi();
  }

  // 起動時の自動サインイン試行（前回シートが localStorage にあるときだけ silent）
  async function trySilentSignIn() {
    const savedId = lsGet(STORAGE_KEYS.spreadsheetId, "");
    if (!savedId) return false;
    try {
      await window.WQAuth.getAccessToken();   // 内部で prompt:"" のサイレント取得
      state.signedIn = true;
      state.spreadsheetId = savedId;
      state.spreadsheetName = lsGet(STORAGE_KEYS.spreadsheetName, "");
      state.spreadsheetUrl = lsGet(STORAGE_KEYS.spreadsheetUrl, "");
      return true;
    } catch (e) {
      return false;
    }
  }

  // ====================================================
  // 初期化
  // ====================================================
  async function init() {
    // 旧フォーマット ("001" 文字列) の LocalStorage を number 化
    migrateIdStorageOnce();

    // 音声非対応ならボタン隠し
    if (!speechSupported) {
      document.body.classList.add("no-speech");
    }

    // LocalStorage非対応の通知
    if (!storageAvailable) {
      showError("このブラウザでは一部の学習履歴を端末内に保存できません。");
    }

    // イベントバインド
    document.getElementById("sections-list").addEventListener("click", handleSectionsClick);
    document.getElementById("reload-btn").addEventListener("click", refresh);

    // 接続関連ボタン
    document.getElementById("signin-btn").addEventListener("click", handleSignIn);
    document.getElementById("pick-btn").addEventListener("click", handlePickSheet);
    document.getElementById("change-sheet-btn").addEventListener("click", handlePickSheet);
    document.getElementById("signout-btn").addEventListener("click", handleSignOut);
    document.getElementById("signout-btn-early").addEventListener("click", handleSignOut);

    // シートエラー用ボタン
    document.getElementById("sheet-error-retry").addEventListener("click", refresh);
    document.getElementById("sheet-error-repick").addEventListener("click", handlePickSheet);

    // フォームsubmit & 入力フィールドの活性制御
    document.getElementById("answer-form").addEventListener("submit", e => {
      e.preventDefault();
      submitAnswer();
    });
    document.getElementById("answer-input").addEventListener("input", e => {
      document.getElementById("submit-btn").disabled = !e.target.value.trim();
    });
    document.getElementById("skip-btn").addEventListener("click", skipAnswer);
    document.getElementById("next-btn").addEventListener("click", advanceQuestion);

    document.getElementById("speak-phrase-btn").addEventListener("click", () => {
      if (!state.quiz) return;
      const w = state.quiz.words[state.quiz.index];
      speak(buildBlank(w.word, w.phraseEn).complete);
    });
    document.getElementById("speak-word-btn").addEventListener("click", () => {
      if (!state.quiz) return;
      speak(state.quiz.words[state.quiz.index].word);
    });
    document.getElementById("quiz-back-btn").addEventListener("click", backToHome);
    document.getElementById("summary-back-btn").addEventListener("click", backToHome);

    // AI モーダル関連
    const aiOpenBtn = document.getElementById("ai-open-btn");
    if (aiOpenBtn) aiOpenBtn.addEventListener("click", openAiModal);
    const aiCloseBtn = document.getElementById("ai-close-btn");
    if (aiCloseBtn) aiCloseBtn.addEventListener("click", closeAiModal);
    const aiCancelBtn = document.getElementById("ai-cancel-btn");
    if (aiCancelBtn) aiCancelBtn.addEventListener("click", closeAiModal);
    const aiInputEl = document.getElementById("ai-input");
    if (aiInputEl) aiInputEl.addEventListener("input", aiUpdateInputCount);
    const aiGenerateBtn = document.getElementById("ai-generate-btn");
    if (aiGenerateBtn) aiGenerateBtn.addEventListener("click", () => aiCallGenerate(false));
    const aiRegenBtn = document.getElementById("ai-regenerate-btn");
    if (aiRegenBtn) aiRegenBtn.addEventListener("click", () => aiCallGenerate(true));
    const aiConfirmBtn = document.getElementById("ai-confirm-btn");
    if (aiConfirmBtn) aiConfirmBtn.addEventListener("click", aiConfirm);
    const aiToggleAllBtn = document.getElementById("ai-toggle-all-btn");
    if (aiToggleAllBtn) aiToggleAllBtn.addEventListener("click", () => {
      const anyUnchecked = ai.items.some(it => !it._selected);
      ai.items.forEach(it => { it._selected = anyUnchecked; });
      aiRenderResult();
      aiToggleAllBtn.textContent = anyUnchecked ? "全て解除" : "全て選択";
    });
    const aiSpeakBtn = document.getElementById("ai-speak-btn");
    if (aiSpeakBtn) aiSpeakBtn.addEventListener("click", () => {
      const text = (ai.translation_en || "").trim();
      if (!text) return;
      speak(text);
    });
    // モーダル背景クリックで閉じる
    const aiModal = document.getElementById("ai-modal");
    if (aiModal) aiModal.addEventListener("click", (e) => {
      if (e.target === aiModal) closeAiModal();
    });

    // スピーキング練習モード
    const speakOpenBtn = document.getElementById("speak-open-btn");
    if (speakOpenBtn) speakOpenBtn.addEventListener("click", openSpeakList);
    const speakListBackBtn = document.getElementById("speak-list-back-btn");
    if (speakListBackBtn) speakListBackBtn.addEventListener("click", closeSpeakList);
    const speakList = document.getElementById("speak-list");
    if (speakList) speakList.addEventListener("click", handleSpeakListClick);
    const speakForm = document.getElementById("speak-form");
    if (speakForm) speakForm.addEventListener("submit", (e) => {
      e.preventDefault();
      revealSpeakAnswer();
    });
    const speakNextBtn = document.getElementById("speak-next-btn");
    if (speakNextBtn) speakNextBtn.addEventListener("click", advanceSpeakQuestion);
    const speakSpeakBtn = document.getElementById("speak-speak-btn");
    if (speakSpeakBtn) speakSpeakBtn.addEventListener("click", speakCurrentEn);
    const speakBackBtn = document.getElementById("speak-back-btn");
    if (speakBackBtn) speakBackBtn.addEventListener("click", backFromSpeakToList);
    const speakSummaryBackBtn = document.getElementById("speak-summary-back-btn");
    if (speakSummaryBackBtn) speakSummaryBackBtn.addEventListener("click", backFromSpeakToList);

    // 初期 UI
    updateConnectionUi();

    // 前回シートがあれば silent サインイン → ロード
    const silent = await trySilentSignIn();
    if (silent) {
      await refresh();
    }
  }

  async function refresh() {
    showError("");
    if (!state.signedIn || !state.spreadsheetId) {
      updateConnectionUi();
      return;
    }
    state.sentences = null;  // 再読み込み時は sentence キャッシュも無効化
    const result = await loadWords();
    state.words = result.data;
    state.updatedAt = result.updatedAt;
    state.sections = splitIntoSections(state.words);
    updateConnectionUi();

    // ロードエラー時はエラーパネルが既に出ているのでホームは描画しない
    if (!state.loadError) {
      renderHome();
    }

    // 未送信ログ再送（非同期、結果待たない）
    retryPendingLogs();
  }

  // 起動
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

  // テスト用に一部関数を公開（DevToolsコンソールから呼べる）
  window.__quiz = { buildBlank: buildBlank, state: state };
})();
