const taskFlow = {
  flowId: "taskflow_task",
  trigger: "\u{1F4CB}",
  description: "\u8981\u4EF6\u6DF1\u6398\u308A \u2192 \u8A2D\u8A08 \u2192 \u30BF\u30B9\u30AF\u5206\u5272 \u2192 \u5B9F\u884C \u2192 \u30EC\u30D3\u30E5\u30FC \u2192 \u691C\u53CE\u306E\u6A19\u6E96\u30D5\u30ED\u30FC",
  label: "\u{1F4CB} \u30BF\u30B9\u30AF\u4F9D\u983C\u30D5\u30ED\u30FC",
  steps: [
    {
      id: "requirements",
      label: "\u8981\u4EF6\u6DF1\u6398\u308A\uFF08\u76EE\u7684\u30FB\u7BC4\u56F2\u30FB\u5B8C\u4E86\u6761\u4EF6\u306E\u660E\u78BA\u5316\uFF09",
      conditions: [
        { label: "validator:PASS \u2192 \u3088\u308A\u3061\u304B\u3055\u3093OK", nextStepId: "issue_register" },
        { label: "validator:NG \u2192 \u518D\u6DF1\u6398\u308A", nextStepId: "requirements" }
      ]
    },
    {
      id: "issue_register",
      label: "GitHub Issue \u767B\u9332\uFF08\u8981\u4EF6\u30FB\u5B8C\u4E86\u6761\u4EF6\u3092\u8A18\u8F09\uFF09",
      conditions: [
        { label: "\u8A2D\u8A08\u30FB\u8ABF\u67FB\u304C\u5FC5\u8981", nextStepId: "design" },
        { label: "\u8A2D\u8A08\u4E0D\u8981\u30FB\u5373\u5206\u5272", nextStepId: "task_split" }
      ]
    },
    {
      id: "design",
      label: "\u8A2D\u8A08\u30FB\u8ABF\u67FB\uFF08\u65B9\u91DD\u30FB\u69CB\u6210\u30FB\u9078\u629E\u80A2\u3092 Issue \u306B\u8A18\u8F09\uFF09",
      conditions: [
        { label: "validator:PASS \u2192 \u3088\u308A\u3061\u304B\u3055\u3093OK", nextStepId: "task_split" },
        { label: "validator:NG \u2192 \u518D\u8A2D\u8A08", nextStepId: "design" }
      ]
    },
    {
      id: "task_split",
      label: "\u30BF\u30B9\u30AF\u5206\u5272\u30FB\u6307\u793A\u66F8\u4F5C\u6210\uFF08\u30A2\u30C8\u30DF\u30C3\u30AF\u57FA\u6E96\u3067\u5206\u5272\uFF09",
      conditions: [
        { label: "validator:PASS \u2192 \u3088\u308A\u3061\u304B\u3055\u3093\u5B9F\u884C", nextStepId: "execution" },
        { label: "validator:NG \u2192 \u518D\u5206\u5272", nextStepId: "task_split" },
        { label: "\u5B9F\u884C\u4E0D\u8981\u30FB\u5B8C\u4E86", nextStepId: "acceptance" }
      ]
    },
    {
      id: "execution",
      label: "\u3088\u308A\u3061\u304B\u3055\u3093\u304C\u6307\u793A\u66F8\u306B\u57FA\u3065\u3044\u3066\u5B9F\u884C"
    },
    {
      id: "review",
      label: "output-reviewer \u304C\u6210\u679C\u7269\u30EC\u30D3\u30E5\u30FC\uFF08\u8981\u4EF6\u30FB\u8A2D\u8A08\u3068\u306E\u6574\u5408\u30C1\u30A7\u30C3\u30AF\uFF09",
      conditions: [
        { label: "reviewer:PASS", nextStepId: "acceptance" },
        { label: "reviewer:NG", nextStepId: "execution" }
      ]
    },
    {
      id: "acceptance",
      label: "\u691C\u53CE\u30FB\u5B8C\u4E86\uFF08\u3088\u308A\u3061\u304B\u3055\u3093\u304C\u6700\u7D42\u78BA\u8A8D \u2192 Issue \u30AF\u30ED\u30FC\u30BA\uFF09"
    }
  ]
};
export {
  taskFlow
};
