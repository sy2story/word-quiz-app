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

## 英語音声ダウンロード機能 (TTS / Gemini 2.5 Flash TTS) を有効化したいとき

「日記の英文を確認」→ 詳細ページの **英語音声ダウンロード** ボタンは、`gas/AiProxy.gs` の
`action: "tts"` ルート経由で **Gemini 2.5 Flash TTS** (`gemini-2.5-flash-preview-tts`) を呼び、
生 PCM 音声を返す。フロントはそれを WAV にラップしてダウンロードする。

有効化の手順:

1. **モデルアクセス / 課金を確認する** ⚠️ 重要
   - TTS は **従量課金 (有料) の対象**になりやすい。`GEMINI_API_KEY` を発行した Google AI Studio /
     Cloud プロジェクトで、`gemini-2.5-flash-preview-tts` が利用可能か (= 課金が有効か) を確認する。
   - 無料枠のままだと HTTP 429 / 403 で弾かれることがある。その場合は対象プロジェクトで
     **お支払い (Billing) を有効化** する。
   - キーは **GAS の Script Properties (`GEMINI_API_KEY`) にサーバ側で隔離**されており、`config.js`
     には出ない。よって `CLAUDE.md` の「従量課金 API を `config.js` のキーで開放しない」方針には反しない。
     代わりに **サーバ側の日次 TTS 上限** (下記) でコストを制御する。
2. **`gas/AiProxy.gs` を最新版に差し替えて再デプロイ**する (「デプロイを管理 → 編集 → 新バージョン」。
   `/exec` URL は変わらず、`AI_PROXY_URL` の変更は不要)。
3. **新しい OAuth スコープは不要**。ダウンロード済みフラグ (`diary` シートの `audio_downloaded_at` 列)
   の書き込みは既存の Sheets スコープで足りる。TTS はプロキシ経由 (API キー) でユーザートークンは
   認証検証のみに使う。

ダウンロードは **diary 1 エントリにつき 1 回** に制限している (シートの `audio_downloaded_at` 列に
タイムスタンプを記録)。これはユーザーが自分のシートを編集すれば解除できるソフト制限なので、
実コスト防御はサーバ側の日次 TTS 上限が担う。

TTS 用の上限・声は `gas/AiProxy.gs` 冒頭で調整して再デプロイ:

```js
const GEMINI_TTS_MODEL = "gemini-2.5-flash-preview-tts";
const TTS_VOICE_NAME = "Aoede";        // 30 種から選択 (Zephyr/Puck/Kore/Aoede ...)
const DAILY_TTS_LIMIT_PER_USER = 5;    // 1 ユーザ / 1 日の音声ダウンロード回数
const GLOBAL_TTS_DAILY_LIMIT = 300;    // サービス全体 / 1 日
const MAX_TTS_CHARS = 2000;            // 音声化する英文の最大文字数
```

> ダウンロードファイルは **WAV** (Gemini TTS が返すのは生 PCM のみで MP3 は非対応のため)。
> WAV は非圧縮なので長文ほどファイルが大きい (24kHz/16bit ≒ 48KB/秒)。

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
| 音声DLで `Gemini TTS API error (HTTP 429/403)` | TTS が無料枠外/未課金。対象プロジェクトで Billing を有効化。または `DAILY_TTS_LIMIT_PER_USER` 内か確認 |
| 音声DLで `応答に音声データが含まれていません` | モデル名 (`GEMINI_TTS_MODEL`) か `responseModalities:["AUDIO"]` を確認。`gemini-2.5-flash-preview-tts` が当該リージョン/プロジェクトで使えるか確認 |
| 「今日の音声ダウンロード上限に達しました」 | `DAILY_TTS_LIMIT_PER_USER` の上限。翌日リセット、または値を上げて再デプロイ |
