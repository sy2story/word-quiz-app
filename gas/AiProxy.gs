// 英単語クイズアプリ用 AI プロキシ (Google Apps Script)
//
// 役割:
//   フロント (GitHub Pages) から日本語の文章を受け取り、
//   Gemini 3.1 Flash Lite で「英訳 + 学習価値の高い語彙抽出」を構造化 JSON で返す。
//
// セキュリティ:
//   - フロントが送ってきた Google access_token を tokeninfo で検証し、
//     aud が EXPECTED_CLIENT_ID と一致するアプリ発行のトークンのみ受理する。
//   - 1 ユーザー (email) あたり 1 日 DAILY_LIMIT_PER_USER 回までのレート制限を
//     PropertiesService で管理する。
//
// デプロイ手順は gas/AI_PROXY_SETUP.md を参照。
//
// 必要なスクリプトプロパティ (PropertiesService):
//   - GEMINI_API_KEY        : Google AI Studio で発行した Gemini API キー
//   - EXPECTED_CLIENT_ID    : フロントが使う OAuth クライアント ID (auth.js の GOOGLE_CLIENT_ID と同じ値)

// 多層防御の各上限。検証手順 (gas/AI_PROXY_SETUP.md) に従って一時的に下げて E2E 確認可能。
const DAILY_LIMIT_PER_USER  = 3;     // (A) 1 ユーザ / 1 日
const GLOBAL_DAILY_LIMIT    = 1000;  // (C) 全ユーザ合計 / 1 日 (Gemini 無料枠 1,500/日 に 500 バッファ)
const SAME_TEXT_COOLDOWN_SEC = 30;   // (D) 同一テキストを 30 秒以内に再送ったらブロック
const MAX_INPUT_CHARS = 500;
const LOCK_TIMEOUT_MS = 3000;
const GEMINI_MODEL = "gemini-3.1-flash-lite";

// TTS (英語音声ダウンロード) 用。翻訳とは別枠でコストを管理する。
const GEMINI_TTS_MODEL = "gemini-2.5-flash-preview-tts";
// フロントは voice = "female" / "male" を送る。サーバ側で許可リストの声に解決する
// (任意の voiceName 注入を防ぐ)。30 種から選択可: Zephyr/Puck/Kore/Aoede/Orus ...
const TTS_VOICES = { female: "Aoede", male: "Orus" };
const TTS_DEFAULT_VOICE = "female";
const DAILY_TTS_LIMIT_PER_USER = 3;       // (A') 1 ユーザ / 1 日
const GLOBAL_TTS_DAILY_LIMIT = 300;       // (C') 全ユーザ合計 / 1 日
const MAX_TTS_CHARS = 2000;               // TTS の入力上限 (英訳本文)

// ------------------------------------------------------------
// エントリポイント
// ------------------------------------------------------------
function doGet() {
  // 疎通確認用。デプロイ後にブラウザで /exec を開くと {ok:true} が返る。
  return jsonResponse({ ok: true, service: "wordbook-quiz-ai-proxy" });
}

function doPost(e) {
  try {
    const payload = JSON.parse((e && e.postData && e.postData.contents) || "{}");
    const accessToken = String(payload.accessToken || "").trim();
    const text = String(payload.text || "").trim();
    const action = String(payload.action || "").trim();

    if (!accessToken) {
      return jsonResponse({ success: false, error: "accessToken is required." });
    }
    if (!text) {
      return jsonResponse({ success: false, error: "text is required." });
    }

    // 英語音声ダウンロード (TTS)。翻訳とは入力上限・クォータが別。
    if (action === "tts") {
      return handleTts(accessToken, text, payload.voice);
    }

    if (text.length > MAX_INPUT_CHARS) {
      return jsonResponse({
        success: false,
        error: "入力が長すぎます (" + text.length + " / " + MAX_INPUT_CHARS + " 文字)。"
      });
    }

    const auth = verifyAccessToken(accessToken);
    if (!auth.ok) {
      return jsonResponse({ success: false, error: auth.error, code: "AUTH_FAILED" });
    }

    const gate = enforceRateLimits(auth.email, text);
    if (!gate.ok) {
      return jsonResponse({
        success: false,
        error: gate.error,
        code: gate.code || "QUOTA_EXCEEDED",
        remaining: gate.remaining != null ? gate.remaining : 0
      });
    }

    const result = callGemini(text);
    if (!result.ok) {
      // 失敗時は (A)(C) のカウンタは返金、(D) は連打抑止のため意図的に残す
      refundRateLimits(auth.email);
      return jsonResponse({ success: false, error: result.error, code: "AI_FAILED" });
    }

    return jsonResponse({
      success: true,
      translation_en: result.data.translation_en,
      items: result.data.items,
      sentences: result.data.sentences || [],
      remaining: gate.remaining
    });

  } catch (err) {
    return jsonResponse({
      success: false,
      error: "internal error: " + (err && err.message || String(err))
    });
  }
}

function jsonResponse(payload) {
  return ContentService
    .createTextOutput(JSON.stringify(payload))
    .setMimeType(ContentService.MimeType.JSON);
}

// ------------------------------------------------------------
// アクセストークンの検証
// ------------------------------------------------------------
function verifyAccessToken(token) {
  const expectedAud = PropertiesService.getScriptProperties().getProperty("EXPECTED_CLIENT_ID");
  if (!expectedAud) {
    return { ok: false, error: "サーバー側で EXPECTED_CLIENT_ID が未設定です。" };
  }

  try {
    const res = UrlFetchApp.fetch(
      "https://oauth2.googleapis.com/tokeninfo?access_token=" + encodeURIComponent(token),
      { method: "get", muteHttpExceptions: true }
    );
    if (res.getResponseCode() !== 200) {
      return { ok: false, error: "アクセストークンが無効です。サインインし直してください。" };
    }
    const info = JSON.parse(res.getContentText());
    if (info.aud !== expectedAud) {
      return { ok: false, error: "このサーバーは別アプリのトークンを受け付けません。" };
    }
    if (!info.email) {
      return { ok: false, error: "トークンに email スコープが含まれていません。" };
    }
    return { ok: true, email: String(info.email).toLowerCase() };
  } catch (err) {
    return { ok: false, error: "tokeninfo 呼び出しに失敗しました: " + (err && err.message || err) };
  }
}

// ------------------------------------------------------------
// 多層レート制限 (D)→(C)→(A) の順にチェックし、全成功時のみカウンタを増分
// ------------------------------------------------------------
function todayStr() {
  const tz = Session.getScriptTimeZone() || "Asia/Tokyo";
  return Utilities.formatDate(new Date(), tz, "yyyyMMdd");
}

function userQuotaKey(email)  { return "quota_"  + todayStr() + "_" + email; }
function globalQuotaKey()     { return "global_" + todayStr(); }
function sameTextKey(email)   { return "last_"   + email; }

function shortHash(text) {
  // SHA-256 の先頭 16 hex 文字 (= 64bit) を fingerprint として使う。衝突確率は実用上無視できる
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, text, Utilities.Charset.UTF_8);
  let hex = "";
  for (let i = 0; i < 8; i++) {
    const b = bytes[i] & 0xff;
    hex += (b < 16 ? "0" : "") + b.toString(16);
  }
  return hex;
}

function enforceRateLimits(email, text) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(LOCK_TIMEOUT_MS)) {
    return { ok: false, error: "サーバーが混雑しています。少し時間をおいて試してください。", code: "BUSY" };
  }
  try {
    const props = PropertiesService.getScriptProperties();
    const now = Date.now();
    const hash = shortHash(text);

    // (D) 同一テキスト 30 秒クールダウン
    const lastRaw = props.getProperty(sameTextKey(email));
    if (lastRaw) {
      try {
        const last = JSON.parse(lastRaw);
        if (last && last.hash === hash && (now - last.ts) < SAME_TEXT_COOLDOWN_SEC * 1000) {
          const wait = Math.ceil((SAME_TEXT_COOLDOWN_SEC * 1000 - (now - last.ts)) / 1000);
          return {
            ok: false,
            error: "同じ文章の再生成は " + SAME_TEXT_COOLDOWN_SEC + " 秒お待ちください (あと " + wait + " 秒)。",
            code: "SAME_TEXT_COOLDOWN"
          };
        }
      } catch (e) { /* malformed, ignore */ }
    }

    // (C) 全体日次上限
    const globalCurrent = parseInt(props.getProperty(globalQuotaKey()) || "0", 10);
    if (globalCurrent >= GLOBAL_DAILY_LIMIT) {
      return {
        ok: false,
        error: "本日のサービス全体の利用上限に達しました。明日また使ってください。",
        code: "GLOBAL_QUOTA_EXCEEDED"
      };
    }

    // (A) ユーザ日次上限
    const userCurrent = parseInt(props.getProperty(userQuotaKey(email)) || "0", 10);
    if (userCurrent >= DAILY_LIMIT_PER_USER) {
      return {
        ok: false,
        error: "今日の利用上限 (" + DAILY_LIMIT_PER_USER + " 回) に達しました。明日また使ってください。",
        code: "QUOTA_EXCEEDED",
        remaining: 0
      };
    }

    // 全成功 → 増分
    props.setProperty(userQuotaKey(email),  String(userCurrent + 1));
    props.setProperty(globalQuotaKey(),     String(globalCurrent + 1));
    props.setProperty(sameTextKey(email),   JSON.stringify({ hash: hash, ts: now }));

    return { ok: true, remaining: DAILY_LIMIT_PER_USER - (userCurrent + 1) };
  } finally {
    try { lock.releaseLock(); } catch (e) {}
  }
}

function refundRateLimits(email) {
  // (A)(C) を返金。(D) は連打抑止のためそのまま残す。
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(LOCK_TIMEOUT_MS)) return;
  try {
    const props = PropertiesService.getScriptProperties();
    const userKey = userQuotaKey(email);
    const userCurrent = parseInt(props.getProperty(userKey) || "0", 10);
    if (userCurrent > 0) props.setProperty(userKey, String(userCurrent - 1));

    const globalKey = globalQuotaKey();
    const globalCurrent = parseInt(props.getProperty(globalKey) || "0", 10);
    if (globalCurrent > 0) props.setProperty(globalKey, String(globalCurrent - 1));
  } finally {
    try { lock.releaseLock(); } catch (e) {}
  }
}

// ------------------------------------------------------------
// TTS (英語音声ダウンロード)
// ------------------------------------------------------------
function handleTts(accessToken, text, voice) {
  if (text.length > MAX_TTS_CHARS) {
    return jsonResponse({
      success: false,
      error: "音声化するテキストが長すぎます (" + text.length + " / " + MAX_TTS_CHARS + " 文字)。",
      code: "INPUT_TOO_LONG"
    });
  }

  // voice は許可リスト ("female"/"male") のみ受理。未知の値は既定にフォールバック。
  const voiceKey = TTS_VOICES[String(voice || "")] ? String(voice) : TTS_DEFAULT_VOICE;
  const voiceName = TTS_VOICES[voiceKey];

  const auth = verifyAccessToken(accessToken);
  if (!auth.ok) {
    return jsonResponse({ success: false, error: auth.error, code: "AUTH_FAILED" });
  }

  const gate = enforceTtsLimit(auth.email);
  if (!gate.ok) {
    return jsonResponse({
      success: false,
      error: gate.error,
      code: gate.code || "QUOTA_EXCEEDED",
      remaining: gate.remaining != null ? gate.remaining : 0
    });
  }

  const result = callGeminiTts(text, voiceName);
  if (!result.ok) {
    refundTtsLimit(auth.email);   // 失敗時はカウンタ返金
    return jsonResponse({ success: false, error: result.error, code: "TTS_FAILED" });
  }

  return jsonResponse({
    success: true,
    audioBase64: result.audioBase64,
    mimeType: result.mimeType,
    sampleRate: result.sampleRate,
    remaining: gate.remaining
  });
}

function ttsUserQuotaKey(email)  { return "ttsquota_"  + todayStr() + "_" + email; }
function ttsGlobalQuotaKey()     { return "ttsglobal_" + todayStr(); }

function enforceTtsLimit(email) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(LOCK_TIMEOUT_MS)) {
    return { ok: false, error: "サーバーが混雑しています。少し時間をおいて試してください。", code: "BUSY" };
  }
  try {
    const props = PropertiesService.getScriptProperties();

    // (C') 全体日次上限
    const globalCurrent = parseInt(props.getProperty(ttsGlobalQuotaKey()) || "0", 10);
    if (globalCurrent >= GLOBAL_TTS_DAILY_LIMIT) {
      return {
        ok: false,
        error: "本日の音声生成は全体の上限に達しました。明日また試してください。",
        code: "GLOBAL_QUOTA_EXCEEDED"
      };
    }

    // (A') ユーザ日次上限
    const userCurrent = parseInt(props.getProperty(ttsUserQuotaKey(email)) || "0", 10);
    if (userCurrent >= DAILY_TTS_LIMIT_PER_USER) {
      return {
        ok: false,
        error: "今日の音声ダウンロード上限 (" + DAILY_TTS_LIMIT_PER_USER + " 回) に達しました。明日また試してください。",
        code: "QUOTA_EXCEEDED",
        remaining: 0
      };
    }

    props.setProperty(ttsUserQuotaKey(email), String(userCurrent + 1));
    props.setProperty(ttsGlobalQuotaKey(),    String(globalCurrent + 1));

    return { ok: true, remaining: DAILY_TTS_LIMIT_PER_USER - (userCurrent + 1) };
  } finally {
    try { lock.releaseLock(); } catch (e) {}
  }
}

function refundTtsLimit(email) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(LOCK_TIMEOUT_MS)) return;
  try {
    const props = PropertiesService.getScriptProperties();
    const userKey = ttsUserQuotaKey(email);
    const userCurrent = parseInt(props.getProperty(userKey) || "0", 10);
    if (userCurrent > 0) props.setProperty(userKey, String(userCurrent - 1));

    const globalKey = ttsGlobalQuotaKey();
    const globalCurrent = parseInt(props.getProperty(globalKey) || "0", 10);
    if (globalCurrent > 0) props.setProperty(globalKey, String(globalCurrent - 1));
  } finally {
    try { lock.releaseLock(); } catch (e) {}
  }
}

// Gemini 2.5 Flash TTS を呼び、生 PCM (16bit/24kHz/mono) を base64 で返す。
// voiceName は解決済みの音声名 (例 "Aoede"/"Orus")。
// 戻り値: { ok:true, audioBase64, mimeType, sampleRate } | { ok:false, error }
function callGeminiTts(text, voiceName) {
  const apiKey = PropertiesService.getScriptProperties().getProperty("GEMINI_API_KEY");
  if (!apiKey) {
    return { ok: false, error: "サーバー側で GEMINI_API_KEY が未設定です。" };
  }
  const voice = voiceName || TTS_VOICES[TTS_DEFAULT_VOICE];

  // スタイル指示はテキスト先頭に自然言語で付与する (Gemini TTS の流儀)。
  const prompt =
    "Read the following diary entry in natural American English, " +
    "with rich emotional expression:\n\n" + text;

  const body = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      responseModalities: ["AUDIO"],
      speechConfig: {
        voiceConfig: {
          prebuiltVoiceConfig: { voiceName: voice }
        }
      }
    }
  };

  const url = "https://generativelanguage.googleapis.com/v1beta/models/" +
    encodeURIComponent(GEMINI_TTS_MODEL) + ":generateContent?key=" + encodeURIComponent(apiKey);

  try {
    const res = UrlFetchApp.fetch(url, {
      method: "post",
      contentType: "application/json",
      payload: JSON.stringify(body),
      muteHttpExceptions: true
    });
    const code = res.getResponseCode();
    const bodyText = res.getContentText();
    if (code !== 200) {
      return { ok: false, error: "Gemini TTS API error (HTTP " + code + "): " + bodyText.slice(0, 400) };
    }
    const json = JSON.parse(bodyText);
    const part = json &&
      json.candidates && json.candidates[0] &&
      json.candidates[0].content && json.candidates[0].content.parts &&
      json.candidates[0].content.parts[0];
    const inline = part && part.inlineData;
    if (!inline || !inline.data) {
      return { ok: false, error: "Gemini TTS の応答に音声データが含まれていません。" };
    }

    // mimeType 例: "audio/L16;codec=pcm;rate=24000"
    const mimeType = String(inline.mimeType || "audio/L16;rate=24000");
    const m = mimeType.match(/rate=(\d+)/);
    const sampleRate = m ? parseInt(m[1], 10) : 24000;

    return {
      ok: true,
      audioBase64: inline.data,   // base64 の生 PCM (16bit LE / mono)
      mimeType: mimeType,
      sampleRate: sampleRate
    };
  } catch (err) {
    return { ok: false, error: "Gemini TTS call failed: " + (err && err.message || err) };
  }
}

// ------------------------------------------------------------
// Gemini 呼び出し (英訳 + 語彙抽出 を 1 リクエストで)
// ------------------------------------------------------------
function callGemini(text) {
  const apiKey = PropertiesService.getScriptProperties().getProperty("GEMINI_API_KEY");
  if (!apiKey) {
    return { ok: false, error: "サーバー側で GEMINI_API_KEY が未設定です。" };
  }

  const schema = {
    type: "object",
    properties: {
      translation_en: {
        type: "string",
        description: "入力された日本語全文の自然な英訳。"
      },
      items: {
        type: "array",
        description: "英訳の中から英語学習者にとって学ぶ価値の高い語彙 5〜15 個。",
        items: {
          type: "object",
          properties: {
            word:       { type: "string", description: "見出し語 (英語・小文字・1語)。" },
            meaning_ja: { type: "string", description: "文脈に合う簡潔な日本語訳。" },
            phrase_en:  { type: "string", description: "その単語を含む 2〜6 語程度の自然な英語フレーズ。" },
            phrase_ja:  { type: "string", description: "phrase_en の日本語訳。" },
            example_en: { type: "string", description: "その単語を使った完結した英語の例文 1 文。" },
            example_ja: { type: "string", description: "example_en の日本語訳 1 文。" }
          },
          required: ["word", "meaning_ja", "phrase_en", "phrase_ja"]
        }
      },
      sentences: {
        type: "array",
        description: "translation_en を意味のまとまりで文単位に分割した対訳ペア。1 ペア = 独立した 1 文。スピーキング練習素材として使う。",
        items: {
          type: "object",
          properties: {
            sentence_en: { type: "string", description: "translation_en 内の 1 文。表現は translation_en と揃える。" },
            sentence_ja: { type: "string", description: "sentence_en に対応する自然な日本語訳 1 文。" }
          },
          required: ["sentence_en", "sentence_ja"]
        }
      }
    },
    required: ["translation_en", "items", "sentences"]
  };

  const prompt =
    "次の日本語の文章を、まず自然な英語に翻訳してください。\n" +
    "その上で、英訳の中から英語学習者にとって学ぶ価値の高い語彙・フレーズを 5〜15 個抽出し、構造化して返してください。\n" +
    "さらに、英訳をスピーキング練習用に文単位の対訳ペアへ分割してください。\n\n" +
    "語彙抽出ルール:\n" +
    "- word は 1 単語の見出し語 (小文字)。固有名詞・数字・極めて基本的すぎる語 (the/is/and など) は避ける。\n" +
    "- phrase_en はその単語を含む短い自然な英語フレーズ (2〜6 語程度、文ではなく句)。\n" +
    "- example_en / example_ja は文として完結する 1 文ずつ。\n" +
    "- meaning_ja は文脈に合う簡潔な日本語訳。\n" +
    "- 重複する見出し語は出さない。\n\n" +
    "文分割ルール (sentences):\n" +
    "- translation_en を意味のまとまりで文単位に分割し、各文に対応する自然な日本語訳を付ける。\n" +
    "- 1 ペア = 独立した 1 文。複文の従属節を更に分割しない。\n" +
    "- 各 sentence_en は最低 3 語以上の独立した文単位とし、極端に短い断片は隣接文と統合する。\n" +
    "- 日本語と英語は 1:1 で対応させ、片方を空にしない。\n" +
    "- sentence_en の表現は translation_en の表現と揃える (語句の言い換えや要約はしない)。\n\n" +
    "入力:\n" + text;

  const body = {
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema: schema,
      temperature: 0.2,
      maxOutputTokens: 4096
    }
  };

  const url = "https://generativelanguage.googleapis.com/v1beta/models/" +
    encodeURIComponent(GEMINI_MODEL) + ":generateContent?key=" + encodeURIComponent(apiKey);

  try {
    const res = UrlFetchApp.fetch(url, {
      method: "post",
      contentType: "application/json",
      payload: JSON.stringify(body),
      muteHttpExceptions: true
    });
    const code = res.getResponseCode();
    const bodyText = res.getContentText();
    if (code !== 200) {
      return { ok: false, error: "Gemini API error (HTTP " + code + "): " + bodyText.slice(0, 400) };
    }
    const json = JSON.parse(bodyText);
    const partText = json &&
      json.candidates && json.candidates[0] &&
      json.candidates[0].content && json.candidates[0].content.parts &&
      json.candidates[0].content.parts[0] && json.candidates[0].content.parts[0].text;
    if (!partText) {
      return { ok: false, error: "Gemini からの応答が空でした。" };
    }
    let data;
    try {
      data = JSON.parse(partText);
    } catch (parseErr) {
      return { ok: false, error: "Gemini が JSON 形式で返しませんでした: " + partText.slice(0, 200) };
    }

    const seen = {};
    const items = (data.items || []).filter(function (it) {
      if (!it || !it.word) return false;
      const k = String(it.word).trim().toLowerCase();
      if (!k || seen[k]) return false;
      seen[k] = true;
      it.word = k;
      it.meaning_ja = String(it.meaning_ja || "").trim();
      it.phrase_en  = String(it.phrase_en  || "").trim();
      it.phrase_ja  = String(it.phrase_ja  || "").trim();
      it.example_en = String(it.example_en || "").trim();
      it.example_ja = String(it.example_ja || "").trim();
      return Boolean(it.meaning_ja && it.phrase_en && it.phrase_ja);
    });

    const sentences = (data.sentences || []).map(function (s) {
      return {
        sentence_en: String((s && s.sentence_en) || "").trim(),
        sentence_ja: String((s && s.sentence_ja) || "").trim()
      };
    }).filter(function (s) {
      return s.sentence_en && s.sentence_ja;
    });

    return {
      ok: true,
      data: {
        translation_en: String(data.translation_en || "").trim(),
        items: items,
        sentences: sentences
      }
    };
  } catch (err) {
    return { ok: false, error: "Gemini call failed: " + (err && err.message || err) };
  }
}

// ------------------------------------------------------------
// セットアップ補助 (エディタから手動で 1 度だけ実行する)
// ------------------------------------------------------------
function setupSecrets_GEMINI_API_KEY() {
  // ↓ 値を貼り付けてから 1 度だけこの関数を実行 → 直後に値を消して保存。
  const value = "PASTE_YOUR_GEMINI_API_KEY";
  if (value.indexOf("PASTE_") === 0) throw new Error("値を貼り付けてから実行してください。");
  PropertiesService.getScriptProperties().setProperty("GEMINI_API_KEY", value);
}

function setupSecrets_EXPECTED_CLIENT_ID() {
  // ↓ フロントの config.js / GOOGLE_CLIENT_ID と同じ値を貼り付けて 1 度だけ実行 → 直後に値を消す。
  const value = "PASTE_YOUR_OAUTH_CLIENT_ID.apps.googleusercontent.com";
  if (value.indexOf("PASTE_") === 0) throw new Error("値を貼り付けてから実行してください。");
  PropertiesService.getScriptProperties().setProperty("EXPECTED_CLIENT_ID", value);
}

// エディタからの動作テスト用 (1 回 quota を消費する)
function testGeminiOnly() {
  const r = callGemini("退院日を延期したい。腫れがまだ引いていないので、医師に処方箋を書いてもらった。");
  Logger.log(JSON.stringify(r, null, 2));
}
