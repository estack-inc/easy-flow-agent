function createNoopDelegate() {
  return {
    info: {
      id: "noop",
      name: "No-op Delegate",
      version: "0.0.0"
    },
    async ingest() {
      return { ingested: false };
    },
    async assemble(params) {
      return { messages: params.messages, estimatedTokens: 0 };
    },
    async compact() {
      return { ok: true, compacted: false, reason: "noop delegate" };
    }
  };
}
export {
  createNoopDelegate
};
