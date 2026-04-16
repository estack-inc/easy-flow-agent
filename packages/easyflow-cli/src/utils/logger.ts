export class Logger {
  constructor(private options: { verbose: boolean; noColor: boolean }) {}

  info(message: string): void {
    console.log(this.format(message));
  }

  debug(message: string): void {
    if (this.options.verbose) {
      console.log(this.format(`[debug] ${message}`));
    }
  }

  warn(message: string): void {
    console.warn(this.format(`Warning: ${message}`));
  }

  error(message: string): void {
    console.error(this.format(`Error: ${message}`));
  }

  private format(message: string): string {
    if (this.options.noColor) {
      return message;
    }
    return message;
  }
}
