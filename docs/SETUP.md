# マルチユーザー化 実装メモ（案A: クライアントサイド OAuth + Sheets API 直叩き）

GAS を廃止し、すべてブラウザ側で完結させる構成にする。
GitHub Pages 上の静的ホストのまま、各ユーザー自身の Google アカウントで自分のスプレッドシートを読み書きする。

---

## 1. 全体像

```
┌─────────────────────── ブラウザ ───────────────────────┐
│                                                       │
│  index.html / app.js                                  │
│    │                                                  │
│    ├─ Google Identity Services (GIS) ── アクセストークン取得
│    │                                                  │
│    ├─ Google Picker API ────────────── シート選択
│    │                                                  │
│    └─ Sheets API v4 ───── GET/PUT ──── ユーザー本人のシート
│                                                       │
└───────────────────────────────────────────────────────┘
         ↑                                ↑
         │                                │
    GitHub Pages                    Google アカウント
   （静的ホスト・無料）                （データの所有者）
```

ポイント:

- **サーバーは無い**（GitHub Pages のまま）
- **データは常にユーザー自身のシートに残る**（運営側は何も保管しない）
- アクセストークンはブラウザのメモリにだけ存在し、localStorage には**保存しない**

---

## 2. Google Cloud 側の準備（一度だけ）

開発者側（あなた）が Google Cloud Console で行う作業:

1. **プロジェクトを作成**
2. **OAuth 同意画面を設定**
   - ユーザータイプ: 「外部」
   - スコープ: `https://www.googleapis.com/auth/drive.file` だけ追加
   - アプリ名 / サポートメール / プライバシーポリシーURL を埋める
3. **API を有効化**
   - Google Sheets API
   - Google Picker API
   - Google Drive API（Picker が依存）
4. **認証情報を作成**
   - OAuth 2.0 クライアントID（種類: ウェブアプリケーション）
     - 承認済みJavaScript生成元: `https://<github-username>.github.io`
   - API キー（Picker API 用、HTTPリファラ制限を `https://<github-username>.github.io/*` に）

クライアントID と API キーをフロントの `config.js` に書く（これらは公開して問題ない値。秘密にすべきは「クライアントシークレット」だが、SPA フローではそもそも発行しない）。

```js
// config.js
window.GOOGLE_CLIENT_ID = "xxxx.apps.googleusercontent.com";
window.GOOGLE_API_KEY   = "AIza...";
```

---

## 3. スコープ選定: なぜ `drive.file` か

| スコープ | 範囲 | Google 審査 |
|---|---|---|
| `spreadsheets` | **ユーザーの全シート**を読み書き | 「機密スコープ」扱い → 公開時に**重い審査**（数週間〜数ヶ月）|
| `drive.file` | **アプリが開いた / 作成したファイルのみ** | 「非機密スコープ」→ 公開時の審査が**ほぼ不要** |

`drive.file` は「ユーザーが Picker で選んだファイル」しかアクセスできない代わりに、Google の審査が劇的に軽くなる。一般公開を狙うなら**必須レベルでこちらを選ぶ**べき。

---

## 4. 起動〜シート選択までのフロー

```
[1] ユーザーが初訪問
       │
       ▼
[2] 「Googleと接続」ボタンを表示
       │ クリック
       ▼
[3] GIS が同意画面を表示
       │ ユーザーが許可
       ▼
[4] アクセストークン取得（メモリに保持）
       │
       ▼
[5] Picker を起動
       │ ユーザーがシートを選択
       ▼
[6] spreadsheetId を localStorage に保存
       │
       ▼
[7] Sheets API でデータ読み込み → クイズ開始
```

### コード断片（GIS でトークン取得）

```js
// 起動時に <script src="https://accounts.google.com/gsi/client"></script> を読み込んだ前提

let accessToken = null;
let tokenClient = null;

function initAuth() {
  tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: window.GOOGLE_CLIENT_ID,
    scope: "https://www.googleapis.com/auth/drive.file",
    callback: (resp) => {
      if (resp.error) return showError(resp);
      accessToken = resp.access_token;
      onSignedIn();
    },
  });
}

function signIn() {
  // 初回は consent、2回目以降は prompt:'' でサイレント
  tokenClient.requestAccessToken({ prompt: accessToken ? "" : "consent" });
}
```

### Picker でシート選択

```js
function openPicker() {
  const view = new google.picker.View(google.picker.ViewId.SPREADSHEETS);
  const picker = new google.picker.PickerBuilder()
    .setAppId(window.GOOGLE_CLIENT_ID.split("-")[0])
    .setOAuthToken(accessToken)
    .setDeveloperKey(window.GOOGLE_API_KEY)
    .addView(view)
    .setCallback((data) => {
      if (data.action === google.picker.Action.PICKED) {
        const file = data.docs[0];
        localStorage.setItem("spreadsheetId", file.id);
        loadWords(file.id);
      }
    })
    .build();
  picker.setVisible(true);
}
```

`drive.file` スコープの良いところ: Picker で選んだファイルは**以後その `clientId` でアクセス可能**になり、ユーザーから見ても「このアプリには自分が選んだファイルしか見えないんだな」という安心感が伴う。

---

## 5. データ読み込み（GAS の `doGet` 相当）

```js
async function loadWords(spreadsheetId) {
  const range = "words!A1:O1000";   // ヘッダ含む
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(range)}`;

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (res.status === 401) { await refreshToken(); return loadWords(spreadsheetId); }
  const json = await res.json();    // { values: [[...headers...],[...row...],...] }

  const headers = json.values[0];
  const rows = json.values.slice(1);

  // 行番号→id のマップを覚えておく（書き込みで使う）
  const rowIndexById = {};
  const data = rows.map((row, i) => {
    const obj = rowToObject(headers, row);
    rowIndexById[obj.id] = i + 2;   // +1(0始まり) +1(ヘッダ行)
    return normalizeWordItem(obj);
  });

  return { data, rowIndexById, headers };
}
```

**現GASとの差分**: 今までサーバー側でやっていた `normalizeWordItem` / `isEnabledRow` / `hasRequiredFields` などをそのままフロント側に移植するだけ（`gas/Code.gs:183-231` のロジックを `app.js` 側へ）。

---

## 6. 解答結果の書き込み（GAS の `doPost` 相当）

**ここが現状と一番違うところ**。GAS では毎回シート全体を読んで該当行を探していたが、ブラウザ側に既にデータがあるので**該当セルだけ直接書く**ことができる。

```js
async function recordAnswer(spreadsheetId, word, result, ctx) {
  // ctx: { rowIndexById, headers }  ← loadWords で覚えたもの
  const rowIdx = ctx.rowIndexById[word.id];

  // ローカルで次の値を計算
  const next = {
    correct_count: word.correctCount + (result === "correct" ? 1 : 0),
    wrong_count:   word.wrongCount   + (result === "wrong"   ? 1 : 0),
    last_result:   result,
    last_answered_at: new Date().toISOString(),
    is_weak:       result === "wrong",
    consecutive_correct_count: result === "correct" ? word.consecutiveCorrectCount + 1 : 0,
  };

  // 列名→列番号
  const colOf = (name) => ctx.headers.indexOf(name);

  // batchUpdate で1往復にまとめる
  const data = Object.entries(next).map(([name, value]) => ({
    range: `words!${colLetter(colOf(name))}${rowIdx}`,
    values: [[value]],
  }));

  const url = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values:batchUpdate`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ valueInputOption: "RAW", data }),
  });

  if (!res.ok) throw new Error("write failed");

  // ローカル状態も同期
  Object.assign(word, {
    correctCount: next.correct_count,
    wrongCount: next.wrong_count,
    /* ... */
  });
}

function colLetter(idx) {
  // 0→A, 1→B, ...  26→AA
  let s = "";
  idx++;
  while (idx > 0) {
    const m = (idx - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    idx = Math.floor((idx - 1) / 26);
  }
  return s;
}
```

**メリット**: 現 GAS は1回の書き込みでシート全体を `getDataRange().getValues()` するので遅い。ブラウザ側でやれば**書き込み1往復で完結**し、UX が体感かなり速くなる。

---

## 7. トークン管理

GIS のブラウザフローではアクセストークンの有効期間が **約1時間**で、リフレッシュトークンは取れない（取りたければバックエンド必須）。代わりに以下で対応:

- API 呼び出しが **401** を返したら `tokenClient.requestAccessToken({prompt: ''})` を呼ぶ → ユーザーが Google にまだログイン中ならサイレントで再発行
- ログアウト: `google.accounts.oauth2.revoke(accessToken)` を呼んで `accessToken = null`

```js
async function apiCall(url, opts) {
  let res = await doFetch(url, opts);
  if (res.status === 401) {
    await refreshToken();           // tokenClient.requestAccessToken({prompt:""}) の Promise ラッパ
    res = await doFetch(url, opts);
  }
  return res;
}
```

---

## 8. オフライン / キャッシュ

現状すでに `service-worker.js` があるので相性が良い:

- **読み込みキャッシュ**: Sheets API レスポンスを IndexedDB に保存し、起動時はまずキャッシュ表示→裏で fetch（stale-while-revalidate）
- **書き込みキューイング**: オフライン時は IndexedDB に解答結果を積み、復帰時にフラッシュ

書き込みのコンフリクト（複数端末で同時利用）は基本起きにくい（解答は加算 / 上書きが多い）が、心配なら `version` カラムを足して楽観ロックする手もある。最初はキューイングだけで十分。

---

## 9. オンボーディング: テンプレートシートの配布

UX を「URL貼るだけ」に近づけるための仕掛け:

1. 必要列を備えた**公開テンプレートシート**を1つ作っておく（読み取り専用で共有）
2. ランディング画面に「📋 テンプレートをコピー」ボタン
   - リンク: `https://docs.google.com/spreadsheets/d/<TEMPLATE_ID>/copy`
   - クリックすると Google が「コピーしますか？」ダイアログを出してくれる
3. コピー完了したら「📂 自分のシートを選ぶ」→ Picker 起動
4. 完了

```
[コピーする] → ユーザーのDriveに複製される
   ↓
[シートを選ぶ] → Picker でその複製を選ぶ
   ↓
[クイズ開始]
```

シートの列構造が壊れていたら、`headers` を見て「`phrase_en` 列が見つかりません」のように具体的に教える検証関数を入れる。

---

## 10. 既存コードからの移行ステップ

| Step | 内容 | 対象ファイル |
|---|---|---|
| 1 | Google Cloud プロジェクト作成・OAuth クライアント・APIキー発行 | (外部) |
| 2 | `config.js` を `GOOGLE_CLIENT_ID` / `GOOGLE_API_KEY` 用に書き換え | `config.js` |
| 3 | `index.html` に GIS / Picker / gapi スクリプトタグを追加 | `index.html` |
| 4 | GAS の正規化ロジック(`normalizeWordItem` 等) を `app.js` に移植 | `app.js` |
| 5 | `loadWords()` / `recordAnswer()` を Sheets API で実装 | `app.js` |
| 6 | サインインボタン・Picker ボタン・サインアウト UI を追加 | `index.html` / `app.js` |
| 7 | Service Worker のキャッシュキーを spreadsheetId 込みに | `service-worker.js` |
| 8 | テンプレートシートを Google ドライブに作成 → リンク埋め込み | (外部) |
| 9 | `gas/Code.gs` を削除（または `gas-legacy/` にアーカイブ） | `gas/` |

最初は OAuth クライアントを「テストユーザー限定」で動かす（自分自身＋身近な数人）→ 動作確認できたら同意画面を「公開」へ昇格。`drive.file` のみなら原則そのまま公開できる。

---

## 11. 公開時の注意（OAuth ステータス）

- **テスト中**: テストユーザーに登録した人だけが「危険なアプリです」警告なしで使える。最大100人。
- **本番公開**: 公開後 100ユーザーを超えると Google が**ブランド審査**（ロゴ・ドメイン所有確認・プライバシーポリシー）を要求することがある。`drive.file` のみ使用なら**セキュリティ審査は不要**。
- **プライバシーポリシー**は静的ページで OK（GitHub Pages に `/privacy.html` を置く）。「データは収集しません。シートはユーザーのGoogleアカウントに残ります」と書ければ十分。

---

## 12. 優先実装順（PoC → 本番）

最小動作版（PoC）として最短で組む順番:

1. ステップ1〜3（Cloud Console + script タグ）✅
2. サインイン → Picker → ハードコードした range で GET → 画面に出す ✅
3. `recordAnswer` を batchUpdate で実装 ✅
4. 401 リトライとサインアウトを足す ✅
5. テンプレートシート＋コピーボタンで体裁を整える（次タスク）

---

## 13. 現在の実装ファイル構成

| ファイル | 役割 |
|---|---|
| `auth.js` | GIS で OAuth トークン取得 + Picker 起動。`window.WQAuth` を公開 |
| `sheets.js` | Sheets API v4 ラッパー。`loadWords` / `recordAnswer` / `writeCells` を `window.WQSheets` で公開 |
| `app.js` | UI とクイズロジック。Sheets API ベースに移行済み |
| `index.html` | 接続バナー（未接続/シート未選択/接続済み）を出し分け |
| `config.js` | `GOOGLE_CLIENT_ID` / `GOOGLE_API_KEY`（gitignore 済み） |
| `service-worker.js` | キャッシュ v4。Google API 系ホストはネットワーク直行 |

旧 `gas/Code.gs` は使用していないが、参考用にリポジトリ内に残置。

---

## 14. 動作確認手順

```bash
python3 -m http.server 5173
```

ブラウザで `http://localhost:5173` を開き:

1. **接続バナー**「Google でサインイン」をクリック → 同意画面 → 許可
2. **シート選択バナー**「シートを選択」→ Picker から現在の単語帳シートを選ぶ
3. **ホーム画面**にセクションカードと「接続中のシート」が表示される
4. 適当なセクションで「解いてみる」→ 1問解答 → スプレッドシート側で該当行の
   `correct_count` / `last_result` / `last_answered_at` などが更新されているか確認
5. リロード → 自動でサインイン状態とシートが復元され、同じ画面に戻ること

### 確認ポイント

- DevTools Network タブで `sheets.googleapis.com` への GET / POST が発生していること
- localStorage に `wordQuiz_spreadsheetId` が保存されていること
- 「サインアウト」→ 接続バナーに戻ること
