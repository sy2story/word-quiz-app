// 英単語クイズアプリ用 Google Apps Script
// 仕様書 §11.1 に準拠
//
// デプロイ手順:
// 1. Googleスプレッドシートを開く（シート名は "words"）
// 2. 拡張機能 > Apps Script を開く
// 3. このファイルの内容を Code.gs に貼り付ける
// 4. 保存して「デプロイ > 新しいデプロイ」
// 5. 種類: ウェブアプリ / 実行ユーザー: 自分 / アクセスできるユーザー: 全員
// 6. 発行された /exec URL を フロントの config.js の APPS_SCRIPT_URL に設定

const SHEET_NAME = "words";

const COLUMN_MAP = {
  id: "id",
  word: "word",
  meaningJa: "meaning_ja",
  phraseEn: "phrase_en",
  phraseJa: "phrase_ja",
  exampleEn: "example_en",
  exampleJa: "example_ja",
  section: "section",
  enabled: "enabled",
  correctCount: "correct_count",
  wrongCount: "wrong_count",
  lastResult: "last_result",
  lastAnsweredAt: "last_answered_at",
  isWeak: "is_weak",
  consecutiveCorrectCount: "consecutive_correct_count"
};

function doGet(e) {
  try {
    const sheet = getWordsSheet();
    const values = sheet.getDataRange().getValues();

    if (values.length <= 1) {
      return createJsonResponse({
        success: true,
        updatedAt: new Date().toISOString(),
        count: 0,
        data: []
      });
    }

    const headers = values[0].map(h => String(h).trim());
    const rows = values.slice(1);

    const data = rows
      .map(row => rowToObject(headers, row))
      .filter(isEnabledRow)
      .filter(hasRequiredFields)
      .map(normalizeWordItem);

    return createJsonResponse({
      success: true,
      updatedAt: new Date().toISOString(),
      count: data.length,
      data: data
    });

  } catch (error) {
    return createJsonResponse({
      success: false,
      message: error.message || "Unknown error",
      data: []
    });
  }
}

function doPost(e) {
  try {
    const payload = JSON.parse((e && e.postData && e.postData.contents) || "{}");

    const wordId = String(payload.wordId || "").trim();
    const result = String(payload.result || "").trim();

    if (!wordId) {
      return createJsonResponse({
        success: false,
        message: "wordId is required."
      });
    }

    if (result !== "correct" && result !== "wrong") {
      return createJsonResponse({
        success: false,
        message: "result must be correct or wrong."
      });
    }

    const sheet = getWordsSheet();
    const values = sheet.getDataRange().getValues();

    if (values.length <= 1) {
      return createJsonResponse({
        success: false,
        message: "No data rows found."
      });
    }

    const headers = values[0].map(h => String(h).trim());
    const col = getColumnIndexes(headers);

    validateRequiredColumns(col);

    const target = findRowByWordId(values, col.id, wordId);

    if (!target) {
      return createJsonResponse({
        success: false,
        message: "Word not found: " + wordId
      });
    }

    const rowIndex = target.rowIndex;
    const row = target.row;

    const currentCorrect = toNumber(row[col.correctCount]);
    const currentWrong = toNumber(row[col.wrongCount]);
    const currentConsecutiveCorrect = col.consecutiveCorrectCount >= 0
      ? toNumber(row[col.consecutiveCorrectCount])
      : 0;

    const answeredAt = payload.answeredAt
      ? String(payload.answeredAt)
      : new Date().toISOString();

    let nextCorrect = currentCorrect;
    let nextWrong = currentWrong;
    let nextIsWeak = false;
    let nextConsecutiveCorrect = currentConsecutiveCorrect;

    if (result === "correct") {
      nextCorrect = currentCorrect + 1;
      nextIsWeak = false;
      nextConsecutiveCorrect = currentConsecutiveCorrect + 1;
    } else {
      nextWrong = currentWrong + 1;
      nextIsWeak = true;
      nextConsecutiveCorrect = 0;
    }

    setCellIfColumnExists(sheet, rowIndex, col.correctCount, nextCorrect);
    setCellIfColumnExists(sheet, rowIndex, col.wrongCount, nextWrong);
    setCellIfColumnExists(sheet, rowIndex, col.lastResult, result);
    setCellIfColumnExists(sheet, rowIndex, col.lastAnsweredAt, answeredAt);
    setCellIfColumnExists(sheet, rowIndex, col.isWeak, nextIsWeak);
    setCellIfColumnExists(sheet, rowIndex, col.consecutiveCorrectCount, nextConsecutiveCorrect);

    return createJsonResponse({
      success: true,
      wordId: wordId,
      result: result,
      correctCount: nextCorrect,
      wrongCount: nextWrong,
      lastResult: result,
      lastAnsweredAt: answeredAt,
      isWeak: nextIsWeak,
      consecutiveCorrectCount: nextConsecutiveCorrect
    });

  } catch (error) {
    return createJsonResponse({
      success: false,
      message: error.message || "Failed to save answer."
    });
  }
}

function getWordsSheet() {
  const sheet = SpreadsheetApp
    .getActiveSpreadsheet()
    .getSheetByName(SHEET_NAME);

  if (!sheet) {
    throw new Error("Sheet not found: " + SHEET_NAME);
  }

  return sheet;
}

function rowToObject(headers, row) {
  const item = {};
  headers.forEach(function (header, index) {
    item[header] = row[index];
  });
  return item;
}

function isEnabledRow(item) {
  const enabled = item.enabled;
  if (enabled === "" || enabled === null || enabled === undefined) {
    return true;
  }
  if (enabled === true) {
    return true;
  }
  return String(enabled).toUpperCase() === "TRUE";
}

function hasRequiredFields(item) {
  return item.id &&
    item.word &&
    item.meaning_ja &&
    item.phrase_en &&
    item.phrase_ja;
}

function normalizeWordItem(item) {
  return {
    id: String(item.id).trim(),
    word: String(item.word).trim().toLowerCase(),
    meaningJa: String(item.meaning_ja).trim(),
    phraseEn: String(item.phrase_en).trim(),
    phraseJa: String(item.phrase_ja).trim(),
    exampleEn: String(item.example_en || "").trim(),
    exampleJa: String(item.example_ja || "").trim(),
    section: item.section ? String(item.section).trim() : "",
    correctCount: toNumber(item.correct_count),
    wrongCount: toNumber(item.wrong_count),
    lastResult: String(item.last_result || "").trim(),
    lastAnsweredAt: item.last_answered_at
      ? (item.last_answered_at instanceof Date
        ? item.last_answered_at.toISOString()
        : String(item.last_answered_at).trim())
      : "",
    isWeak: toBoolean(item.is_weak),
    consecutiveCorrectCount: toNumber(item.consecutive_correct_count)
  };
}

function getColumnIndexes(headers) {
  const result = {};
  Object.keys(COLUMN_MAP).forEach(function (key) {
    const headerName = COLUMN_MAP[key];
    result[key] = headers.indexOf(headerName);
  });
  return result;
}

function validateRequiredColumns(col) {
  const required = [
    "id",
    "correctCount",
    "wrongCount",
    "lastResult",
    "lastAnsweredAt",
    "isWeak"
  ];
  required.forEach(function (key) {
    if (col[key] < 0) {
      throw new Error("Required column is missing: " + COLUMN_MAP[key]);
    }
  });
}

function findRowByWordId(values, idColIndex, wordId) {
  for (let i = 1; i < values.length; i++) {
    const rowId = String(values[i][idColIndex]).trim();
    if (rowId === wordId) {
      return {
        rowIndex: i + 1,
        row: values[i]
      };
    }
  }
  return null;
}

function setCellIfColumnExists(sheet, rowIndex, colIndex, value) {
  if (colIndex >= 0) {
    sheet.getRange(rowIndex, colIndex + 1).setValue(value);
  }
}

function toNumber(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : 0;
}

function toBoolean(value) {
  if (value === true) return true;
  if (value === false) return false;
  return String(value || "").toUpperCase() === "TRUE";
}

function createJsonResponse(payload) {
  return ContentService
    .createTextOutput(JSON.stringify(payload))
    .setMimeType(ContentService.MimeType.JSON);
}
