#!/usr/bin/env python3
"""
AI レビュー（codex-review / claude-review）の実行記録を JSONL に残し、
月次で集計するための CLI ツール。

サブコマンド:
  record-from-env   GitHub Actions の env / artifact を入力に 1 行分の JSON を
                    stdout に出力する。step summary 用 markdown も生成する。
                    実 jsonl への append は行わない（CI write 権限の都合で
                    別 job/cron に分離する）。
  append            stdin で受けた JSONL を knowledge/meta/ai-review-costs.jsonl
                    に追記する。aggregator workflow から呼ぶ想定。
  summarize         knowledge/meta/ai-review-costs.jsonl を読み、
                    指定された月（または全期間）の集計 markdown を出力する。

設計方針:
  - 1 行 1 record の JSONL。schema_version を必ず含めて将来拡張可能にする。
  - 課金額の正確な値は webhook bridge が usage を返さない限り得られないので、
    proxy metric （差分行数、duration）を中心に記録する。後日 webhook が
    usage を返すように拡張されたら usage_input_tokens / usage_output_tokens を
    追加すればよい。
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
LEDGER = REPO_ROOT / "knowledge" / "meta" / "ai-review-costs.jsonl"

SCHEMA_VERSION = 1


def _now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _read_review_json(path: str | None) -> dict:
    if not path:
        return {}
    p = Path(path)
    if not p.exists():
        return {}
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except Exception:
        return {}


def _count_findings(review: dict) -> tuple[int, int]:
    findings = review.get("findings") or []
    total = len(findings)
    blocking = sum(1 for f in findings if f.get("blocking") is True)
    return total, blocking


def cmd_record_from_env(args: argparse.Namespace) -> int:
    """
    GitHub Actions 上で run。

    必須 env:
      GITHUB_REPOSITORY     例: central-holdings/umito-spec
      PR_NUMBER             PR 番号
      PR_HEAD_SHA           PR head SHA
      WORKFLOW_NAME         "codex-review" / "claude-review" 等

    任意 env:
      REVIEW_JSON_PATH      review 結果 JSON のパス（findings / verdict 取得用）
      DIFF_FILES_CHANGED    数値
      DIFF_ADDITIONS        数値
      DIFF_DELETIONS        数値
      DURATION_SECONDS      数値
      WEBHOOK_HTTP_STATUS   数値
      REVIEW_ITERATION      数値（再 review 何回目か）
      VERDICT_OVERRIDE      review JSON が無い場合の verdict
      NOTES                 自由テキスト

    出力:
      stdout に JSON 1 行
      GITHUB_STEP_SUMMARY が指定されていれば markdown を append
    """
    repo = os.environ.get("GITHUB_REPOSITORY", "")
    pr_number = os.environ.get("PR_NUMBER", "")
    head_sha = os.environ.get("PR_HEAD_SHA", "")
    workflow_name = os.environ.get("WORKFLOW_NAME", "unknown")

    review = _read_review_json(os.environ.get("REVIEW_JSON_PATH"))
    verdict = (
        review.get("verdict")
        or os.environ.get("VERDICT_OVERRIDE")
        or "unknown"
    )
    findings_count, findings_blocking_count = _count_findings(review)

    def _opt_int(name: str) -> int | None:
        v = os.environ.get(name)
        if v is None or v == "":
            return None
        try:
            return int(v)
        except ValueError:
            return None

    record = {
        "schema_version": SCHEMA_VERSION,
        "ts": _now_iso(),
        "workflow": workflow_name,
        "repo": repo,
        "pr_number": int(pr_number) if pr_number.isdigit() else None,
        "head_sha": head_sha or None,
        # 一意キー用。GitHub Actions が自動で渡す GITHUB_RUN_ID / RUN_ATTEMPT を
        # 保存して、後段の手動 aggregator で重複 append を排除できるようにする。
        "github_run_id": os.environ.get("GITHUB_RUN_ID") or None,
        "github_run_attempt": _opt_int("GITHUB_RUN_ATTEMPT"),
        "verdict": verdict,
        "findings_count": findings_count,
        "findings_blocking_count": findings_blocking_count,
        "diff_files_changed": _opt_int("DIFF_FILES_CHANGED"),
        "diff_additions": _opt_int("DIFF_ADDITIONS"),
        "diff_deletions": _opt_int("DIFF_DELETIONS"),
        "duration_seconds": _opt_int("DURATION_SECONDS"),
        "webhook_http_status": _opt_int("WEBHOOK_HTTP_STATUS"),
        "review_iteration": _opt_int("REVIEW_ITERATION"),
        # 将来 webhook bridge が usage を返すようになったらここに値を入れる
        "usage_input_tokens": None,
        "usage_output_tokens": None,
        "model": None,
        "cost_usd": None,
        "notes": os.environ.get("NOTES", ""),
    }

    print(json.dumps(record, ensure_ascii=False))

    summary = _render_step_summary(record)
    summary_path = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary_path:
        with open(summary_path, "a", encoding="utf-8") as f:
            f.write(summary)
            f.write("\n")
    return 0


def _render_step_summary(record: dict) -> str:
    def _fmt(v):
        return "—" if v is None else str(v)

    return "\n".join(
        [
            "## AI Review コスト記録",
            "",
            f"- workflow: `{record['workflow']}`",
            f"- PR: #{_fmt(record['pr_number'])} ({_fmt(record['head_sha'])[:8]})",
            f"- verdict: **{record['verdict']}**",
            f"- findings: {record['findings_count']} (blocking: {record['findings_blocking_count']})",
            f"- diff: files={_fmt(record['diff_files_changed'])} +{_fmt(record['diff_additions'])} -{_fmt(record['diff_deletions'])}",
            f"- duration: {_fmt(record['duration_seconds'])} s",
            f"- iteration: {_fmt(record['review_iteration'])}",
            "",
            "> 本記録は artifact / step summary に残ります。月次集計は",
            "> `python3 scripts/ai_review_cost.py summarize` で取得できます。",
        ]
    )


def _dedup_key(record: dict) -> tuple | None:
    """重複 append 検出用の一意キーを返す。
    workflow + repo + pr_number + head_sha + github_run_id + github_run_attempt
    のいずれかが欠けている場合は None を返し（重複検出の対象外として扱う）、
    そのまま append する。
    """
    keys = [
        record.get("workflow"),
        record.get("repo"),
        record.get("pr_number"),
        record.get("head_sha"),
        record.get("github_run_id"),
        record.get("github_run_attempt"),
    ]
    # github_run_attempt は v1 までの古い record で欠けることがあるので
    # None も許容する。それ以外が欠けている場合だけ dedup 不能とみなす。
    if any(k is None for k in keys[:-1]):
        return None
    return tuple(keys)


def _load_existing_keys() -> set[tuple]:
    """既存 ledger から重複検出用キー集合を読み出す。"""
    keys: set[tuple] = set()
    if not LEDGER.exists():
        return keys
    with LEDGER.open(encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                rec = json.loads(line)
            except json.JSONDecodeError:
                continue
            k = _dedup_key(rec)
            if k is not None:
                keys.add(k)
    return keys


def cmd_append(args: argparse.Namespace) -> int:
    """
    stdin から JSONL を受け取り、knowledge/meta/ai-review-costs.jsonl に追記する。
    aggregator workflow が複数 artifact をまとめて流し込む想定。

    重複制御:
      既存 ledger と入力の両方で、(workflow, repo, pr_number, head_sha,
      github_run_id, github_run_attempt) を一意キーとして重複を排除する。
      同じ workflow run が複数の artifact に入っていたり、同じ月次集計を
      2 回流し込んだ場合に summarize が水増しされる事故を防ぐ。
    """
    LEDGER.parent.mkdir(parents=True, exist_ok=True)
    existing_keys = _load_existing_keys()
    seen_in_this_batch: set[tuple] = set()
    lines = sys.stdin.read().splitlines()
    appended = 0
    skipped_dup = 0
    skipped_bad = 0
    with LEDGER.open("a", encoding="utf-8") as f:
        for line in lines:
            line = line.strip()
            if not line:
                continue
            try:
                rec = json.loads(line)
            except json.JSONDecodeError:
                print(f"skip non-JSON line: {line[:80]}", file=sys.stderr)
                skipped_bad += 1
                continue
            key = _dedup_key(rec)
            if key is not None:
                if key in existing_keys or key in seen_in_this_batch:
                    skipped_dup += 1
                    continue
                seen_in_this_batch.add(key)
            f.write(line + "\n")
            appended += 1
    try:
        ledger_disp = str(LEDGER.relative_to(REPO_ROOT))
    except ValueError:
        ledger_disp = str(LEDGER)
    print(
        f"appended {appended} record(s), skipped {skipped_dup} duplicate(s), "
        f"skipped {skipped_bad} malformed line(s); "
        f"file={ledger_disp}"
    )
    return 0


def cmd_summarize(args: argparse.Namespace) -> int:
    if not LEDGER.exists():
        print("(ledger is empty)")
        return 0
    records: list[dict] = []
    with LEDGER.open(encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                records.append(json.loads(line))
            except json.JSONDecodeError:
                continue

    month = args.month  # "YYYY-MM" or None
    if month:
        records = [r for r in records if (r.get("ts") or "").startswith(month)]

    if not records:
        print(f"(no records for month={month})" if month else "(no records)")
        return 0

    by_workflow: dict[str, dict] = {}
    for r in records:
        w = r.get("workflow", "unknown")
        bucket = by_workflow.setdefault(
            w,
            {
                "count": 0,
                "verdicts": {},
                "findings_total": 0,
                "findings_blocking_total": 0,
                "diff_additions": 0,
                "diff_deletions": 0,
                "duration_seconds": 0,
            },
        )
        bucket["count"] += 1
        v = r.get("verdict", "unknown")
        bucket["verdicts"][v] = bucket["verdicts"].get(v, 0) + 1
        bucket["findings_total"] += r.get("findings_count") or 0
        bucket["findings_blocking_total"] += r.get("findings_blocking_count") or 0
        bucket["diff_additions"] += r.get("diff_additions") or 0
        bucket["diff_deletions"] += r.get("diff_deletions") or 0
        bucket["duration_seconds"] += r.get("duration_seconds") or 0

    print(f"# AI Review 集計 ({month or 'all-time'})")
    print()
    print(f"対象 record 数: {len(records)}")
    print()
    for w, b in sorted(by_workflow.items()):
        print(f"## {w}")
        print()
        print(f"- 実行回数: {b['count']}")
        print(f"- verdict 内訳: {b['verdicts']}")
        print(f"- finding 累計: {b['findings_total']} (blocking: {b['findings_blocking_total']})")
        print(
            "- diff 累計: +{add} -{del_}".format(
                add=b["diff_additions"], del_=b["diff_deletions"]
            )
        )
        print(f"- duration 累計: {b['duration_seconds']} s")
        print()
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="cmd", required=True)

    sp_rec = sub.add_parser(
        "record-from-env",
        help="GH Actions 環境変数 + review JSON から JSONL 1 行を出力",
    )
    sp_rec.set_defaults(func=cmd_record_from_env)

    sp_app = sub.add_parser(
        "append",
        help="stdin で受けた JSONL を knowledge/meta/ai-review-costs.jsonl に追記",
    )
    sp_app.set_defaults(func=cmd_append)

    sp_sum = sub.add_parser(
        "summarize",
        help="集計を markdown で stdout に出力",
    )
    sp_sum.add_argument(
        "--month",
        help="YYYY-MM 形式。指定すると当該月のみ集計",
        default=None,
    )
    sp_sum.set_defaults(func=cmd_summarize)

    args = parser.parse_args()
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
