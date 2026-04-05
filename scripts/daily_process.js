/**
 * daily_process.js
 * 毎日21時実行：UnitBase 人材(応募者)テーブル
 * SQLite で処理状態を管理し、未処理レコードのみ処理する。
 *
 * 実行方法: node /data/workspace/scripts/daily_process.js
 * 戻り値: 処理結果を標準出力に出力（エラー時は exit code 1）
 */

const https = require("https");
const fs = require("fs");
const path = require("path");

// ----------------------------
// 定数
// ----------------------------
const HOST = "203.137.53.40";
const PORT = 443;
const APP_ID = 7;
const TABLE_ID = 126;
const FIELD_ID = 4493; // 職歴・スキル概要（書き込み先）
const LAYOUT_ID = 205;
const FIELD_RESUME = 3606; // 職務経歴書ファイル
const FIELD_CV = 3690; // 履歴書ファイル
const FIELD_NAME = 3591; // 氏名
const DB_PATH = "/data/db/file_processing.db";
const LINE_GROUP_ID = process.env.LINE_GROUP_ID;
const LOG_FILE =
  process.env.DAILY_PROCESS_LOG_PATH ||
  path.join(__dirname, "daily_process.log");
const MAX_RETRY_COUNT = 3;
const MAX_TEXT_LENGTH = 3000;
const PAGE_SIZE = 500;
const REQUEST_TIMEOUT_MS = 30000;
const DRY_RUN = process.env.DRY_RUN === "1";
const _parsedDryRunLimit = parseInt(process.env.DRY_RUN_LIMIT || "1", 10);
const DRY_RUN_LIMIT = Number.isNaN(_parsedDryRunLimit) || _parsedDryRunLimit < 1 ? 1 : _parsedDryRunLimit;

// ----------------------------
// ロギング
// ----------------------------
const log = (msg) => {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try {
    fs.appendFileSync(LOG_FILE, line + "\n");
  } catch {
    // ログファイル書き込み失敗は無視
  }
};

// ----------------------------
// DB 初期化
// ----------------------------
function initDb(dbPath) {
  const Database = require("better-sqlite3");
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS file_processing (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      record_id       INTEGER NOT NULL,
      field_id        INTEGER NOT NULL,
      file_path       TEXT    NOT NULL,
      status          TEXT    NOT NULL DEFAULT 'pending',
      error_type      TEXT,
      error_message   TEXT,
      error_count     INTEGER DEFAULT 0,
      first_error_at  TEXT,
      created_at      TEXT    NOT NULL,
      processed_at    TEXT,
      UNIQUE(record_id, field_id, file_path)
    );
  `);
  return db;
}

// ----------------------------
// DB 操作: レコード同期
// ----------------------------
function syncRecords(db, records) {
  const now = new Date().toISOString();

  // 同一 (record_id, field_id, file_path) の完全一致で検索
  const findByExactPath = db.prepare(
    "SELECT * FROM file_processing WHERE record_id = ? AND field_id = ? AND file_path = ?",
  );
  // 同一 (record_id, field_id) で別パスのレコードが存在するか（差し替え判定用）
  const hasOtherPath = db.prepare(
    "SELECT 1 FROM file_processing WHERE record_id = ? AND field_id = ? AND file_path != ? LIMIT 1",
  );
  const insertPending = db.prepare(
    "INSERT INTO file_processing (record_id, field_id, file_path, status, created_at) VALUES (?, ?, ?, 'pending', ?)",
  );

  // write_error / unexpected で error_count < MAX_RETRY_COUNT のレコードを pending に戻す
  const retryStmt = db.prepare(`
    UPDATE file_processing
    SET status = 'pending'
    WHERE status = 'error'
      AND error_type IN ('write_error', 'unexpected')
      AND error_count < ?
  `);
  retryStmt.run(MAX_RETRY_COUNT);

  let newCount = 0;
  let replacedCount = 0;

  for (const rec of records) {
    const recordId = rec.recordId;
    const fieldId = rec.fieldId;
    const filePath = rec.filePath;

    const exactMatch = findByExactPath.get(recordId, fieldId, filePath);
    if (exactMatch) {
      // 同一ファイルパスが DB に存在 → 既に管理済み（retryStmt で pending 復帰済みの場合を含む）
      continue;
    }

    // DB に同一パスが存在しない → 新規 or ファイル差し替え
    insertPending.run(recordId, fieldId, filePath, now);
    if (hasOtherPath.get(recordId, fieldId, filePath)) {
      replacedCount++;
    } else {
      newCount++;
    }
  }

  return { newCount, replacedCount };
}

// ----------------------------
// DB 操作: pending レコード取得
// ----------------------------
function getPendingRecords(db) {
  return db
    .prepare("SELECT * FROM file_processing WHERE status = 'pending'")
    .all();
}

// ----------------------------
// DB 操作: 処理成功
// ----------------------------
function markProcessed(db, id) {
  const now = new Date().toISOString();
  db.prepare(
    "UPDATE file_processing SET status = 'processed', processed_at = ? WHERE id = ?",
  ).run(now, id);
}

// ----------------------------
// DB 操作: エラー記録
// ----------------------------
function markError(db, id, errorType, errorMessage) {
  const now = new Date().toISOString();
  const row = db.prepare("SELECT * FROM file_processing WHERE id = ?").get(id);
  const firstErrorAt = row && row.first_error_at ? row.first_error_at : now;
  const errorCount = row ? row.error_count + 1 : 1;

  db.prepare(
    `UPDATE file_processing
     SET status = 'error', error_type = ?, error_message = ?, error_count = ?, first_error_at = ?
     WHERE id = ?`,
  ).run(errorType, errorMessage, errorCount, firstErrorAt, id);
}

// ----------------------------
// エラー種別の判定
// ----------------------------
function classifyError(error, filePath) {
  const msg = (error.message || error || "").toString();
  if (msg.includes("password") || msg.includes("encrypted"))
    return "password_protected";
  if (msg.includes("corrupt") || msg.includes("invalid pdf") || msg.includes("invalid file"))
    return "corrupted";
  if (!filePath || !filePath.includes(".")) return "unexpected";
  const ext = filePath.split(".").pop().toLowerCase();
  if (
    !["pdf", "docx", "doc", "xlsx", "xls", "jpg", "jpeg", "png", "gif"].includes(ext)
  )
    return "unsupported";
  return "unexpected";
}

// ----------------------------
// HTTPS リクエスト
// ----------------------------
async function doReq(method, reqPath, cookies, csrf, data) {
  return new Promise((resolve, reject) => {
    const body = data ? JSON.stringify(data) : null;
    const headers = {
      "Content-Type": "application/json",
      Cookie: cookies,
      "User-Agent": "Mozilla/5.0",
    };
    if (csrf) headers["X-UnitBase-CSRF-Token"] = csrf;
    if (body) headers["Content-Length"] = Buffer.byteLength(body);
    const chunks = [];
    const req = https.request(
      {
        host: HOST,
        port: PORT,
        path: reqPath,
        method,
        headers,
        rejectUnauthorized: false,
      },
      (res) => {
        res.on("error", reject);
        res.on("data", (d) => chunks.push(d));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString();
          try {
            resolve([res.statusCode, res.headers, JSON.parse(text)]);
          } catch {
            resolve([res.statusCode, res.headers, text]);
          }
        });
      },
    );
    req.setTimeout(REQUEST_TIMEOUT_MS, () => {
      req.destroy(new Error(`リクエストタイムアウト (${REQUEST_TIMEOUT_MS}ms): ${method} ${reqPath}`));
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

// ----------------------------
// ファイルダウンロード
// ----------------------------
async function downloadFile(filePath, cookies) {
  return new Promise((resolve, reject) => {
    const fullPath = "/teambase" + filePath;
    const chunks = [];
    const req = https.get(
      {
        host: HOST,
        port: PORT,
        path: fullPath,
        headers: { Cookie: cookies, "User-Agent": "Mozilla/5.0" },
        rejectUnauthorized: false,
      },
      (res) => {
        res.on("error", reject);
        res.on("data", (d) => chunks.push(d));
        res.on("end", () => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            reject(
              new Error(
                `ダウンロード失敗: HTTP ${res.statusCode} ${fullPath}`,
              ),
            );
          } else {
            resolve(Buffer.concat(chunks));
          }
        });
      },
    );
    req.setTimeout(REQUEST_TIMEOUT_MS, () => {
      req.destroy(new Error(`ダウンロードタイムアウト (${REQUEST_TIMEOUT_MS}ms): ${fullPath}`));
    });
    req.on("error", reject);
  });
}

// ----------------------------
// テキスト整形
// ----------------------------
function formatText(raw) {
  if (!raw) return "";
  let text = raw;
  text = text.replace(/\d+\s*\/\s*\d+\s*/g, "");
  text = text.replace(/ {2,}/g, " ");
  text = text.replace(/([^\n])【/g, "$1\n\n【");
  text = text.replace(/】([^\n])/g, "】\n$1");
  text = text.replace(/([^\n])■/g, "$1\n\n■");
  text = text.replace(/([^\n])□/g, "$1\n\n□");
  text = text.replace(/([^\n])◆/g, "$1\n◆");
  text = text.replace(/([^\n])・/g, "$1\n・");
  text = text.replace(/([^\n])(\d{4}年\d{1,2}月)/g, "$1\n\n$2");
  text = text.replace(/\n{3,}/g, "\n\n");
  return text.trim();
}

// ----------------------------
// PDF テキスト抽出
// ----------------------------
async function extractPdfText(buf) {
  const pdfMod = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const pdfLib = pdfMod.default || pdfMod;
  const doc = await pdfLib.getDocument({ data: new Uint8Array(buf) }).promise;
  let text = "";
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    text += content.items.map((x) => x.str).join(" ") + "\n";
  }
  return text;
}

// ----------------------------
// Word テキスト抽出
// ----------------------------
async function extractWordText(buf) {
  const mammoth = require("mammoth");
  const result = await mammoth.extractRawText({ buffer: buf });
  return result.value;
}

// ----------------------------
// Excel テキスト抽出
// ----------------------------
function extractExcelText(buf) {
  const XLSX = require("xlsx");
  const wb = XLSX.read(buf, { type: "buffer" });
  let text = "";
  wb.SheetNames.forEach((name) => {
    const ws = wb.Sheets[name];
    text += XLSX.utils.sheet_to_csv(ws) + "\n";
  });
  return text;
}

// ----------------------------
// ファイル種別に応じてテキスト抽出
// ----------------------------
async function extractText(buf, filePath) {
  const ext = filePath.split(".").pop().toLowerCase();
  if (ext === "pdf") {
    const text = await extractPdfText(buf);
    const cleaned = text.replace(/\s/g, "");
    if (cleaned.length > 50) return { method: "pdf_text", text };
    return {
      method: "pdf_ocr",
      text: "【スキャン画像PDFのため自動テキスト抽出不可】\n職務経歴書ファイルが画像形式のPDFのため、自動読み取りができませんでした。\n手動での確認をお願いします。",
    };
  }
  if (ext === "docx" || ext === "doc") {
    try {
      const text = await extractWordText(buf);
      return { method: "word", text };
    } catch (e) {
      if (ext === "doc") {
        // mammoth は .docx 専用。.doc（旧バイナリ形式）は非対応
        return { method: "unsupported", text: "" };
      }
      throw e;
    }
  }
  if (ext === "xlsx" || ext === "xls") {
    const text = extractExcelText(buf);
    return { method: "excel", text };
  }
  if (["jpg", "jpeg", "png", "gif"].includes(ext)) {
    try {
      const { createWorker } = require("tesseract.js");
      const worker = await createWorker("jpn+eng", 1, { logger: () => {} });
      try {
        const {
          data: { text },
        } = await worker.recognize(buf);
        return { method: "image_ocr", text };
      } finally {
        await worker.terminate();
      }
    } catch {
      return {
        method: "image_ocr_failed",
        text: "【画像OCR処理エラー】手動確認をお願いします。",
      };
    }
  }
  return { method: "unsupported", text: "" };
}

// ----------------------------
// ファイルパス解析
// ----------------------------
function parseFilePath(raw) {
  if (!raw) return null;
  const parts = raw.split("\t");
  return parts.length >= 2 ? parts[parts.length - 1].trim() : raw.trim();
}

// ----------------------------
// LINE 通知
// ----------------------------
async function sendLineMessage(message) {
  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;

  if (!token || !LINE_GROUP_ID) {
    const missing = [
      !token && "LINE_CHANNEL_ACCESS_TOKEN",
      !LINE_GROUP_ID && "LINE_GROUP_ID",
    ]
      .filter(Boolean)
      .join(" / ");
    console.warn(`[LINE] ${missing} が未設定のため通知をスキップします`);
    return;
  }

  const body = JSON.stringify({
    to: LINE_GROUP_ID,
    messages: [{ type: "text", text: message }],
  });

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        host: "api.line.me",
        port: 443,
        path: "/v2/bot/message/push",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
          "Content-Length": Buffer.byteLength(body),
        },
      },
      (res) => {
        res.on("error", reject);
        const chunks = [];
        res.on("data", (d) => chunks.push(d));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString();
          if (res.statusCode === 200) {
            resolve();
          } else {
            reject(new Error(`LINE API エラー: ${res.statusCode} ${text}`));
          }
        });
      },
    );
    req.setTimeout(REQUEST_TIMEOUT_MS, () => {
      req.destroy(new Error(`LINE API タイムアウト (${REQUEST_TIMEOUT_MS}ms)`));
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

// ----------------------------
// 通知メッセージ組み立て
// ----------------------------
function buildNotificationMessage(date, successCount, firstTimeErrors) {
  const lines = [`【職歴・スキル 自動処理】${date}`];

  if (successCount > 0) {
    lines.push(`✅ 処理完了: ${successCount}件`);
  }

  if (firstTimeErrors.length > 0) {
    lines.push(`❌ エラー（初回）: ${firstTimeErrors.length}件`);
    for (const err of firstTimeErrors) {
      lines.push(`  ・${err.name} — ${err.description}`);
    }
  }

  return lines.join("\n");
}

// ----------------------------
// エラー種別の日本語ラベル
// ----------------------------
function errorTypeLabel(errorType) {
  const labels = {
    password_protected: "パスワード付きファイル",
    corrupted: "ファイル破損",
    unsupported: "非対応形式",
    write_error: "書き込みエラー",
    unexpected: "予期しないエラー",
  };
  return labels[errorType] || errorType;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ----------------------------
// メイン処理
// ----------------------------
async function main(options = {}) {
  const dryRun = options.dryRun !== undefined ? options.dryRun : DRY_RUN;
  const dryRunLimit = options.limit !== undefined ? options.limit : DRY_RUN_LIMIT;
  const _markProcessed = options._markProcessed || markProcessed;
  const _markError = options._markError || markError;
  const _sendLineMessage = options._sendLineMessage || sendLineMessage;
  const _downloadFile = options._downloadFile || downloadFile;
  const _doReq = options._doReq || doReq;
  const _extractText = options._extractText || extractText;
  const dbPath = options.dbPath || DB_PATH;
  const today = new Date().toISOString().slice(0, 10);
  log(`=== 日次処理開始 ${today} ===`);

  // ① DB 初期化
  const db = initDb(dbPath);
  log("DB 初期化完了");

  try {
    // ② UnitBase ログイン
    const ubUser = process.env.UNITBASE_USERNAME;
    const ubPass = process.env.UNITBASE_PASSWORD;
    if (!ubUser || !ubPass) {
      throw new Error(
        "UNITBASE_USERNAME / UNITBASE_PASSWORD が未設定です。Fly.io Secrets に設定してください。",
      );
    }
    const csrf0 = process.env.UNITBASE_CSRF_TOKEN || "";
    const baseCookies = `csrf-token=${csrf0}; user_pref_tz=0; hadLoggedInUB=true; server_tz_offset=540; i18n_locale=ja; browser_lang=ja; tz_offset=-540`;
    const [loginStatus, lh, loginBody] = await _doReq(
      "POST",
      "/teambase/login",
      baseCookies,
      csrf0,
      {
        user_name: ubUser,
        password: ubPass,
        remember_me: false,
        force: true,
      },
    );
    if (loginStatus !== 200 && loginStatus !== 302) {
      throw new Error(`UnitBase ログイン失敗: HTTP ${loginStatus}`);
    }
    if (
      loginBody &&
      typeof loginBody === "object" &&
      loginBody.status === "error"
    ) {
      const errInfo = loginBody.status_info?.code || JSON.stringify(loginBody);
      throw new Error(`UnitBase ログイン失敗（認証エラー）: ${errInfo}`);
    }
    const setCookies = lh["set-cookie"] || [];
    if (setCookies.length === 0) {
      throw new Error(
        "UnitBase ログイン失敗: set-cookie ヘッダーが返されませんでした",
      );
    }
    const nc = setCookies.map((x) => x.split(";")[0]).join("; ");
    const newCsrf =
      setCookies
        .find((x) => x.startsWith("csrf-token="))
        ?.split(";")[0]
        ?.replace("csrf-token=", "") || csrf0;
    const cookies = baseCookies + "; " + nc;
    log("ログイン成功");

    // ③ 全レコード取得（ページネーション）
    const allRows = [];
    let start = 0;
    while (true) {
      const [, , listRes] = await _doReq(
        "GET",
        `/teambase/app/${APP_ID}/table/${TABLE_ID}/record?start=${start}&count=${PAGE_SIZE}`,
        cookies,
        newCsrf,
        null,
      );
      const rows = listRes?.response_data?.rows || [];
      allRows.push(...rows);
      if (rows.length < PAGE_SIZE) break;
      start += PAGE_SIZE;
    }
    log(`全レコード数: ${allRows.length}件`);

    // ファイルがあるレコードを DB に同期用データとして抽出
    const fileRecords = [];
    for (const row of allRows) {
      const recordId = row.id;
      const resumePath = parseFilePath(row[FIELD_RESUME]);
      const cvPath = parseFilePath(row[FIELD_CV]);

      if (resumePath) {
        fileRecords.push({
          recordId,
          fieldId: FIELD_RESUME,
          filePath: resumePath,
          name: row[FIELD_NAME] || `ID:${recordId}`,
        });
      }
      if (cvPath) {
        fileRecords.push({
          recordId,
          fieldId: FIELD_CV,
          filePath: cvPath,
          name: row[FIELD_NAME] || `ID:${recordId}`,
        });
      }
    }
    log(`ファイル付きレコード数: ${fileRecords.length}件`);

    // ④ DB 同期（新規→pending、差し替え→pending、リトライ対象→pending）
    const syncResult = syncRecords(db, fileRecords);
    log(
      `DB同期: 新規${syncResult.newCount}件, 差し替え${syncResult.replacedCount}件`,
    );

    // ⑤ pending レコードのみ処理
    let pendingRows = getPendingRecords(db);
    log(`処理対象（pending）: ${pendingRows.length}件`);

    if (dryRun) {
      pendingRows = pendingRows.slice(0, dryRunLimit);
      log(`[DRY-RUN] 処理件数を ${dryRunLimit} 件に制限します`);
    }

    if (pendingRows.length === 0) {
      log("処理対象なし。終了します。");
      db.close();
      return { date: today, success: 0, errors: [], notified: false };
    }

    // レコードIDから氏名を引くためのマップ
    const nameMap = {};
    for (const rec of fileRecords) {
      nameMap[`${rec.recordId}_${rec.fieldId}`] = rec.name;
    }

    let successCount = 0;
    const firstTimeErrors = [];

    for (const row of pendingRows) {
      const name =
        nameMap[`${row.record_id}_${row.field_id}`] || `ID:${row.record_id}`;

      try {
        // ファイルダウンロード
        const buf = await _downloadFile(row.file_path, cookies);

        // テキスト抽出
        const { method, text } = await _extractText(buf, row.file_path);
        const formatted = formatText(text);
        const finalText = formatted.substring(0, MAX_TEXT_LENGTH);

        if (method === "unsupported" || !finalText.trim()) {
          if (dryRun) {
            log(
              `[DRY-RUN] [${row.record_id}] ${name} — ${method}（DB更新スキップ）`,
            );
            await sleep(500);
            continue;
          }
          if (method === "unsupported") {
            _markError(db, row.id, "unsupported", "非対応ファイル形式");
            if (row.error_count === 0) {
              firstTimeErrors.push({
                name,
                description: errorTypeLabel("unsupported"),
              });
            }
          } else {
            // テキストが空の場合も処理済みとする
            _markProcessed(db, row.id);
            successCount++;
          }
          log(
            `${method === "unsupported" ? "UNSUPPORTED" : "EMPTY"} [${row.record_id}] ${name}`,
          );
          await sleep(500);
          continue;
        }

        // DRY_RUN 時は UnitBase 書き込み・DB 更新をスキップ
        if (dryRun) {
          log(
            `[DRY-RUN] [${row.record_id}] ${name} — ${method}, ${finalText.length}文字（書き込み・DB更新スキップ）`,
          );
          successCount++;
          await sleep(500);
          continue;
        }

        // UnitBase に書き込み
        const [, , recRes] = await _doReq(
          "GET",
          `/teambase/app/${APP_ID}/table/${TABLE_ID}/record/${row.record_id}`,
          cookies,
          newCsrf,
          null,
        );
        const latestRow = recRes?.response_data?.rows?.[0];
        if (!latestRow) {
          throw new Error(
            `レコード取得失敗: record_id=${row.record_id} のレスポンスが空です`,
          );
        }
        const dbVersion = recRes?.response_data?.dbtable_version;

        const reqData = { ...latestRow };
        reqData[FIELD_ID] = finalText;
        delete reqData.updated_by;
        delete reqData.created_by;
        delete reqData.updated_by_name;
        delete reqData.created_by_name;
        delete reqData.url;
        delete reqData.record_comment;
        reqData.repeat_items = { rows: [], count: 1 };
        reqData.dbtable_version = dbVersion;
        reqData.layout_id = LAYOUT_ID;

        const Q =
          "?isOpenToNew=false&skipApproverLayoutsExistsCheck=false&skipApproverLayoutsPermissionCheck=false";
        const [putStatusCode, , putRes] = await _doReq(
          "PUT",
          `/teambase/app/${APP_ID}/table/${TABLE_ID}/record/${row.record_id}${Q}`,
          cookies,
          newCsrf,
          { request_data: reqData },
        );

        const isBodyError =
          typeof putRes === "object" && putRes.status === "error";
        const putSuccess =
          !isBodyError &&
          ((typeof putRes === "object" && putRes.status === "200") ||
            putStatusCode === 200);
        if (putSuccess) {
          _markProcessed(db, row.id);
          successCount++;
          log(
            `OK [${row.record_id}] ${name} (${method}, ${finalText.length}文字)`,
          );
        } else {
          const errMsg = putRes.status_info?.code || "UnitBase書き込みエラー";
          _markError(db, row.id, "write_error", errMsg);
          if (row.error_count === 0) {
            firstTimeErrors.push({
              name,
              description: errorTypeLabel("write_error"),
            });
          }
          log(`WRITE_ERROR [${row.record_id}] ${name} - ${errMsg}`);
        }
      } catch (e) {
        const errorType = classifyError(e, row.file_path);
        log(`ERROR [${row.record_id}] ${name} - ${errorType}: ${e.message}`);
        if (dryRun) {
          log(`[DRY-RUN] エラー記録スキップ: ${errorType}`);
          await sleep(500);
          continue;
        }
        _markError(db, row.id, errorType, e.message || String(e));
        if (row.error_count === 0) {
          firstTimeErrors.push({ name, description: errorTypeLabel(errorType) });
        }
      }

      await sleep(500);
    }

    // ⑥ LINE 通知
    let notified = false;
    if (dryRun) {
      log("[DRY-RUN] LINE通知スキップ");
    } else if (successCount > 0 || firstTimeErrors.length > 0) {
      const message = buildNotificationMessage(
        today,
        successCount,
        firstTimeErrors,
      );
      log(`通知送信:\n${message}`);
      try {
        await _sendLineMessage(message);
        notified = true;
      } catch (e) {
        log(`LINE通知エラー: ${e.message}`);
      }
    } else {
      log("通知対象なし（成功0件・初回エラー0件）");
    }

    const summary = {
      date: today,
      success: successCount,
      errors: firstTimeErrors,
      notified,
    };
    log(`=== 処理完了 === ${JSON.stringify(summary)}`);
    db.close();
    return summary;
  } catch (e) {
    db.close();
    throw e;
  }
}

// ----------------------------
// エクスポート（テスト用）& 実行
// ----------------------------
module.exports = {
  initDb,
  syncRecords,
  getPendingRecords,
  markProcessed,
  markError,
  classifyError,
  buildNotificationMessage,
  errorTypeLabel,
  parseFilePath,
  formatText,
  MAX_RETRY_COUNT,
  main,
};

if (require.main === module) {
  main().catch((e) => {
    log(`FATAL: ${e.message}`);
    process.exit(1);
  });
}
