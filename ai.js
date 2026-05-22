// 「日本語 → AI で英訳 + 単語抽出」のフロント側クライアント。
// gas/AiProxy.gs にデプロイされた Web App に POST する。
//
// 公開 API:
//   WQAi.isEnabled()              -> AI_PROXY_URL が設定済みか
//   WQAi.cooldownSec()            -> 再生成クールダウン秒数 (15)
//   WQAi.getCooldownRemainingSec() -> クールダウン残秒 (0 ならクリック可)
//   WQAi.getRemaining()           -> 最後に返ってきた残量 (今日の残り回数)、未取得なら null
//   WQAi.generate(text)           -> 生成。{ success, translation_en, items, sentences, remaining }
//                                    sentences: [{ sentence_en, sentence_ja }, ...] スピーキング練習素材
//                                    失敗時: { success:false, error, code }

(function () {
  "use strict";

  const COOLDOWN_SEC = 15;        // (E) クライアント側の再生成クールダウン
  const MAX_INPUT_CHARS = 500;    // サーバと一致させる二重防御

  const state = {
    lastCallAt: 0,        // 最後にサーバから 200 が返った時刻 (Date.now)
    remaining: null,      // サーバが返した今日の残り回数
    inFlight: false       // 多重リクエスト防止 (H)
  };

  function isEnabled() {
    const url = window.AI_PROXY_URL;
    return Boolean(url && typeof url === "string" && url.indexOf("http") === 0);
  }

  function cooldownSec() { return COOLDOWN_SEC; }

  function getCooldownRemainingSec() {
    if (state.lastCallAt === 0) return 0;
    const elapsed = (Date.now() - state.lastCallAt) / 1000;
    const remain = COOLDOWN_SEC - elapsed;
    return remain > 0 ? Math.ceil(remain) : 0;
  }

  function getRemaining() { return state.remaining; }

  async function generate(text) {
    if (!isEnabled()) {
      return { success: false, error: "AI_PROXY_URL が設定されていません。", code: "NOT_CONFIGURED" };
    }
    text = String(text || "").trim();
    if (!text) {
      return { success: false, error: "日本語の文章を入力してください。", code: "EMPTY_INPUT" };
    }
    if (text.length > MAX_INPUT_CHARS) {
      return {
        success: false,
        error: "入力が長すぎます (" + text.length + " / " + MAX_INPUT_CHARS + " 文字)。",
        code: "INPUT_TOO_LONG"
      };
    }
    if (state.inFlight) {
      return { success: false, error: "前のリクエストが処理中です。少しお待ちください。", code: "IN_FLIGHT" };
    }
    if (getCooldownRemainingSec() > 0) {
      return {
        success: false,
        error: "再生成まであと " + getCooldownRemainingSec() + " 秒お待ちください。",
        code: "CLIENT_COOLDOWN"
      };
    }

    let accessToken;
    try {
      accessToken = await window.WQAuth.getAccessToken();
    } catch (err) {
      return { success: false, error: "Googleへのサインインが必要です。", code: "AUTH_REQUIRED" };
    }

    state.inFlight = true;
    try {
      // text/plain で送って preflight を回避する。
      // fetch は body が string のとき自動で Content-Type: text/plain;charset=UTF-8 を付ける。
      const res = await fetch(window.AI_PROXY_URL, {
        method: "POST",
        body: JSON.stringify({ text: text, accessToken: accessToken }),
        redirect: "follow"
      });

      // GAS は HTTP ステータスを操作できないので、payload.success で判定する。
      let json;
      try {
        json = await res.json();
      } catch (e) {
        return {
          success: false,
          error: "サーバーから不正な応答が返りました (HTTP " + res.status + ")。",
          code: "BAD_RESPONSE"
        };
      }

      if (json && json.success === true) {
        state.lastCallAt = Date.now();
        if (typeof json.remaining === "number") state.remaining = json.remaining;
        return {
          success: true,
          translation_en: String(json.translation_en || ""),
          items: Array.isArray(json.items) ? json.items : [],
          sentences: Array.isArray(json.sentences) ? json.sentences : [],
          remaining: state.remaining
        };
      }

      // サーバ側で弾かれた場合
      if (json && typeof json.remaining === "number") state.remaining = json.remaining;
      return {
        success: false,
        error: (json && json.error) || "不明なエラー (HTTP " + res.status + ")。",
        code: (json && json.code) || "UNKNOWN_ERROR",
        remaining: state.remaining
      };

    } catch (err) {
      return {
        success: false,
        error: "通信に失敗しました: " + (err && err.message || err),
        code: "NETWORK_ERROR"
      };
    } finally {
      state.inFlight = false;
    }
  }

  window.WQAi = {
    isEnabled: isEnabled,
    cooldownSec: cooldownSec,
    getCooldownRemainingSec: getCooldownRemainingSec,
    getRemaining: getRemaining,
    generate: generate,
    MAX_INPUT_CHARS: MAX_INPUT_CHARS
  };
})();
