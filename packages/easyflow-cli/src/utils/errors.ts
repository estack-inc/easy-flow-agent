export class EasyflowError extends Error {
  constructor(
    message: string,
    public readonly cause?: string,
    public readonly hint?: string,
  ) {
    super(message);
    this.name = "EasyflowError";
  }
}

export function handleError(error: unknown): never {
  if (error instanceof EasyflowError) {
    console.error(`Error: ${error.message}`);
    if (error.cause) {
      console.error(`\n  原因: ${error.cause}`);
    }
    if (error.hint) {
      console.error(`  対処: ${error.hint}`);
    }
    console.error();
    process.exit(1);
  }

  if (error instanceof Error) {
    console.error(`Error: ${error.message}`);
    process.exit(1);
  }

  console.error(`Error: ${String(error)}`);
  process.exit(1);
}
