#!/usr/bin/env node
'use strict';

const fs = require('fs');

const SEVERITY_ORDER = {
  critical: 0,
  major: 1,
  minor: 2,
};

const SEVERITY_LABEL = {
  critical: '🔴 重大',
  major: '🟡 要修正',
  minor: 'ℹ️ 補足',
};

const CHECKLIST_LABEL = {
  ok: '✅ 問題なし',
  finding: '⚠️ 指摘あり',
  skipped: '⏭️ スキップ済',
  not_applicable: '➖ 対象外',
};

// finding.id は F-001, F-002 のような形式を要求する。これにより AI 出力が
// 改行 / backtick / HTML comment / Markdown 構造文字を含む id を返した場合に
// validation で reject できる。renderMarkdown では finding.id を Markdown
// 見出しの一部に埋め込むため、安全な形式を強制する。
const FINDING_ID_PATTERN = /^F-[0-9]{3,}$/;

// 注意: このファイルは umito-spec から各実装リポへ overwrite 配布される
// 「リポ非依存」コードである。required_checklist_names のような **リポ固有の
// データを定数として埋め込んではならない**。チェックリスト名は必ず
// workflow が REQUIRED_CHECKLIST_NAMES_FILE / _JSON 経由で供給する。
// (旧版は umito-spec 固有の DEFAULT_CHECKLIST_NAMES を fallback に持っており、
//  配布先リポで「umito-spec のチェックリスト名」が紛れ込む契約不整合があった。)

function parseChecklistNames(raw, source) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    fail(`${source} は JSON string array である必要があります: ${error.message}`);
  }
  if (!Array.isArray(parsed) || parsed.length === 0 || !parsed.every((item) => typeof item === 'string' && item.trim() !== '')) {
    fail(`${source} は 1 件以上の空でない string array である必要があります。`);
  }
  return parsed.map((item) => item.trim());
}

function loadRequiredChecklistNames() {
  if (process.env.REQUIRED_CHECKLIST_NAMES_JSON) {
    return parseChecklistNames(process.env.REQUIRED_CHECKLIST_NAMES_JSON, 'REQUIRED_CHECKLIST_NAMES_JSON');
  }
  if (process.env.REQUIRED_CHECKLIST_NAMES_FILE) {
    return parseChecklistNames(fs.readFileSync(process.env.REQUIRED_CHECKLIST_NAMES_FILE, 'utf8'), 'REQUIRED_CHECKLIST_NAMES_FILE');
  }
  // リポ固有の default は持たない。workflow が必ず env で供給する契約なので、
  // どちらの env も無い場合は fail-loud にする (誤って他リポのチェックリストで
  // validate してしまう事故を防ぐ)。
  fail(
    'REQUIRED_CHECKLIST_NAMES_JSON または REQUIRED_CHECKLIST_NAMES_FILE が必要です。' +
      'このスクリプトはリポ非依存のため、チェックリスト名は workflow から供給してください。',
  );
}

function usage() {
  console.error('Usage: node scripts/codex-review-json.cjs <validate|render|verdict> <review-result.json>');
}

function fail(message) {
  throw new Error(message);
}

function readReviewJson(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8').trim();
  if (!raw) {
    fail('review JSON が空です。');
  }

  try {
    return JSON.parse(raw);
  } catch (error) {
    fail(`review JSON は前後テキストなしの JSON object のみ許可します: ${error.message}`);
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function assertFindingId(value, path, errors) {
  // finding.id / finding_ids[] のような id 文字列専用の assert。
  // renderMarkdown では `#### F-001 ...` のように見出しに埋め込まれるため、
  // 形式を F-NNN に強制して任意文字列の注入を防ぐ。
  if (!assertString(value, path, errors, { maxLength: 20 })) {
    return false;
  }
  if (!FINDING_ID_PATTERN.test(value)) {
    // `SEC-001` のように「finding id らしい形」だが F-NNN でないものは、
    // 正規化が対応する finding を見つけられなかった参照切れである
    // 可能性が高い。単なる形式エラーとして返すと、reviewer が再試行で
    // 「形を F-NNN に直す」方向へ進み、無関係な finding を指す id を
    // 作ってしまう。原因を名指しする。
    if (/^[A-Za-z]{2,12}-[0-9]+$/.test(String(value).trim())) {
      errors.push(`${path} "${value}" に対応する finding がありません。`
        + ' findings 側に同じ id の項目を追加するか、参照を実在する'
        + ' finding の id に直してください。');
    } else {
      errors.push(`${path} は F-001 のような形式である必要があります。`);
    }
    return false;
  }
  return true;
}

function assertSafeEvidencePath(value, path, errors) {
  // evidence.path は renderMarkdown で `\`<path>:line\`` のように埋め込まれる。
  // path に backtick / 改行 / HTML comment が含まれると、code 表記の閉じや
  // verdict marker 偽装に転用できるため reject する。
  if (!assertString(value, path, errors, { maxLength: 300 })) {
    return false;
  }
  if (/[`\r\n]/.test(value) || value.includes('<!--') || value.includes('-->')) {
    errors.push(`${path} は backtick、改行、HTML comment を含められません。`);
    return false;
  }
  return true;
}

function assertObject(value, path, errors) {
  if (!isPlainObject(value)) {
    errors.push(`${path} は object である必要があります。`);
    return false;
  }
  return true;
}

function assertString(value, path, errors, options = {}) {
  if (typeof value !== 'string') {
    errors.push(`${path} は string である必要があります。`);
    return false;
  }
  if (!options.allowEmpty && value.trim() === '') {
    errors.push(`${path} は空文字にできません。`);
    return false;
  }
  if (options.maxLength && value.length > options.maxLength) {
    errors.push(`${path} は ${options.maxLength} 文字以内にしてください。`);
    return false;
  }
  return true;
}

function assertStringArray(value, path, errors, options = {}) {
  if (!Array.isArray(value)) {
    errors.push(`${path} は string array である必要があります。`);
    return false;
  }
  if (options.nonEmpty && value.length === 0) {
    errors.push(`${path} は 1 件以上必要です。`);
    return false;
  }
  value.forEach((item, index) => {
    assertString(item, `${path}[${index}]`, errors);
  });
  return true;
}

function assertEnum(value, allowed, path, errors) {
  if (!allowed.includes(value)) {
    errors.push(`${path} は ${allowed.join(' / ')} のいずれかである必要があります。`);
    return false;
  }
  return true;
}

function assertAllowedKeys(value, allowedKeys, path, errors) {
  Object.keys(value).forEach((key) => {
    if (!allowedKeys.includes(key)) {
      errors.push(`${path}.${key} は schema に存在しないキーです。`);
    }
  });
}

/**
 * Codex reviewer の出力に繰り返し見られる軽微な逸脱を、validation 前に
 * 機械的に矯正する。validate→render→verdict のすべての経路から使う。
 *
 * 「bot のフォーマットミス」と「実際の指摘」を分離するのがこの層の役割。
 * 前者（= 契約の本質である verdict / reviewed_head_sha / findings の妥当性を
 * 変えない形式的逸脱）は機械補正で吸収し、F-JSON-CONTRACT で PR を倒さない。
 * 後者（findings の中身・blocking 整合・SHA 不一致など）は触らず validator に
 * そのまま報告させる。
 *
 * 矯正する具体的な逸脱:
 *
 *   (1) findings[].checked_scope を string で返してくる
 *       → そのまま 1 要素の array に包む
 *
 *   (2) findings[].evidence を object 単体で返してくる
 *       → そのまま 1 要素の array に包む
 *
 *   (3) checklist[].name から「を確認する」末尾だけ落として返してくる
 *       → required_checklist_names と suffix 除去で一致するものに canonical 化
 *       （suffix を機械的に補える場合に限る。判別できないものは触らない）
 *
 *   (4) checklist[].finding_ids が undefined
 *       → []
 *
 *   (5) finding.id / finding_ids[] を `F-1` `F-42` のようにゼロ詰めなしで返す
 *       → `F-001` `F-042` に canonical 化（findings と checklist 参照を一括変換）
 *
 *   (6) checklist 件数の過不足
 *       → 不足している required 項目を status=not_applicable で補完。
 *         required にマッチしない余剰項目は、finding を参照していなければ
 *         （= 純粋なノイズなら）落とす。finding を参照している余剰項目は
 *         実シグナルの可能性があるため残し、validator に判断させる。
 *
 *   (7) checklist[].status と finding_ids の不整合
 *       → finding_ids の有無と参照先 finding の skipped 状態から status を
 *         機械的に導出して上書きする（finding 側の中身は変えない）。
 *
 * 矯正は in-place で行う。判別不能な逸脱は触らず、後続 validator にそのまま
 * 報告させる。
 */
function normalizeChecklistName(name) {
  if (typeof name !== 'string') return name;
  let s = name.trim();
  s = s.replace(/[。.]+$/, '');
  // 観測される reviewer 逸脱 1: 末尾「を確認する」の脱落。
  // 「ことを」「のを」も含めて剥がすと「こと」「の」など意味のある前置詞ごと
  // 落として別チェック項目と衝突するリスクがあるため、剥がすのは「を確認する」だけ。
  s = s.replace(/を確認する$/, '');
  // 観測される reviewer 逸脱 2: colon 区切り運用への不一致。
  // 配布先リポ (bff 等) では required_checklist_names を
  // `jq -c '[.[] | split(":")[0]]'` で短縮形にしている運用があり、reviewer が
  // チェック項目の full text (": <description>" 付き) を返すと exact match
  // しない。「コロン以前」を canonical 形として扱い、両者を寄せる。
  // 「checked_scope」のような英数字 only 用語にぶつからないよう、コロンより
  // 前にスペース等の自然区切りがあることだけ要求 (= 行頭直後のコロンは無視)。
  const colonIdx = s.indexOf(':');
  if (colonIdx > 0) {
    s = s.slice(0, colonIdx).trim();
  }
  return s;
}

// reviewer は finding id を表記ゆれで返すことが多い。validator が要求する
// `F-NNN`（FINDING_ID_PATTERN = /^F-[0-9]{3,}$/、3 桁以上ゼロ詰め）へ canonical
// 化する。救済対象はあくまで「id の表記ゆれ」のみで、次のいずれにも対応する:
//   - ゼロ詰めなし:        F-1   → F-001 / F-12  → F-012
//   - ハイフンなし:        F001  → F-001 / F123  → F-123
//   - ハイフン・ゼロ詰め無し: F1    → F-001
//   - 既に正規:            F-001 → F-001（変化なし）
//   - 4 桁以上:            F-9999 → F-9999（切り詰めず温存）
//
// 正規表現 `/^F-?0*([0-9]+)$/`:
//   - `-?`  ハイフンの有無を吸収
//   - `0*`  先頭ゼロを剥がし、有効数字だけを capture group に残す
//   - capture を 3 桁へ padStart して `F-` を必ず付与する（桁数 3 は既存の
//     ゼロ詰め桁数仕様を踏襲。padStart は伸ばすだけで 4 桁以上は切らない）
// 数値部を持たない / 形式が全く違うもの（`FX` `F-abc` 小文字 `f-1` 等）は
// 触らず原文を返し、validator にそのまま報告させる（過剰補正で実シグナルを
// 握りつぶさない）。
function canonicalizeFindingId(id) {
  if (typeof id !== 'string') return id;
  const trimmed = id.trim();
  // F 接頭のゼロ詰め / ハイフン揺れ
  const m = trimmed.match(/^F-?0*([0-9]+)$/);
  if (m) return `F-${m[1].padStart(3, '0')}`;
  // SEC-001 / BUG-12 のような意味のあるプレフィックス。
  // reviewer は指摘の性質を id に込めたがるが、契約は F-NNN 固定。
  // 弾くと指摘そのものが F-JSON-CONTRACT に化けて内容が人間に届かない
  // (2026-08-11 に 1 日 3 回発生し、critical/blocking の指摘が失われた)。
  // 番号は温存する。複数 finding の対応が崩れるため潰さない。
  const p = trimmed.match(/^[A-Z]{2,12}-0*([0-9]+)$/);
  if (p) return `F-${p[1].padStart(3, '0')}`;
  return id;
}

/**
 * findings 全体の id を canonical へ寄せる。単体変換だけだと
 * SEC-001 と BUG-001 が同じ F-001 に潰れ、checklist の参照が片方に
 * 寄って指摘が消える。衝突したら空き番号へずらす。
 *
 * 返り値は「元 id → 新 id」の対応表。checklist.finding_ids の
 * 張り替えに使う。
 */
/**
 * remap の検索キー。prefix は保持しつつ、空白・ゼロ詰め・F 接頭の
 * ハイフン揺れを吸収する。
 *
 * checklist 側の表記が findings と揺れる（findings が SEC-001 で
 * checklist が SEC-1 など）。元文字列の完全一致でしか引けないと、
 * 衝突後の割り当てに追従できず参照が失われる。
 */
function findingIdKey(id) {
  if (typeof id !== 'string') return id;
  const s = id.trim();
  const m = s.match(/^([A-Za-z]+)-?0*([0-9]+)$/);
  if (!m) return s.toUpperCase();
  return `${m[1].toUpperCase()}-${m[2]}`;
}

function canonicalizeFindingIds(findings) {
  const remap = new Map();
  if (!Array.isArray(findings)) return remap;

  const entries = [];
  for (const f of findings) {
    if (!isPlainObject(f) || typeof f.id !== 'string') continue;
    entries.push({ finding: f, original: f.id, want: canonicalizeFindingId(f.id) });
  }

  // 1 パス目: 各 finding の希望番号を集め、番号ごとに代表を 1 件だけ確定する。
  // 逐次割り当てだと、先に来た衝突分が後続 finding の希望番号を奪う
  // (SEC-001 / BUG-001 / PERF-002 で BUG-001 が F-002 を取ってしまう)。
  // 変換不要なもの (既に canonical) を優先して代表にする。
  const claimed = new Map();
  for (const e of entries) {
    if (e.want === e.original && !claimed.has(e.want)) claimed.set(e.want, e);
  }
  for (const e of entries) {
    if (!claimed.has(e.want)) claimed.set(e.want, e);
  }

  const taken = new Set(claimed.keys());

  // 2 パス目: 代表になれなかった余剰分だけを、誰も要求していない番号へ回す。
  for (const e of entries) {
    let canonical = e.want;
    if (claimed.get(canonical) !== e) {
      // 3 桁の範囲 (F-001..F-999) 内で空きを探す。単純に加算すると
      // F-999 の次が F-1000 になり、契約違反で指摘全体が失われる。
      const base = Number.parseInt(canonical.slice(2), 10);
      const startNum = Number.isNaN(base) || base < 1 || base > 999 ? 1 : base;
      let candidate = null;
      for (let i = 1; i <= 999; i += 1) {
        const n = ((startNum - 1 + i) % 999) + 1;
        const c = `F-${String(n).padStart(3, '0')}`;
        if (!taken.has(c)) {
          candidate = c;
          break;
        }
      }
      if (candidate === null) {
        // 999 件すべて埋まっている。現実には起こらないが、黙って
        // 契約違反の id を作るより原文のまま validator に落とさせる。
        continue;
      }
      canonical = candidate;
      taken.add(canonical);
    }
    // 元 id → canonical 群を保持する。1 対 1 の Map では同じ元 id が
    // 複数あるとき後勝ちになり、checklist の参照が片方へ潰れて指摘が消える。
    //
    // id が変わらなかった代表も必ず記録する。記録しないと、同じ id が
    // 2 件あるケース (両方 F-001) で remap は後者だけを持ち、checklist が
    // 後者へのみ展開されて代表への参照が失われる。
    const key = findingIdKey(e.original);
    const list = remap.get(key) || [];
    if (!list.includes(canonical)) list.push(canonical);
    remap.set(key, list);
    e.finding.id = canonical;
  }
  return remap;
}

/**
 * enum 文字列を許可値に寄せる。reviewer が long-form prose で書いて
 * きたケースを救う defensive normalize。
 *
 * 判定順:
 *   1. 完全一致 (trim + lower-case) → そのまま正規化
 *   2. 接頭一致 ("low: 理由..." / "low - 理由..." / "low、理由..." 等)
 *      → 接頭の enum を採用
 *   3. 単語境界一致 (英字以外で挟まれた enum 単語が含まれる)
 *      → 該当 enum を採用
 *   4. いずれも一致しない場合 → fallback を返す
 *
 * fallback は呼び出し側で「intermediate / 不明」と読める値 ("medium") を
 * 渡す前提。`null` を渡せばそのまま null になり、後続 validator が
 * 失格にする (古い動作)。
 */
function normalizeEnumString(value, allowed, fallback) {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (!trimmed) return value;
  const lower = trimmed.toLowerCase();
  // 1. 完全一致
  for (const v of allowed) {
    if (lower === v) return v;
  }
  // 2. 接頭一致 (区切り文字: コロン / 全角コロン / スペース / 句読点)
  const PREFIX_SEPARATORS = /^([a-z]+)[\s:：、。,.\-—–]+/;
  const prefixMatch = lower.match(PREFIX_SEPARATORS);
  if (prefixMatch && allowed.includes(prefixMatch[1])) {
    return prefixMatch[1];
  }
  // 3. 単語境界一致 (英字でない境界に挟まれた enum)
  for (const v of allowed) {
    const re = new RegExp(`(^|[^a-z])${v}([^a-z]|$)`, 'i');
    if (re.test(trimmed)) return v;
  }
  // 4. fallback
  return fallback;
}

function normalizeReviewJson(review, requiredChecklistNames) {
  if (!isPlainObject(review)) return;

  // (5) finding.id のゼロ詰め canonical 化。findings と checklist の参照を
  // 一括で揃えるため、最初に旧 id → 新 id の対応表を作る。
  const findingIdRemap = canonicalizeFindingIds(review.findings);

  // (1)(2) findings 内の checked_scope / evidence 形状補正、
  // および confidence / false_positive_risk の enum 寄せ。
  if (Array.isArray(review.findings)) {
    review.findings.forEach((finding) => {
      if (!isPlainObject(finding)) return;
      if (typeof finding.checked_scope === 'string') {
        const s = finding.checked_scope.trim();
        finding.checked_scope = s ? [s] : [];
      }
      if (isPlainObject(finding.evidence)) {
        finding.evidence = [finding.evidence];
      }
      // confidence / false_positive_risk が prose / 長文で来た場合、
      // exact / prefix / 単語一致で enum に寄せる。完全に外れる場合は
      // "medium" を入れて、本来の review content (root_cause / required_fix
      // 等) を validation 失敗で潰さないようにする。
      finding.confidence = normalizeEnumString(
        finding.confidence,
        ['high', 'medium', 'low'],
        'medium',
      );
      finding.false_positive_risk = normalizeEnumString(
        finding.false_positive_risk,
        ['high', 'medium', 'low'],
        'medium',
      );
    });
  }

  // (3)(4)(5) checklist 内の name canonical 化 + finding_ids デフォルト
  // + finding_ids[] のゼロ詰め canonical 化
  if (Array.isArray(review.checklist) && Array.isArray(requiredChecklistNames)) {
    // required の normalized → canonical を逆引きできるよう Map を作る
    const canonicalByNormalized = new Map();
    requiredChecklistNames.forEach((req) => {
      canonicalByNormalized.set(normalizeChecklistName(req), req);
    });
    review.checklist.forEach((item) => {
      if (!isPlainObject(item)) return;
      if (item.finding_ids === undefined) {
        item.finding_ids = [];
      }
      // finding_ids も canonical 化して findings 側と整合させる。
      // 1 つの元 id が複数の finding に割り当てられた場合は全部へ展開する
      // （どれか 1 つに潰すと、その checklist 項目から他の指摘が消える）。
      if (Array.isArray(item.finding_ids)) {
        const expanded = [];
        for (const id of item.finding_ids) {
          if (typeof id !== 'string') {
            expanded.push(id);
            continue;
          }
          const mapped = findingIdRemap.get(findingIdKey(id));
          if (mapped && mapped.length) {
            expanded.push(...mapped);
          } else if (/^f-?[0-9]+$/i.test(id.trim())) {
            // 対応する finding が無いが prefix は既に F。`F-1` → `F-001` の
            // ゼロ詰め補正だけを行う。
            expanded.push(canonicalizeFindingId(id));
          } else {
            // 参照切れ。ここで canonical 化すると `SEC-001` が `F-001` へ化け、
            // たまたま同番の無関係な finding（例: BUG-001 由来の F-001）を
            // 指してしまう。validator の「findings に存在しません」検査も
            // すり抜け、人間には正しい根拠に見える誤った引用が残る。
            // 原文のまま落として validator に失格させる。
            expanded.push(id);
          }
        }
        item.finding_ids = [...new Set(expanded)];
      }
      if (typeof item.name !== 'string') return;
      // 既に exact match ならそのまま
      if (requiredChecklistNames.includes(item.name)) return;
      const normalized = normalizeChecklistName(item.name);
      const canonical = canonicalByNormalized.get(normalized);
      if (canonical) {
        item.name = canonical;
      }
    });

    // (6) checklist 件数の過不足を機械補正する。
    reconcileChecklistCount(review, requiredChecklistNames);

    // (7) status と finding_ids の整合を機械補正する。
    reconcileChecklistStatuses(review);
  }
}

/**
 * checklist 件数の過不足を required_checklist_names に追従させる。
 *
 *   - 不足: required にあるが checklist に無い項目を status=not_applicable /
 *     finding_ids=[] で補完する。「未確認」を意味する強い status を入れず、
 *     verdict（blocking finding の有無で決まる）に影響しない not_applicable に
 *     倒すことで、bot の出し忘れだけで PR を倒さないようにする。
 *   - 余剰: required にマッチしない余剰項目のうち、finding を 1 件も参照して
 *     いない純粋なノイズ項目だけを落とす。finding を参照している余剰項目は
 *     実シグナルの可能性があるため残し、validator にそのまま判断させる
 *     （フォーマット補正であってレビュー品質の緩和ではないため）。
 */
function reconcileChecklistCount(review, requiredChecklistNames) {
  if (!Array.isArray(review.checklist)) return;
  const requiredSet = new Set(requiredChecklistNames);

  // 余剰ノイズ項目を落とす（finding を参照しないもののみ）
  review.checklist = review.checklist.filter((item) => {
    if (!isPlainObject(item) || typeof item.name !== 'string') return true;
    if (requiredSet.has(item.name)) return true;
    const refsFinding = Array.isArray(item.finding_ids) && item.finding_ids.length > 0;
    // required 外かつ finding 参照なし = 純粋ノイズ → 落とす
    return refsFinding;
  });

  // 不足項目を補完する
  const presentNames = new Set(
    review.checklist
      .filter((item) => isPlainObject(item) && typeof item.name === 'string')
      .map((item) => item.name),
  );
  requiredChecklistNames.forEach((name) => {
    if (!presentNames.has(name)) {
      review.checklist.push({
        name,
        status: 'not_applicable',
        note: 'reviewer 出力に欠落していたため自動補完（対象外として扱う）。',
        finding_ids: [],
      });
    }
  });
}

/**
 * checklist[].status と finding_ids / 参照先 finding の整合を機械補正する。
 *
 * reviewer がしばしば status と finding_ids を取り違える（ok なのに finding_ids
 * を入れる / finding なのに status=ok のまま等）。status は finding_ids の中身
 * から機械的に一意に導出できるため、status 側を書き換えて整合させる。
 * finding 側の中身（severity / blocking / skipped）は触らない。
 *
 *   - finding_ids が空 → status は ok（既に not_applicable ならそのまま尊重）
 *   - finding_ids が未スキップ finding を含む → status=finding
 *   - finding_ids が全て skipped=true の finding → status=skipped
 *
 * 参照先 finding が見つからない id は判断材料にしないが、id が存在する以上
 * 「finding 参照あり」とみなして status=finding に倒す（後続 validator が
 * 未解決参照として報告する）。
 */
function reconcileChecklistStatuses(review) {
  if (!Array.isArray(review.checklist)) return;
  const findingsById = new Map();
  if (Array.isArray(review.findings)) {
    review.findings.forEach((finding) => {
      if (isPlainObject(finding) && typeof finding.id === 'string') {
        findingsById.set(finding.id, finding);
      }
    });
  }

  review.checklist.forEach((item) => {
    if (!isPlainObject(item)) return;
    if (!Array.isArray(item.finding_ids)) return;
    if (!['ok', 'finding', 'skipped', 'not_applicable'].includes(item.status)) return;

    const ids = item.finding_ids.filter((id) => typeof id === 'string');
    if (ids.length === 0) {
      // finding 参照なし。status が finding / skipped（要参照）なら ok へ。
      // not_applicable は reviewer の明示的判断として尊重する。
      if (item.status === 'finding' || item.status === 'skipped') {
        item.status = 'ok';
      }
      return;
    }

    // finding 参照あり。参照先の skipped 状態で finding / skipped を決める。
    const linked = ids.map((id) => findingsById.get(id)).filter((f) => isPlainObject(f));
    const hasUnskipped = linked.some((f) => f.skipped !== true);
    const allSkipped = linked.length > 0 && linked.every((f) => f.skipped === true);
    if (allSkipped && !hasUnskipped) {
      item.status = 'skipped';
    } else {
      // 未スキップ finding を含む / 参照先不明の id を含む → finding に倒す
      item.status = 'finding';
    }
  });
}

function validateReviewJson(review) {
  const errors = [];
  const requiredChecklistNames = loadRequiredChecklistNames();
  // 形式的な逸脱を吸収してから validate する。idempotent。
  normalizeReviewJson(review, requiredChecklistNames);
  if (!assertObject(review, '$', errors)) {
    return errors;
  }
  assertAllowedKeys(
    review,
    ['schema_version', 'reviewed_head_sha', 'verdict', 'summary', 'checklist', 'findings'],
    '$',
    errors,
  );

  if (review.schema_version !== 1) {
    errors.push('$.schema_version は number 1 である必要があります。');
  }
  assertEnum(review.verdict, ['approved', 'changes_requested'], '$.verdict', errors);
  assertString(review.summary, '$.summary', errors, { maxLength: 500 });
  if (assertString(review.reviewed_head_sha, '$.reviewed_head_sha', errors, { maxLength: 64 })) {
    const expectedHeadSha = process.env.PR_HEAD_SHA;
    if (expectedHeadSha && review.reviewed_head_sha !== expectedHeadSha) {
      errors.push(
        `$.reviewed_head_sha は PR_HEAD_SHA と一致する必要があります (expected=${expectedHeadSha}, actual=${review.reviewed_head_sha})。`,
      );
    }
  }

  if (!Array.isArray(review.checklist)) {
    errors.push('$.checklist は array である必要があります。');
  }
  if (!Array.isArray(review.findings)) {
    errors.push('$.findings は array である必要があります。');
  }

  const findingIds = new Set();
  if (Array.isArray(review.findings)) {
    review.findings.forEach((finding, index) => {
      const base = `$.findings[${index}]`;
      if (!assertObject(finding, base, errors)) {
        return;
      }
      assertAllowedKeys(
        finding,
        [
          'id',
          'severity',
          'blocking',
          'skipped',
          'skip_reason',
          'title',
          'root_cause',
          'evidence',
          'required_fix',
          'checked_scope',
          'confidence',
          'false_positive_risk',
        ],
        base,
        errors,
      );

      if (assertFindingId(finding.id, `${base}.id`, errors)) {
        if (findingIds.has(finding.id)) {
          errors.push(`${base}.id "${finding.id}" が重複しています。`);
        }
        findingIds.add(finding.id);
      }
      assertEnum(finding.severity, ['critical', 'major', 'minor'], `${base}.severity`, errors);
      if (typeof finding.blocking !== 'boolean') {
        errors.push(`${base}.blocking は boolean である必要があります。`);
      }
      if (typeof finding.skipped !== 'boolean') {
        errors.push(`${base}.skipped は boolean である必要があります。`);
      }
      if (finding.skipped === true) {
        if (finding.severity !== 'major') {
          errors.push(`${base}.skipped は major finding の場合のみ true にできます。`);
        }
        if (finding.blocking !== false) {
          errors.push(`${base}.blocking は skipped=true の場合 false にしてください。`);
        }
        assertString(finding.skip_reason, `${base}.skip_reason`, errors, { maxLength: 1000 });
      } else if (finding.skip_reason !== undefined) {
        errors.push(`${base}.skip_reason は skipped=true の場合のみ指定できます。`);
      }
      if (finding.skipped !== true && (finding.severity === 'critical' || finding.severity === 'major') && finding.blocking !== true) {
        errors.push(`${base}.blocking は未スキップの critical / major の場合 true にしてください。`);
      }
      if (finding.severity === 'minor' && finding.blocking !== false) {
        errors.push(`${base}.blocking は minor の場合 false にしてください。`);
      }
      assertString(finding.title, `${base}.title`, errors, { maxLength: 140 });
      assertString(finding.root_cause, `${base}.root_cause`, errors, { maxLength: 1000 });
      assertString(finding.required_fix, `${base}.required_fix`, errors, { maxLength: 1000 });
      assertEnum(finding.confidence, ['high', 'medium', 'low'], `${base}.confidence`, errors);
      assertEnum(
        finding.false_positive_risk,
        ['high', 'medium', 'low'],
        `${base}.false_positive_risk`,
        errors,
      );
      assertStringArray(finding.checked_scope, `${base}.checked_scope`, errors, { nonEmpty: true });

      if (!Array.isArray(finding.evidence) || finding.evidence.length === 0) {
        errors.push(`${base}.evidence は 1 件以上の array である必要があります。`);
      } else {
        finding.evidence.forEach((evidence, evidenceIndex) => {
          const evidenceBase = `${base}.evidence[${evidenceIndex}]`;
          if (!assertObject(evidence, evidenceBase, errors)) {
            return;
          }
          assertAllowedKeys(evidence, ['path', 'line', 'end_line', 'reason'], evidenceBase, errors);
          assertSafeEvidencePath(evidence.path, `${evidenceBase}.path`, errors);
          if (evidence.line !== undefined && (!Number.isInteger(evidence.line) || evidence.line < 1)) {
            errors.push(`${evidenceBase}.line は 1 以上の integer である必要があります。`);
          }
          if (
            evidence.end_line !== undefined &&
            (!Number.isInteger(evidence.end_line) ||
              evidence.end_line < 1 ||
              (Number.isInteger(evidence.line) && evidence.end_line < evidence.line))
          ) {
            errors.push(`${evidenceBase}.end_line は line 以上の integer である必要があります。`);
          }
          assertString(evidence.reason, `${evidenceBase}.reason`, errors, { maxLength: 1000 });
        });
      }
    });
  }

  if (Array.isArray(review.checklist)) {
    const findingChecklistReferences = new Map();
    // 件数は exact match を要件にする。reviewer の prompt 側で
    // 「追加 checklist item を作らない、追加観点は note に併記する」と
    // 明示しているため、validator もそれに合わせて superset を許容しない。
    // (旧版で一時的に緩めたが、prompt との契約不整合を招くため復元。
    // 追加項目が混入したら F-JSON-CONTRACT として明示的に reject する。)
    if (review.checklist.length !== requiredChecklistNames.length) {
      errors.push(
        `$.checklist は ${requiredChecklistNames.length} 件である必要があります (actual=${review.checklist.length})。追加観点は新 checklist item でなく既存項目の note に併記してください。`,
      );
    }
    const checklistNames = new Set();
    review.checklist.forEach((item, index) => {
      const base = `$.checklist[${index}]`;
      if (!assertObject(item, base, errors)) {
        return;
      }
      assertAllowedKeys(item, ['name', 'status', 'note', 'finding_ids'], base, errors);
      if (assertString(item.name, `${base}.name`, errors, { maxLength: 120 })) {
        if (checklistNames.has(item.name)) {
          errors.push(`${base}.name "${item.name}" が重複しています。`);
        }
        checklistNames.add(item.name);
      }
      assertEnum(item.status, ['ok', 'finding', 'skipped', 'not_applicable'], `${base}.status`, errors);
      assertString(item.note, `${base}.note`, errors, { maxLength: 500 });
      const itemFindingIds = [];
      if (!Array.isArray(item.finding_ids)) {
        errors.push(`${base}.finding_ids は array である必要があります。`);
      } else {
        item.finding_ids.forEach((id, idIndex) => {
          if (assertFindingId(id, `${base}.finding_ids[${idIndex}]`, errors)) {
            if (!findingIds.has(id)) {
              errors.push(`${base}.finding_ids[${idIndex}] "${id}" は findings に存在しません。`);
            } else {
              const references = findingChecklistReferences.get(id) || [];
              references.push({ status: item.status, path: base });
              findingChecklistReferences.set(id, references);
            }
          }
          itemFindingIds.push(id);
        });
      }
      if (item.status === 'finding' && itemFindingIds.length === 0) {
        errors.push(`${base}.status が finding の場合 finding_ids が必要です。`);
      }
      if (item.status === 'skipped' && itemFindingIds.length === 0) {
        errors.push(`${base}.status が skipped の場合 finding_ids が必要です。`);
      }
      if ((item.status === 'ok' || item.status === 'not_applicable') && itemFindingIds.length > 0) {
        errors.push(`${base}.status が ok / not_applicable の場合 finding_ids は空にしてください。`);
      }
      if (item.status === 'skipped' && Array.isArray(review.findings)) {
        itemFindingIds.forEach((id) => {
          const linkedFinding = review.findings.find((finding) => finding && finding.id === id);
          if (linkedFinding && linkedFinding.skipped !== true) {
            errors.push(`${base}.finding_ids の "${id}" は skipped=true の finding を参照してください。`);
          }
        });
      }
      if (item.status === 'finding' && Array.isArray(review.findings)) {
        const hasUnskippedFinding = itemFindingIds.some((id) => {
          const linkedFinding = review.findings.find((finding) => finding && finding.id === id);
          return linkedFinding && linkedFinding.skipped !== true;
        });
        if (itemFindingIds.length > 0 && !hasUnskippedFinding) {
          errors.push(`${base}.status が finding の場合、未スキップの finding を 1 件以上参照してください。`);
        }
      }
    });
    requiredChecklistNames.forEach((name) => {
      if (!checklistNames.has(name)) {
        errors.push(`$.checklist に必須項目 "${name}" がありません。`);
      }
    });
    if (Array.isArray(review.findings)) {
      review.findings.forEach((finding, index) => {
        if (!finding || typeof finding.id !== 'string') {
          return;
        }
        const base = `$.findings[${index}]`;
        const references = findingChecklistReferences.get(finding.id) || [];
        if (references.length === 0) {
          errors.push(`${base}.id "${finding.id}" は checklist の finding_ids から参照されている必要があります。`);
          return;
        }
        const expectedStatus = finding.skipped === true ? 'skipped' : 'finding';
        const hasExpectedStatus = references.some((reference) => reference.status === expectedStatus);
        if (!hasExpectedStatus) {
          const actualStatuses = references.map((reference) => `${reference.path}.status=${reference.status}`).join(', ');
          errors.push(
            `${base}.id "${finding.id}" は checklist の status=${expectedStatus} の項目から参照されている必要があります (actual: ${actualStatuses})。`,
          );
        }
      });
    }
  }

  if (Array.isArray(review.findings)) {
    const blockingCount = review.findings.filter((finding) => finding && finding.blocking === true).length;
    if (review.verdict === 'approved' && blockingCount > 0) {
      errors.push('$.verdict が approved の場合 blocking finding は 0 件である必要があります。');
    }
    if (review.verdict === 'changes_requested' && blockingCount === 0) {
      errors.push('$.verdict が changes_requested の場合 blocking finding が 1 件以上必要です。');
    }
  }

  return errors;
}

function validateOrThrow(review) {
  const errors = validateReviewJson(review);
  if (errors.length > 0) {
    fail(`review JSON schema validation failed:\n- ${errors.join('\n- ')}`);
  }
}

function renderMarkdown(review) {
  validateOrThrow(review);

  const marker = process.env.CODEX_REVIEW_COMMENT_MARKER || '<!-- codex-reviewer-bot:v1 -->';
  const headSha = review.reviewed_head_sha;
  const runUrl = process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY && process.env.GITHUB_RUN_ID
    ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
    : '';
  const findings = [...review.findings].sort((a, b) => {
    const severityDiff = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
    return severityDiff !== 0 ? severityDiff : a.id.localeCompare(b.id);
  });
  const blockingCount = findings.filter((finding) => finding.blocking).length;
  const skippedCount = findings.filter((finding) => finding.skipped).length;
  const verdictLabel = review.verdict === 'approved' ? '✅ Approved' : '❌ Changes Requested';

  const lines = [];
  lines.push(marker);
  lines.push('');
  lines.push('### 変更の概要');
  lines.push(sanitizeMarkdownText(review.summary));
  lines.push('');
  lines.push('### レビュー結果');
  lines.push(`- 判定: ${verdictLabel}`);
  lines.push(`- 対象 SHA: \`${headSha}\``);
  const skippedSuffix = skippedCount > 0 ? `, skipped: ${skippedCount} 件` : '';
  lines.push(`- 指摘件数: ${findings.length} 件（blocking: ${blockingCount} 件${skippedSuffix}）`);
  if (runUrl) {
    lines.push(`- Actions run: ${runUrl}`);
  }
  lines.push('');
  lines.push('### チェックリスト適用サマリー');
  lines.push('| チェック項目 | 判定 | 根拠 |');
  lines.push('|---|---|---|');
  review.checklist.forEach((item) => {
    const findingSuffix = Array.isArray(item.finding_ids) && item.finding_ids.length > 0
      ? ` (${item.finding_ids.map((id) => `\`${id}\``).join(', ')})`
      : '';
    lines.push(
      `| ${escapeTable(item.name)} | ${CHECKLIST_LABEL[item.status]}${findingSuffix} | ${escapeTable(item.note)} |`,
    );
  });
  lines.push('');
  lines.push('### 指摘事項');

  if (findings.length === 0) {
    lines.push('指摘事項なし。');
  } else {
    findings.forEach((finding) => {
      const severityLabel = finding.skipped
        ? `${SEVERITY_LABEL[finding.severity]}（スキップ済）`
        : SEVERITY_LABEL[finding.severity];
      lines.push('');
      // finding.title は見出しの一部になるので、改行と Markdown 構造を全て無害化。
      lines.push(`#### ${finding.id} ${severityLabel} ${sanitizeMarkdownHeading(finding.title)}`);
      lines.push('');
      lines.push('**根本原因**');
      lines.push(sanitizeMarkdownText(finding.root_cause));
      lines.push('');
      lines.push('**根拠**');
      finding.evidence.forEach((evidence) => {
        lines.push(`- ${formatEvidenceLocation(evidence)}  ${sanitizeMarkdownText(evidence.reason)}`);
      });
      lines.push('');
      lines.push('**必要な修正**');
      lines.push(sanitizeMarkdownText(finding.required_fix));
      if (finding.skipped) {
        lines.push('');
        lines.push('**スキップ理由**');
        lines.push(sanitizeMarkdownText(finding.skip_reason));
      }
      lines.push('');
      lines.push('**確認範囲**');
      finding.checked_scope.forEach((scope) => {
        lines.push(`- ${sanitizeMarkdownText(scope)}`);
      });
      lines.push('');
      lines.push(`**信頼度**: ${finding.confidence}`);
      if (finding.false_positive_risk) {
        lines.push(`**False positive リスク**: ${finding.false_positive_risk}`);
      }
    });
  }

  lines.push('');
  return `${lines.join('\n')}\n`;
}

function escapeTable(value) {
  // 表セル内も reviewer 出力 (item.name / item.note 等) を含むため、
  // 一般 sanitize を通してから `|` と改行を表表現にエスケープする。
  return sanitizeMarkdownText(value).replace(/\|/g, '\\|').replace(/\n/g, '<br>');
}

function sanitizeMarkdownHeading(value) {
  // 見出し中に改行を入れさせない (Markdown 構造の崩れ防止)。
  return sanitizeMarkdownText(value).replace(/\s+/g, ' ').trim();
}

function sanitizeMarkdownText(value) {
  // reviewer の JSON 出力由来の文字列を GitHub コメント本文に埋め込む際の
  // 一般サニタイザ。AI 出力で以下を偽装される事故を防ぐ:
  //   - `<!-- VERDICT:APPROVED -->` 等の HTML comment による verdict 偽装
  //   - ``` で codex-reviewer-bot:v1 marker の中断 / code block 注入
  //   - 行頭 `#` ``###`` 等で見出しを偽装し、PR コメント構造を破壊
  //   - 行頭 `> * + - 1.` 等で blockquote / list を注入
  return String(value)
    .trim()
    .replace(/<!--/g, '&lt;!--')
    .replace(/-->/g, '--&gt;')
    .replace(/```/g, '\\`\\`\\`')
    .replace(/^\s{0,3}(#{1,6})\s/gm, '\\$1 ')
    .replace(/^\s{0,3}([>*+-])\s/gm, '\\$1 ')
    .replace(/^\s{0,3}(\d+[.)])\s/gm, '\\$1 ');
}

function formatEvidenceLocation(evidence) {
  const path = String(evidence.path);
  if (Number.isInteger(evidence.line) && Number.isInteger(evidence.end_line) && evidence.end_line !== evidence.line) {
    return `\`${path}:${evidence.line}-${evidence.end_line}\``;
  }
  if (Number.isInteger(evidence.line)) {
    return `\`${path}:${evidence.line}\``;
  }
  return `\`${path}\``;
}

function main() {
  const [, , command, filePath] = process.argv;
  if (!command || !filePath || !['validate', 'render', 'verdict'].includes(command)) {
    usage();
    process.exit(2);
  }

  try {
    const review = readReviewJson(filePath);
    if (command === 'validate') {
      validateOrThrow(review);
      console.error('review JSON schema validation passed.');
    } else if (command === 'render') {
      process.stdout.write(renderMarkdown(review));
    } else if (command === 'verdict') {
      validateOrThrow(review);
      process.stdout.write(`${review.verdict}\n`);
    }
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}

main();
