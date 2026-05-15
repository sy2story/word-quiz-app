# 英単語クイズアプリ

Googleスプレッドシートで管理した英単語を、スマホブラウザから穴埋め形式でクイズできる静的Webアプリ。GitHub Pagesで公開し、PWAとしてスマホのホーム画面から起動できる。

詳細仕様は [`english_word_quiz_app_spec_updated.md`](./english_word_quiz_app_spec_updated.md) を参照。

---

## クイックスタート（ローカル動作確認）

API未設定のままでも、同梱の `sample-words.json` で動作確認できる。

```bash
cd /Users/sakagawa/Tech-0/wordbook_quiz
python3 -m http.server 8080
```

ブラウザで `http://localhost:8080` を開く。

> Note: `file://` でそのまま開くと Service Worker 登録と一部 fetch が動かないので、必ずローカルサーバ経由で確認すること。

---

## 本番セットアップ手順

### 1. Googleスプレッドシートを準備

1. 新規スプレッドシートを作成
2. シート名を `words` にする
3. [`sample-words.csv`](./sample-words.csv) の内容を貼り付ける（または独自の単語を入力）
   - 必須列: `id`, `word`, `meaning_ja`, `phrase_en`, `phrase_ja`
   - 任意列: `example_en`, `example_ja`, `section`, `enabled`, `correct_count`, `wrong_count`, `last_result`, `last_answered_at`, `is_weak`, `consecutive_correct_count`

### 2. Apps Script をデプロイ

1. スプレッドシートで `拡張機能 > Apps Script` を開く
2. デフォルトの `Code.gs` を全削除し、[`gas/Code.gs`](./gas/Code.gs) の中身を貼り付ける
3. 保存
4. 右上の `デプロイ > 新しいデプロイ` を選択
5. 種類: `ウェブアプリ`
6. 実行ユーザー: `自分`
7. アクセスできるユーザー: `全員`
8. デプロイを押し、発行された `/exec` で終わるURLをコピー

### 3. フロント側の設定

`config.sample.js` をコピーして `config.js` を作成し、コピーしたURLを設定:

```js
window.APPS_SCRIPT_URL = "https://script.google.com/macros/s/XXXXXXX/exec";
```

`config.js` は `.gitignore` で除外されているのでコミットされない。

### 4. GitHub Pages で公開

```bash
cd /Users/sakagawa/Tech-0/wordbook_quiz
git init
git add .
git commit -m "Initial commit"
git branch -M main
git remote add origin https://github.com/<your-username>/<repo-name>.git
git push -u origin main
```

GitHub の `Settings > Pages` を開き:

- Source: `Deploy from a branch`
- Branch: `main` / フォルダ `/ (root)`
- Save

数分後、`https://<your-username>.github.io/<repo-name>/` でアクセスできる。

### 5. PWA確認

- PC Chrome の DevTools → `Application` タブ
  - Manifest が読み込まれている
  - Service Worker が `activated`
  - Cache Storage に `word-quiz-app-v1` ができている
- iPhone Safari で公開URLを開き、共有 → `ホーム画面に追加`
- Android Chrome で公開URLを開き、メニュー → `アプリをインストール`

---

## ファイル構成

```text
wordbook_quiz/
├── index.html              ホーム + クイズ画面（JSで切替）
├── app.js                  メインロジック
├── styles.css              Tailwind補助の最小限カスタム
├── config.sample.js        APPS_SCRIPT_URL テンプレ
├── config.js               実URL格納（.gitignore対象）
├── manifest.json           PWAマニフェスト
├── service-worker.js       Service Worker
├── icon-192.png            プレースホルダーアイコン
├── icon-512.png            プレースホルダーアイコン
├── sample-words.csv        スプレッドシート初期投入用
├── sample-words.json       APIフォールバック / ローカル動作用
├── gas/
│   └── Code.gs             Apps Scriptサーバーコード
├── .gitignore
├── .nojekyll
└── README.md
```

---

## アイコンの差し替え方法

同梱の `icon-192.png` / `icon-512.png` はImageMagickで生成した青背景に "W" のプレースホルダー。差し替えるには以下のサイズのPNGを用意して同名で上書きするだけ:

- `icon-192.png` — 192x192
- `icon-512.png` — 512x512

ImageMagickでの再生成例:

```bash
convert -size 512x512 xc:'#2563eb' -gravity center -fill white \
  -font Helvetica-Bold -pointsize 280 -annotate +0+20 'W' icon-512.png
convert -size 192x192 xc:'#2563eb' -gravity center -fill white \
  -font Helvetica-Bold -pointsize 110 -annotate +0+10 'W' icon-192.png
```

---

## トラブルシューティング

### Apps Script APIから401/403が返る

- デプロイ設定の「アクセスできるユーザー」が `全員` になっているか確認
- 「実行ユーザー」が `自分` になっているか確認
- 新規デプロイIDで `/exec` URLが変わった可能性 → `config.js` のURLを更新

### POSTがCORSエラーで失敗する

Content-Typeは `text/plain;charset=utf-8` を使用している（preflight回避）。仕様書 §9.3 に明記。`app.js` 内のPOSTヘッダを変更しないこと。

### Service Worker更新が反映されない

`service-worker.js` 内の `CACHE_NAME` をインクリメント（`word-quiz-app-v1` → `v2`）してコミット&デプロイ。古いキャッシュは `activate` イベントで削除される。

DevTools `Application > Service Workers` の `Update on reload` チェックも有効化推奨。

### スプレッドシートの変更がアプリに反映されない

ホーム画面の「データを再読み込み」ボタンを押す。`fetch` URLには `?t={timestamp}` がついておりキャッシュ回避される。

### iPhone でホーム画面追加してもアプリ風に起動しない

Safari の `共有 > ホーム画面に追加` で追加すること。Chrome経由ではPWAとしては機能しない（iOSの仕様）。

---

## MVPに含めないもの

- ログイン / 複数ユーザー管理
- 回答履歴ログシート（`learning_logs`）
- 管理画面
- 正答率グラフ
- 完全オフラインでの新規データ取得
- 本格的な認証

将来拡張は仕様書 §28 を参照。
