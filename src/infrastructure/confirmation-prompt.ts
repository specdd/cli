import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { CLI_CONTINUE_PROMPT } from '../constants.js';

export class ConfirmationPrompt {
  public constructor(
    private readonly input: Readable & { isTTY?: boolean } = process.stdin,
    private readonly output: Writable & { isTTY?: boolean } = process.stdout,
  ) {}

  public async confirm(): Promise<boolean> {
    if (!this.input.isTTY || !this.output.isTTY || this.input.destroyed || this.output.destroyed) {
      return false;
    }

    return new Promise((resolve) => {
      const terminal = createInterface({ input: this.input, output: this.output, terminal: true, });
      let finished = false;
      const finish = (accepted: boolean): void => {
        if (finished) {
          return;
        }

        finished = true;
        terminal.close();
        terminal.removeAllListeners();
        this.input.off('error', cancel);
        this.output.off('error', cancel);
        resolve(accepted);
      };
      const cancel = (): void => { finish(false); };
      terminal.once('close', cancel);
      terminal.once('SIGINT', cancel);
      terminal.once('error', cancel);
      this.input.once('error', cancel);
      this.output.once('error', cancel);

      try {
        terminal.question(CLI_CONTINUE_PROMPT, (answer) => { finish(/^(y|yes)$/i.test(answer.trim())); });
      } catch {
        cancel();
      }
    });
  }
}
