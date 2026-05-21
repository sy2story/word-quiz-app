// このファイルは Git で追跡されます。秘密ではない値だけを置いてください。
//
//   - GOOGLE_CLIENT_ID: OAuth クライアントID。「承認済み JavaScript 生成元」で
//     ドメインが制限されているので、公開しても他ドメインから悪用できません。
//   - GOOGLE_API_KEY_PROD: 本番（github.io）用の API キー。
//     HTTPリファラ + API 制限がかかっているので公開可。
//   - GOOGLE_API_KEY: ローカル開発用のフォールバック。通常は空のまま。
//     ローカル開発時は config.local.js（gitignored）で上書きします。

window.GOOGLE_CLIENT_ID = "223889567900-4ecs1u9a90ct2n4lm77011co6bbg1f35.apps.googleusercontent.com";

window.GOOGLE_API_KEY_PROD = "AIzaSyC4tg7BAoqUPhKnglk4WYjrLO-bvIKpitg";

// 「日本語 → AI で単語抽出」用の Apps Script Web App URL。
// gas/AI_PROXY_SETUP.md の手順でデプロイ後にここへ /exec URL を貼り付ける。
// 空のままだと AI 機能のボタンは UI 上に出ない (= 既存機能だけで動作)。
window.AI_PROXY_URL = "https://script.google.com/macros/s/AKfycbyi5fAv6FsereCm867ELqKPVuqX6zFukOZ8WVhjHHG_xofyVD5V5gjmVQf4o8cy5fKe-Q/exec";
