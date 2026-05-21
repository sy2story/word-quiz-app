// このファイルは config.js のサンプルです。リポジトリにコミットされる config.js には
// 公開しても安全な値だけを置きます（CLIENT_ID と本番用 API キー）。
//
// 開発時の「制限なし」API キーは別ファイル config.local.js（gitignored）に置きます。
// 詳細は docs/SETUP.md を参照。

window.GOOGLE_CLIENT_ID = "PASTE_YOUR_CLIENT_ID.apps.googleusercontent.com";

window.GOOGLE_API_KEY = "";
window.GOOGLE_API_KEY_PROD = "PASTE_YOUR_PRODUCTION_API_KEY_HERE";

// 「日本語 → AI で単語抽出」機能用の Apps Script ウェブアプリ URL。
// gas/AI_PROXY_SETUP.md の手順でデプロイし、その /exec URL を貼り付けてください。
// 未設定 (空文字) のままだとフロント側で機能ボタンを非表示にします。
window.AI_PROXY_URL = "";
