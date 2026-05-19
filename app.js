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
    loadError: null    // { message, kind: "structure" | "network" | "auth" | "other" }
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

  function getWeakIds() {
    const arr = lsGet(STORAGE_KEYS.weakIds, []);
    return Array.isArray(arr) ? arr : [];
  }

  function setWeakIds(ids) {
    lsSet(STORAGE_KEYS.weakIds, ids);
  }

  function addWeakId(id) {
    const ids = getWeakIds();
    if (!ids.includes(id)) {
      ids.push(id);
      setWeakIds(ids);
    }
  }

  function removeWeakId(id) {
    const ids = getWeakIds().filter(x => x !== id);
    setWeakIds(ids);
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
    document.getElementById("reveal-area").classList.add("hidden");
    document.getElementById("answer-area").classList.add("hidden");

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
      return;
    }

    show(statsPanel);
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
