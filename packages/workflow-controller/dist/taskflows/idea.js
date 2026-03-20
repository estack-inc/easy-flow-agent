const ideaFlow = {
  flowId: "taskflow_idea",
  trigger: "\u{1F4A1}",
  description: "\u30A2\u30A4\u30C7\u30A2\u30FB\u63D0\u6848\u3092\u8A55\u4FA1\u3057\u3066\u5B9F\u884C\u53EF\u5426\u3092\u5224\u65AD\u3002\u5B9F\u884C\u3059\u308B\u5834\u5408\u306F taskflow_task \u3092\u8D77\u52D5\u3002",
  label: "\u{1F4A1} \u30A2\u30A4\u30C7\u30A2\u30FB\u63D0\u6848\u30D5\u30ED\u30FC",
  steps: [
    {
      id: "issue_register",
      label: "Issue \u767B\u9332\uFF08\u30E9\u30D9\u30EB: idea\uFF09"
    },
    {
      id: "evaluation",
      label: "\u8A55\u4FA1\uFF08\u30E1\u30EA\u30C3\u30C8\u30FB\u30C7\u30E1\u30EA\u30C3\u30C8\u30FB\u5B9F\u73FE\u96E3\u5EA6\u30FB\u63A8\u5968\u5EA6\u2605\u3092\u63D0\u793A\uFF09",
      conditions: [
        { label: "\u5B9F\u884C\u3059\u308B", nextStepId: "task_spawn" },
        { label: "\u5374\u4E0B", nextStepId: "close_rejected" },
        { label: "\u518D\u691C\u8A0E", nextStepId: "evaluation" }
      ]
    },
    {
      id: "task_spawn",
      label: "\u{1F4CB} \u30BF\u30B9\u30AF\u4F9D\u983C\u30D5\u30ED\u30FC\u3092\u65B0\u898F\u8D77\u52D5",
      nextStepId: "task_spawn"
    },
    {
      id: "close_rejected",
      label: "\u5374\u4E0B\u7406\u7531\u3092\u8A18\u8F09 \u2192 Issue \u30AF\u30ED\u30FC\u30BA",
      nextStepId: "close_rejected"
    }
  ]
};
export {
  ideaFlow
};
