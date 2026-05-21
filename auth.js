// Google Identity Services (GIS) を使ったクライアントサイド OAuth。
// drive.file スコープでアクセストークンを取得し、Sheets API / Picker から
// ユーザー自身のスプレッドシートを読み書きするための土台。
//
// 使い方（コンソール疎通テスト）:
//   await __testSignIn();   // 同意画面 → access_token がログに出れば成功

(function () {
  "use strict";

  // drive.file: ユーザが Picker で選んだスプレッドシートの読み書き
  // userinfo.email: GAS AI プロキシ側で 1 ユーザ単位のレート制限キーとして email を使う
  const SCOPES = "https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/userinfo.email";

  const authState = {
    tokenClient: null,
    accessToken: null,
    expiresAt: 0,
    gisReady: false,
    pendingResolves: [],
    pickerReady: false,
    pickerLoading: null
  };

  // ----------------------------------------------------
  // GIS スクリプトのロード完了を待つ
  // ----------------------------------------------------
  function whenGisReady() {
    if (authState.gisReady) return Promise.resolve();
    return new Promise(resolve => {
      authState.pendingResolves.push(resolve);
    });
  }

  function markGisReady() {
    authState.gisReady = true;
    authState.pendingResolves.splice(0).forEach(fn => fn());
  }

  function pollGisReady() {
    if (window.google && window.google.accounts && window.google.accounts.oauth2) {
      initTokenClient();
      markGisReady();
      return;
    }
    setTimeout(pollGisReady, 50);
  }

  function initTokenClient() {
    if (authState.tokenClient) return;

    const clientId = window.GOOGLE_CLIENT_ID;
    if (!clientId || clientId.startsWith("PASTE_")) {
      console.warn("[auth] GOOGLE_CLIENT_ID is not configured. Edit config.js.");
      return;
    }

    authState.tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope: SCOPES,
      callback: () => {}  // requestAccessToken 呼び出し時に上書きする
    });
  }

  // ----------------------------------------------------
  // サインイン / トークン取得
  // ----------------------------------------------------
  function requestToken(options) {
    options = options || {};
    return whenGisReady().then(() => new Promise((resolve, reject) => {
      if (!authState.tokenClient) {
        return reject(new Error("Token client is not initialized. Check GOOGLE_CLIENT_ID."));
      }

      authState.tokenClient.callback = (resp) => {
        if (resp.error) return reject(resp);
        authState.accessToken = resp.access_token;
        // expires_in は秒。30秒余裕を持って失効判定する
        authState.expiresAt = Date.now() + (Number(resp.expires_in || 3600) - 30) * 1000;
        resolve(resp.access_token);
      };

      const prompt = options.silent ? "" : "consent";
      authState.tokenClient.requestAccessToken({ prompt: prompt });
    }));
  }

  function signIn() {
    return requestToken({ silent: false });
  }

  function signOut() {
    return whenGisReady().then(() => new Promise(resolve => {
      if (!authState.accessToken) return resolve();
      google.accounts.oauth2.revoke(authState.accessToken, () => {
        authState.accessToken = null;
        authState.expiresAt = 0;
        resolve();
      });
    }));
  }

  // 失効時はサイレント再取得を試みる
  function getAccessToken() {
    if (authState.accessToken && Date.now() < authState.expiresAt) {
      return Promise.resolve(authState.accessToken);
    }
    return requestToken({ silent: true });
  }

  function isSignedIn() {
    return Boolean(authState.accessToken) && Date.now() < authState.expiresAt;
  }

  // ----------------------------------------------------
  // Google Picker（スプレッドシート選択ダイアログ）
  // ----------------------------------------------------
  function loadPicker() {
    if (authState.pickerReady) return Promise.resolve();
    if (authState.pickerLoading) return authState.pickerLoading;

    authState.pickerLoading = new Promise((resolve, reject) => {
      const waitGapi = () => {
        if (window.gapi && typeof window.gapi.load === "function") {
          gapi.load("picker", {
            callback: () => {
              authState.pickerReady = true;
              resolve();
            },
            onerror: reject
          });
        } else {
          setTimeout(waitGapi, 50);
        }
      };
      waitGapi();
    });

    return authState.pickerLoading;
  }

  // app_id（プロジェクト番号）を client_id 先頭から抽出
  function deriveAppId() {
    const cid = String(window.GOOGLE_CLIENT_ID || "");
    const m = cid.match(/^(\d+)-/);
    return m ? m[1] : "";
  }

  function resolveApiKey() {
    const isProd = location.hostname.endsWith("github.io");
    if (isProd) {
      const prod = window.GOOGLE_API_KEY_PROD;
      if (prod && !prod.startsWith("PASTE_")) return prod;
      // 本番フォールバック（PROD が未設定なら dev を試す）
      return window.GOOGLE_API_KEY;
    }
    // ローカル開発: 通常 config.local.js から注入される
    const dev = window.GOOGLE_API_KEY;
    if (!dev) {
      console.warn(
        "[auth] GOOGLE_API_KEY が未設定です。" +
        "ローカル開発用 API キーを config.local.js に設定してください " +
        "（テンプレ: config.local.sample.js）。"
      );
    }
    return dev;
  }

  function pickSpreadsheet() {
    return Promise.all([getAccessToken(), loadPicker()]).then(([token]) => {
      return new Promise((resolve, reject) => {
        const apiKey = resolveApiKey();
        if (!apiKey || apiKey.startsWith("PASTE_")) {
          return reject(new Error("API key is not configured for this environment."));
        }

        const view = new google.picker.View(google.picker.ViewId.SPREADSHEETS);
        view.setMimeTypes("application/vnd.google-apps.spreadsheet");

        const picker = new google.picker.PickerBuilder()
          .setAppId(deriveAppId())
          .setOAuthToken(token)
          .setDeveloperKey(apiKey)
          .addView(view)
          .setCallback((data) => {
            const action = data[google.picker.Response.ACTION];
            if (action === google.picker.Action.PICKED) {
              const doc = data[google.picker.Response.DOCUMENTS][0];
              resolve({
                id: doc[google.picker.Document.ID],
                name: doc[google.picker.Document.NAME],
                url: doc[google.picker.Document.URL]
              });
            } else if (action === google.picker.Action.CANCEL) {
              resolve(null);
            }
          })
          .build();
        picker.setVisible(true);
      });
    });
  }

  // ----------------------------------------------------
  // 公開 API
  // ----------------------------------------------------
  window.WQAuth = {
    signIn: signIn,
    signOut: signOut,
    getAccessToken: getAccessToken,
    isSignedIn: isSignedIn,
    whenReady: whenGisReady,
    pickSpreadsheet: pickSpreadsheet
  };

  // 疎通テスト用（PoC 完了後に削除可）
  window.__testSignIn = function () {
    return signIn().then(token => {
      console.log("[auth] ✅ access_token (先頭20文字):", token.slice(0, 20) + "...");
      console.log("[auth] 有効期限:", new Date(authState.expiresAt).toLocaleString());
      return token;
    }).catch(err => {
      console.error("[auth] ❌ sign-in failed:", err);
      throw err;
    });
  };

  window.__testPicker = function () {
    return pickSpreadsheet().then(file => {
      if (!file) return console.log("[picker] cancelled.");
      console.log("[picker] ✅ picked:", file);
      return file;
    }).catch(err => {
      console.error("[picker] ❌ failed:", err);
      throw err;
    });
  };

  // GIS スクリプトのロード完了を待ち始める
  pollGisReady();
})();
