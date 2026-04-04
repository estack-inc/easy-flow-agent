/**
 * daily_process.test.js
 * daily_process.js のユニットテスト（Node.js assert 使用）
 *
 * 実行方法: node /data/workspace/scripts/daily_process.test.js
 * better-sqlite3 がインストール済みであること。
 */

const assert = require("assert");
const path = require("path");

const {
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
} = require(path.join(__dirname, "daily_process.js"));

let testCount = 0;
let passCount = 0;
let failCount = 0;

function test(name, fn) {
  testCount++;
  try {
    fn();
    passCount++;
    console.log(`  ✅ ${name}`);
  } catch (e) {
    failCount++;
    console.log(`  ❌ ${name}`);
    console.log(`     ${e.message}`);
  }
}

function createTestDb() {
  return initDb(":memory:");
}

// ==============================
// 正常系テスト
// ==============================
console.log("\n=== 正常系 ===");

test("未処理レコードが pending として登録される", () => {
  const db = createTestDb();
  const records = [
    { recordId: 1, fieldId: 3606, filePath: "/file/a.pdf" },
    { recordId: 2, fieldId: 3690, filePath: "/file/b.docx" },
  ];
  syncRecords(db, records);
  const pending = getPendingRecords(db);
  assert.strictEqual(pending.length, 2);
  assert.strictEqual(pending[0].status, "pending");
  assert.strictEqual(pending[1].status, "pending");
  db.close();
});

test("処理成功で status=processed になる", () => {
  const db = createTestDb();
  syncRecords(db, [{ recordId: 1, fieldId: 3606, filePath: "/file/a.pdf" }]);
  const pending = getPendingRecords(db);
  markProcessed(db, pending[0].id);
  const row = db
    .prepare("SELECT * FROM file_processing WHERE id = ?")
    .get(pending[0].id);
  assert.strictEqual(row.status, "processed");
  assert.ok(row.processed_at);
  db.close();
});

test("処理済みレコードは再処理されない", () => {
  const db = createTestDb();
  syncRecords(db, [{ recordId: 1, fieldId: 3606, filePath: "/file/a.pdf" }]);
  const pending1 = getPendingRecords(db);
  markProcessed(db, pending1[0].id);

  // 同じレコードを再同期
  syncRecords(db, [{ recordId: 1, fieldId: 3606, filePath: "/file/a.pdf" }]);
  const pending2 = getPendingRecords(db);
  assert.strictEqual(pending2.length, 0);
  db.close();
});

test("ファイル差し替えで新レコードが pending 登録される", () => {
  const db = createTestDb();
  syncRecords(db, [{ recordId: 1, fieldId: 3606, filePath: "/file/a.pdf" }]);
  const pending1 = getPendingRecords(db);
  markProcessed(db, pending1[0].id);

  // ファイルパスが変更 → 差し替え検知
  syncRecords(db, [{ recordId: 1, fieldId: 3606, filePath: "/file/a_v2.pdf" }]);
  const pending2 = getPendingRecords(db);
  assert.strictEqual(pending2.length, 1);
  assert.strictEqual(pending2[0].file_path, "/file/a_v2.pdf");
  db.close();
});

test("処理対象なしの場合 pending が空", () => {
  const db = createTestDb();
  syncRecords(db, [{ recordId: 1, fieldId: 3606, filePath: "/file/a.pdf" }]);
  const pending = getPendingRecords(db);
  markProcessed(db, pending[0].id);

  // 同じレコードで同期しても pending は空
  syncRecords(db, [{ recordId: 1, fieldId: 3606, filePath: "/file/a.pdf" }]);
  assert.strictEqual(getPendingRecords(db).length, 0);
  db.close();
});

// ==============================
// エラー系テスト
// ==============================
console.log("\n=== エラー系 ===");

test("パスワード付きPDF: error_type=password_protected で記録", () => {
  const db = createTestDb();
  syncRecords(db, [{ recordId: 1, fieldId: 3606, filePath: "/file/a.pdf" }]);
  const pending = getPendingRecords(db);
  markError(db, pending[0].id, "password_protected", "password required");
  const row = db
    .prepare("SELECT * FROM file_processing WHERE id = ?")
    .get(pending[0].id);
  assert.strictEqual(row.status, "error");
  assert.strictEqual(row.error_type, "password_protected");
  assert.strictEqual(row.error_count, 1);
  assert.ok(row.first_error_at);
  db.close();
});

test("破損ファイル: error_type=corrupted で記録", () => {
  const db = createTestDb();
  syncRecords(db, [{ recordId: 1, fieldId: 3606, filePath: "/file/a.pdf" }]);
  const pending = getPendingRecords(db);
  markError(db, pending[0].id, "corrupted", "file is corrupt");
  const row = db
    .prepare("SELECT * FROM file_processing WHERE id = ?")
    .get(pending[0].id);
  assert.strictEqual(row.status, "error");
  assert.strictEqual(row.error_type, "corrupted");
  db.close();
});

test("password_protected / corrupted / unsupported は翌日もスキップ", () => {
  const db = createTestDb();
  const permanentTypes = ["password_protected", "corrupted", "unsupported"];

  for (const errorType of permanentTypes) {
    const recordId = permanentTypes.indexOf(errorType) + 100;
    syncRecords(db, [
      { recordId, fieldId: 3606, filePath: `/file/${errorType}.pdf` },
    ]);
    const pending = getPendingRecords(db);
    const row = pending.find((r) => r.record_id === recordId);
    markError(db, row.id, errorType, "test error");
  }

  // retry 処理実行（syncRecords 内部で行われる）— 新レコードなしで再同期
  syncRecords(db, []);

  // 永久エラーは pending に戻らない
  const pendingAfter = getPendingRecords(db);
  assert.strictEqual(
    pendingAfter.length,
    0,
    `永久エラー ${permanentTypes.join("/")} が pending に戻ってはいけない`,
  );
  db.close();
});

test("write_error は error_count < 3 で翌日 pending に戻る", () => {
  const db = createTestDb();
  syncRecords(db, [{ recordId: 1, fieldId: 3606, filePath: "/file/a.pdf" }]);
  const pending = getPendingRecords(db);
  markError(db, pending[0].id, "write_error", "API error");

  // error_count=1 < 3 → retry 対象
  syncRecords(db, [{ recordId: 1, fieldId: 3606, filePath: "/file/a.pdf" }]);
  const pendingAfter = getPendingRecords(db);
  assert.strictEqual(pendingAfter.length, 1);
  assert.strictEqual(pendingAfter[0].record_id, 1);
  db.close();
});

test("unexpected は error_count < 3 で翌日 pending に戻る", () => {
  const db = createTestDb();
  syncRecords(db, [{ recordId: 1, fieldId: 3606, filePath: "/file/a.pdf" }]);
  const pending = getPendingRecords(db);
  markError(db, pending[0].id, "unexpected", "unknown error");

  // error_count=1 < 3 → retry 対象
  syncRecords(db, [{ recordId: 1, fieldId: 3606, filePath: "/file/a.pdf" }]);
  const pendingAfter = getPendingRecords(db);
  assert.strictEqual(pendingAfter.length, 1);
  db.close();
});

test("write_error / unexpected が error_count >= 3 でスキップされる", () => {
  const db = createTestDb();
  syncRecords(db, [{ recordId: 1, fieldId: 3606, filePath: "/file/a.pdf" }]);

  // 3回エラーを繰り返す
  for (let i = 0; i < MAX_RETRY_COUNT; i++) {
    const pending = getPendingRecords(db);
    const row = pending.find((r) => r.record_id === 1);
    if (!row) break;
    markError(db, row.id, "write_error", `error ${i + 1}`);
    // 再同期で retry 判定
    syncRecords(db, [{ recordId: 1, fieldId: 3606, filePath: "/file/a.pdf" }]);
  }

  // error_count >= 3 → pending に戻らない
  const pendingFinal = getPendingRecords(db);
  assert.strictEqual(
    pendingFinal.length,
    0,
    "error_count >= 3 のレコードは pending に戻ってはいけない",
  );

  // DB 上のレコードを確認
  const row = db
    .prepare(
      "SELECT * FROM file_processing WHERE record_id = 1 ORDER BY created_at DESC LIMIT 1",
    )
    .get();
  assert.strictEqual(row.status, "error");
  assert.ok(row.error_count >= MAX_RETRY_COUNT);
  db.close();
});

test("first_error_at は初回エラー時のみセットされる", () => {
  const db = createTestDb();
  syncRecords(db, [{ recordId: 1, fieldId: 3606, filePath: "/file/a.pdf" }]);
  const pending = getPendingRecords(db);

  markError(db, pending[0].id, "write_error", "error 1");
  const row1 = db
    .prepare("SELECT * FROM file_processing WHERE id = ?")
    .get(pending[0].id);
  const firstErrorAt = row1.first_error_at;
  assert.ok(firstErrorAt);

  // 再エラー時は first_error_at が変わらない
  // pending に戻す
  db.prepare("UPDATE file_processing SET status = 'pending' WHERE id = ?").run(
    pending[0].id,
  );
  markError(db, pending[0].id, "write_error", "error 2");
  const row2 = db
    .prepare("SELECT * FROM file_processing WHERE id = ?")
    .get(pending[0].id);
  assert.strictEqual(row2.first_error_at, firstErrorAt);
  assert.strictEqual(row2.error_count, 2);
  db.close();
});

// ==============================
// エラー分類テスト
// ==============================
console.log("\n=== エラー分類 ===");

test("classifyError: password → password_protected", () => {
  assert.strictEqual(
    classifyError(new Error("password required"), "/file/a.pdf"),
    "password_protected",
  );
});

test("classifyError: encrypted → password_protected", () => {
  assert.strictEqual(
    classifyError(new Error("file is encrypted"), "/file/a.pdf"),
    "password_protected",
  );
});

test("classifyError: corrupt → corrupted", () => {
  assert.strictEqual(
    classifyError(new Error("file is corrupt"), "/file/a.pdf"),
    "corrupted",
  );
});

test("classifyError: invalid → corrupted", () => {
  assert.strictEqual(
    classifyError(new Error("invalid format"), "/file/a.pdf"),
    "corrupted",
  );
});

test("classifyError: 非対応拡張子 → unsupported", () => {
  assert.strictEqual(
    classifyError(new Error("something went wrong"), "/file/a.zip"),
    "unsupported",
  );
});

test("classifyError: 対応拡張子のその他エラー → unexpected", () => {
  assert.strictEqual(
    classifyError(new Error("something went wrong"), "/file/a.pdf"),
    "unexpected",
  );
});

// ==============================
// 通知系テスト
// ==============================
console.log("\n=== 通知系 ===");

test("成功+初回エラーの通知メッセージが仕様通り", () => {
  const msg = buildNotificationMessage("2026-04-04", 5, [
    { name: "川添 雄大", description: "パスワード付きファイル" },
    { name: "後藤 広幸", description: "ファイル破損" },
  ]);
  assert.ok(msg.includes("【職歴・スキル 自動処理】2026-04-04"));
  assert.ok(msg.includes("✅ 処理完了: 5件"));
  assert.ok(msg.includes("❌ エラー（初回）: 2件"));
  assert.ok(msg.includes("・川添 雄大 — パスワード付きファイル"));
  assert.ok(msg.includes("・後藤 広幸 — ファイル破損"));
});

test("成功のみの場合はエラーセクションなし", () => {
  const msg = buildNotificationMessage("2026-04-04", 3, []);
  assert.ok(msg.includes("✅ 処理完了: 3件"));
  assert.ok(!msg.includes("❌"));
});

test("初回エラーのみの場合は成功セクションなし", () => {
  const msg = buildNotificationMessage("2026-04-04", 0, [
    { name: "テスト太郎", description: "ファイル破損" },
  ]);
  assert.ok(!msg.includes("✅"));
  assert.ok(msg.includes("❌ エラー（初回）: 1件"));
});

test("errorTypeLabel が正しい日本語を返す", () => {
  assert.strictEqual(errorTypeLabel("password_protected"), "パスワード付きファイル");
  assert.strictEqual(errorTypeLabel("corrupted"), "ファイル破損");
  assert.strictEqual(errorTypeLabel("unsupported"), "非対応形式");
  assert.strictEqual(errorTypeLabel("write_error"), "書き込みエラー");
  assert.strictEqual(errorTypeLabel("unexpected"), "予期しないエラー");
});

// ==============================
// ユーティリティテスト
// ==============================
console.log("\n=== ユーティリティ ===");

test("parseFilePath: タブ区切りから最後の部分を取得", () => {
  assert.strictEqual(
    parseFilePath("filename\t/table/126/record/1/0/3606/file0.pdf"),
    "/table/126/record/1/0/3606/file0.pdf",
  );
});

test("parseFilePath: タブなしの場合そのまま返す", () => {
  assert.strictEqual(
    parseFilePath("/table/126/record/1/0/3606/file0.pdf"),
    "/table/126/record/1/0/3606/file0.pdf",
  );
});

test("parseFilePath: null/空文字の場合 null を返す", () => {
  assert.strictEqual(parseFilePath(null), null);
  assert.strictEqual(parseFilePath(""), null);
});

test("formatText: 連続空行を2行に圧縮", () => {
  const result = formatText("a\n\n\n\nb");
  assert.ok(!result.includes("\n\n\n"));
});

test("formatText: 空文字列は空文字列を返す", () => {
  assert.strictEqual(formatText(""), "");
  assert.strictEqual(formatText(null), "");
});

// ==============================
// DB 整合性テスト
// ==============================
console.log("\n=== DB 整合性 ===");

test("UNIQUE 制約: 同一 record_id + field_id + file_path は重複しない", () => {
  const db = createTestDb();
  syncRecords(db, [{ recordId: 1, fieldId: 3606, filePath: "/file/a.pdf" }]);
  // 同じレコードを再度同期
  syncRecords(db, [{ recordId: 1, fieldId: 3606, filePath: "/file/a.pdf" }]);
  const count = db
    .prepare("SELECT COUNT(*) as cnt FROM file_processing")
    .get().cnt;
  assert.strictEqual(count, 1);
  db.close();
});

test("同一 record_id で異なる field_id は別レコード", () => {
  const db = createTestDb();
  syncRecords(db, [
    { recordId: 1, fieldId: 3606, filePath: "/file/resume.pdf" },
    { recordId: 1, fieldId: 3690, filePath: "/file/cv.pdf" },
  ]);
  const count = db
    .prepare("SELECT COUNT(*) as cnt FROM file_processing")
    .get().cnt;
  assert.strictEqual(count, 2);
  db.close();
});

// ==============================
// 結果サマリー
// ==============================
console.log("\n========================================");
console.log(`テスト結果: ${passCount}/${testCount} passed, ${failCount} failed`);
console.log("========================================\n");

if (failCount > 0) {
  process.exit(1);
}
