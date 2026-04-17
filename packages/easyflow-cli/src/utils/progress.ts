import type { Ora } from "ora";
import ora from "ora";

export class StepProgress {
  private spinner: Ora | null = null;
  private currentStep = 0;
  private startTime = 0;

  constructor(
    private totalSteps: number,
    private noColor = false,
  ) {}

  start(step: number, label: string): void {
    this.currentStep = step;
    this.startTime = Date.now();
    const prefix = this.formatPrefix(step);

    if (this.noColor) {
      console.log(`${prefix} ${label} ...`);
      return;
    }

    this.spinner = ora({
      text: `${prefix} ${label}`,
      prefixText: "",
    }).start();
  }

  succeed(detail?: string): void {
    const elapsed = ((Date.now() - this.startTime) / 1000).toFixed(1);
    const suffix = detail ? ` ${detail}` : "";

    if (this.noColor || !this.spinner) {
      const prefix = this.formatPrefix(this.currentStep);
      console.log(`${prefix} done (${elapsed}s)${suffix}`);
      return;
    }

    this.spinner.succeed(`${this.spinner.text} ... done (${elapsed}s)${suffix}`);
    this.spinner = null;
  }

  fail(error: string): void {
    if (this.noColor || !this.spinner) {
      const prefix = this.formatPrefix(this.currentStep);
      console.error(`${prefix} FAILED: ${error}`);
      return;
    }

    this.spinner.fail(`${this.spinner.text} ... FAILED: ${error}`);
    this.spinner = null;
  }

  private formatPrefix(step: number): string {
    const padded = String(step).padStart(String(this.totalSteps).length, " ");
    return `${padded}/${this.totalSteps}`;
  }
}
