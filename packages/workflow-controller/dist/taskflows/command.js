const commandFlow = {
  flowId: "taskflow_command",
  trigger: "\u{1F4E2}",
  description: "\u6700\u512A\u5148\u30FB\u5373\u5B9F\u884C\u3002\u30D0\u30EA\u30C7\u30FC\u30B7\u30E7\u30F3\u306F task_split \u306E\u307F\u3002",
  label: "\u{1F4E2} \u6307\u793A\u30FB\u547D\u4EE4\u30D5\u30ED\u30FC",
  steps: [
    {
      id: "issue_register",
      label: "Issue \u767B\u9332\uFF08\u512A\u5148\u5EA6\u30FB\u671F\u9650\u3092\u8A18\u8F09\uFF09"
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
      label: "\u5B8C\u4E86\u5831\u544A\uFF08Issue \u30AF\u30ED\u30FC\u30BA\uFF09"
    }
  ]
};
export {
  commandFlow
};
