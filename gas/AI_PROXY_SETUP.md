# AI プロキシ (gas/AiProxy.gs) デプロイ手順

「日本語の文章を貼り付け→AI で英訳+語彙抽出→スプレッドシートに自動追加」機能のための
Google Apps Script Web App のセットアップ手順。

## 前提

- フロント側で既に OAuth クライアント ID を発行済み (`config.js` の `GOOGLE_CLIENT_ID`)
- Google AI Studio で Gemini API キーを発行できる Google アカウントを持っている
- このスクリプトは **既存の `gas/Code.gs` が動いていた Apps Script プロジェクトとは別のプロジェクト**
  として作る (役割が違うため、独立した URL でデプロイする)

## 手順

### 1. Gemini API キーを取得

1. <https://aistudio.google.com/apikey> にアクセス
2. 「Create API key」→ Google Cloud プロジェクトを選択 (新規でも可)
3. 発行された `AIzaSy...` で始まるキーをコピー (= `GEMINI_API_KEY`)

無料枠: Gemini 2.0 Flash で 1 日 1,500 リクエスト / 1 分 10 リクエスト。本アプリの上限は十分に内側。

### 2. Apps Script プロジェクトを新規作成

1. <https://script.google.com/> を開く → 「新しいプロジェクト」
2. プロジェクト名を `wordbook-quiz-ai-proxy` などに変更
3. デフォルトの `Code.gs` を全削除し、リポジトリの [`gas/AiProxy.gs`](./AiProxy.gs) の中身を貼り付ける
4. 保存 (Ctrl/⌘+S)

### 3. スクリプトプロパティを設定

エディタ左メニューの「プロジェクトの設定」(歯車アイコン) → 「スクリプト プロパティ」→ 「スクリプト プロパティを追加」を 2 回。

| プロパティ | 値 |
|---|---|
| `GEMINI_API_KEY` | 手順 1 で取得した `AIzaSy...` |
| `EXPECTED_CLIENT_ID` | フロントの `config.js` の `window.GOOGLE_CLIENT_ID` と完全一致する値 (`xxxxx-yyyy.apps.googleusercontent.com`) |

> `EXPECTED_CLIENT_ID` が違うと、フロントから送られたトークンが拒否されて全リクエストが 401 相当になる。

### 4. 動作確認 (デプロイ前)

エディタ上部の関数選択プルダウンで `testGeminiOnly` を選び、▶ 実行。
初回は OAuth 同意 (このスクリプトが UrlFetch を使う権限) を求められる → 許可。
実行ログに `{ ok: true, data: { translation_en: "...", items: [...], sentences: [...] } }` が出れば疎通成功。
`sentences` はスピーキング練習用の対訳ペア配列 (`{sentence_en, sentence_ja}`)。
件数 0 が続く場合はプロンプト調整を検討。

### 5. ウェブアプリとしてデプロイ

1. 右上 「デプロイ」 → 「新しいデプロイ」
2. 「種類を選択」(歯車) → **ウェブアプリ**
3. 設定:
   - 説明: `v1`
   - 実行ユーザー: **自分** (= Gemini を呼ぶのは自分の API キー)
   - アクセスできるユーザー: **全員** (= サインインしたユーザのトークンを GAS 内で検証する)
4. 「デプロイ」 → 同意確認 → 完了
5. 表示された **ウェブアプリの URL** (`https://script.google.com/macros/s/.../exec`) をコピー

### 6. 疎通確認 (デプロイ後)

ブラウザで `/exec` URL を開く → `{"ok":true,"service":"wordbook-quiz-ai-proxy"}` が返ればOK。

### 7. フロントに URL を設定

`config.js` に以下を追記 (このリポジトリでは `config.js` は **git で追跡** しています。
GitHub Pages から本番配信するために必要なため):

```js
window.AI_PROXY_URL = "https://script.google.com/macros/s/XXXXXXXX/exec";
```

> **公開しても安全な理由**: GAS 側で OAuth トークンの `aud` を `EXPECTED_CLIENT_ID` と照合しているため、
> URL を知っている第三者がこのアプリ以外から叩いても 401 で弾かれます。
> ローカル開発専用の値を入れたい場合は別途 `config.local.js` (gitignored) を使ってください。

## 更新時の注意

- コードを変更したら **「デプロイを管理」→ 編集→ バージョン: 新しいバージョン → デプロイ** で URL を更新
  (URL は固定のまま新バージョンが反映される)
- もし「新しいデプロイ」をしてしまうと URL が変わるので注意

### スピーキング練習機能 (sentences) を有効化したいとき

フロントの「スピーキング練習」モードを使うには、AI レスポンスに `sentences` フィールドが含まれている必要がある。
リポジトリの `gas/AiProxy.gs` をエディタにコピー → 既存のコードを置き換え → 上の手順で再デプロイ。
旧バージョンのまま運用しても日記投稿は引き続き動作するが、sentence シートには 1 行も追加されなくなる
(クライアントは `sentences` を任意フィールドとして扱う)。

## レート制限のチューニング

`gas/AiProxy.gs` 冒頭の以下を編集して再デプロイ:

```js
const DAILY_LIMIT_PER_USER  = 3;     // 1 ユーザの 1 日あたり API 呼び出し数
const GLOBAL_DAILY_LIMIT    = 1000;  // サービス全体の 1 日あたり上限 (Gemini 無料枠 1,500 の内側)
const SAME_TEXT_COOLDOWN_SEC = 30;   // 同一テキストの再生成までのインターバル
const MAX_INPUT_CHARS       = 500;   // 日本語入力の最大文字数
```

検証時に一時的に `DAILY_LIMIT_PER_USER = 2` などへ下げて E2E 確認 → 終わったら元に戻す。

## トラブルシューティング

| 症状 | 原因 / 対処 |
|---|---|
| `EXPECTED_CLIENT_ID is not configured` | 手順 3 を実施。値はフロントの client ID と完全一致 |
| `GEMINI_API_KEY is not configured` | 手順 3 を実施 |
| `Token audience mismatch` | `EXPECTED_CLIENT_ID` がフロントの client ID と違う |
| `Gemini API error (HTTP 429)` | Gemini 無料枠を超過。1 分待つか翌日まで待つ |
| `Gemini API error (HTTP 400)` | プロンプト/スキーマがバリデーション失敗。`testGeminiOnly` でログを確認 |
| ブラウザで CORS エラー | フロントは `Content-Type` ヘッダなしの `fetch` (= text/plain) で送ること。`application/json` は preflight が走り GAS が対応していない |
