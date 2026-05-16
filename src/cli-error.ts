export class CliError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'CliError';
  }
}

export const isCliError = (error: unknown): error is CliError => {
  return error instanceof CliError;
};
