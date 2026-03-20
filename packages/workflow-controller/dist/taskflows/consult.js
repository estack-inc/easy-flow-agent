const consultFlow = {
  flowId: "taskflow_consult",
  trigger: "\u{1F4AC}",
  description: "\u76F8\u8AC7\u30FB\u8CEA\u554F\u3092\u53D7\u3051\u3066\u691C\u8A0E\u30FB\u56DE\u7B54\u3002\u30BF\u30B9\u30AF\u306B\u767A\u5C55\u3059\u308B\u5834\u5408\u306F taskflow_task \u3092\u8D77\u52D5\u3002",
  label: "\u{1F4AC} \u76F8\u8AC7\u30FB\u8CEA\u554F\u30D5\u30ED\u30FC",
  steps: [
    {
      id: "issue_register",
      label: "Issue \u767B\u9332\uFF08\u30E9\u30D9\u30EB: consultation\uFF09"
    },
    {
      id: "analysis",
      label: "\u691C\u8A0E\u30FB\u8907\u6570\u6848\u63D0\u793A\uFF08\u63A8\u5968\u5EA6\u2605\u4ED8\u304D\uFF09",
      conditions: [
        { label: "\u30BF\u30B9\u30AF\u306B\u767A\u5C55\u3059\u308B", nextStepId: "task_spawn" },
        { label: "\u56DE\u7B54\u3067\u5B8C\u7D50\u3059\u308B", nextStepId: "complete" }
      ]
    },
    {
      id: "task_spawn",
      label: "\u{1F4CB} \u30BF\u30B9\u30AF\u4F9D\u983C\u30D5\u30ED\u30FC\u3092\u65B0\u898F\u8D77\u52D5",
      nextStepId: "task_spawn"
    },
    {
      id: "complete",
      label: "\u56DE\u7B54\u5B8C\u4E86\u30FBIssue \u30AF\u30ED\u30FC\u30BA",
      nextStepId: "complete"
    }
  ]
};
export {
  consultFlow
};
