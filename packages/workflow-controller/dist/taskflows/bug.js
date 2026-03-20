const bugFlow = {
  flowId: "taskflow_bug",
  trigger: "\u{1F41B}",
  description: "\u30D0\u30B0\u30FB\u696D\u52D9\u4E0A\u306E\u554F\u984C\u30FB\u969C\u5BB3\u30FB\u30AF\u30EC\u30FC\u30E0\u306B\u5BFE\u5FDC\u3059\u308B\u6C4E\u7528\u30D5\u30ED\u30FC\u3002",
  label: "\u{1F41B} \u30D0\u30B0\u30FB\u554F\u984C\u5831\u544A\u30D5\u30ED\u30FC",
  steps: [
    {
      id: "issue_register",
      label: "Issue \u767B\u9332 + \u554F\u984C\u30EC\u30DD\u30FC\u30C8\u4F5C\u6210\uFF08\u30C6\u30F3\u30D7\u30EC\u30FC\u30C8\u4F7F\u7528\uFF09"
    },
    {
      id: "investigate",
      label: "\u539F\u56E0\u8ABF\u67FB\u30FB\u5206\u6790\uFF08\u5206\u6790\u30C6\u30F3\u30D7\u30EC\u30FC\u30C8\u306B\u6CBF\u3063\u3066\u8A18\u9332\uFF09"
    },
    {
      id: "triage",
      label: "\u30C8\u30EA\u30A2\u30FC\u30B8\uFF08\u5F71\u97FF\u7BC4\u56F2\u30FB\u5BFE\u5FDC\u6848\u3092\u3088\u308A\u3061\u304B\u3055\u3093\u306B\u63D0\u793A\uFF09",
      conditions: [
        { label: "\u5BFE\u5FDC\u3059\u308B", nextStepId: "task_split" },
        { label: "\u5BFE\u5FDC\u3057\u306A\u3044", nextStepId: "close_no_fix" },
        { label: "\u518D\u8ABF\u67FB", nextStepId: "investigate" }
      ]
    },
    {
      id: "task_split",
      label: "\u6307\u793A\u66F8\u4F5C\u6210\uFF08\u30A2\u30C8\u30DF\u30C3\u30AF\u57FA\u6E96 / task-validator \u30C1\u30A7\u30C3\u30AF\uFF09",
      conditions: [
        { label: "validator:PASS", nextStepId: "execution" },
        { label: "validator:NG", nextStepId: "task_split" }
      ]
    },
    {
      id: "execution",
      label: "\u3088\u308A\u3061\u304B\u3055\u3093\u304C\u5B9F\u884C"
    },
    {
      id: "review",
      label: "output-reviewer \u304C\u6210\u679C\u7269\u30EC\u30D3\u30E5\u30FC",
      conditions: [
        { label: "reviewer:PASS", nextStepId: "complete" },
        { label: "reviewer:NG", nextStepId: "execution" }
      ]
    },
    {
      id: "complete",
      label: "\u4FEE\u6B63\u5B8C\u4E86\u30FBIssue \u30AF\u30ED\u30FC\u30BA",
      nextStepId: "complete"
    },
    {
      id: "close_no_fix",
      label: "\u5BFE\u5FDC\u4E0D\u8981\u306E\u7406\u7531\u3092\u8A18\u8F09 \u2192 Issue \u30AF\u30ED\u30FC\u30BA",
      nextStepId: "close_no_fix"
    }
  ]
};
export {
  bugFlow
};
