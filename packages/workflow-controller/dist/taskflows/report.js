const reportFlow = {
  flowId: "taskflow_report",
  trigger: "\u{1F4CA}",
  description: "\u72B6\u6CC1\u78BA\u8A8D\u30FB\u5831\u544A\u4F9D\u983C\u3078\u306E\u5FDC\u7B54\u3002\u8ABF\u67FB\u30FB\u56DE\u7B54\u3057\u3066\u5B8C\u4E86\u3002",
  label: "\u{1F4CA} \u5831\u544A\u30FB\u78BA\u8A8D\u30D5\u30ED\u30FC",
  steps: [
    {
      id: "issue_register",
      label: "Issue \u767B\u9332\uFF08\u30E9\u30D9\u30EB: report\uFF09"
    },
    {
      id: "respond",
      label: "\u78BA\u8A8D\u30FB\u8ABF\u67FB\u30FB\u56DE\u7B54\uFF08Issue + Slack DM \u306B\u8A18\u8F09\uFF09"
    },
    {
      id: "complete",
      label: "\u3088\u308A\u3061\u304B\u3055\u3093\u78BA\u8A8D \u2192 Issue \u30AF\u30ED\u30FC\u30BA"
    }
  ]
};
export {
  reportFlow
};
