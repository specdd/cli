#!/usr/bin/env node
import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command, CommanderError } from 'commander';
import { isCliError } from './cli-error.js';
import { CLI_HELP_FOOTER } from './constants.js';
import { Container } from './container.js';
import type { Logger } from './services/logger/logger.js';

type MainErrorLogger = Pick<Logger, 'error'>;

type MainContainer = Pick<
  Container,
  'agentSkillsCommand' | 'checkUpdateCommand' | 'initCommand' | 'inspectCommand' | 'lintCommand' | 'resolveCommand' | 'updateCommand'
> & {
  readonly logger: MainErrorLogger;
};

export type MainExit = (exitCode: number) => never | void;

export type MainRealPathResolver = (path: string) => Promise<string>;

export type MainSelfRunRequest = {
  readonly argv: readonly string[];
  readonly container?: MainContainer;
  readonly entrypointPath: string | undefined;
  readonly environment: NodeJS.ProcessEnv;
  readonly exit?: MainExit;
  readonly modulePath: string;
  readonly realPath: MainRealPathResolver;
};

export class Main {
  private readonly container: MainContainer;

  public constructor(container: MainContainer) {
    this.container = container;
  }

  public createCommand(): Command {
    const command = new Command();

    command
      .exitOverride()
      .name('specdd')
      .description('Work with SpecDD framework files in a project.')
      .addHelpText(
        'after',
        CLI_HELP_FOOTER,
      )
      .addCommand(this.container.agentSkillsCommand)
      .addCommand(this.container.checkUpdateCommand)
      .addCommand(this.container.initCommand)
      .addCommand(this.container.inspectCommand)
      .addCommand(this.container.lintCommand)
      .addCommand(this.container.resolveCommand)
      .addCommand(this.container.updateCommand);

    return command;
  }

  public async run(argv: readonly string[]): Promise<void> {
    try {
      await this.createCommand().parseAsync([
        ...argv,
      ], {
        from: 'node',
      });
    } catch (error) {
      if (this.isSuccessfulCommanderExit(error)) {
        return;
      }

      throw error;
    }
  }

  public static async selfRun(request: MainSelfRunRequest): Promise<void> {
    if (!await Main.shouldSelfRun(request)) {
      return;
    }

    let container: MainContainer | undefined;

    try {
      container = request.container ?? new Container();

      await new Main(container).run(request.argv);
    } catch (error) {
      Main.exitFromRunError(
        error,
        container?.logger,
        request.exit ?? ((exitCode): never => process.exit(exitCode)),
      );
    }
  }

  private isSuccessfulCommanderExit(error: unknown): boolean {
    return error instanceof CommanderError && 0 === error.exitCode;
  }

  private static async shouldSelfRun(request: MainSelfRunRequest): Promise<boolean> {
    if ('test' === request.environment.NODE_ENV) {
      return false;
    }

    if (undefined !== request.environment.JEST_WORKER_ID) {
      return false;
    }

    if (undefined === request.entrypointPath) {
      return false;
    }

    return await Main.resolveRealPath(request.modulePath, request.realPath) === await Main.resolveRealPath(
      request.entrypointPath,
      request.realPath,
    );
  }

  private static async resolveRealPath(path: string, realPath: MainRealPathResolver): Promise<string> {
    return resolve(await realPath(path));
  }

  private static exitFromRunError(error: unknown, logger: MainErrorLogger | undefined, exit: MainExit): void {
    if (error instanceof CommanderError) {
      exit(error.exitCode);

      return;
    }

    if (isCliError(error)) {
      Main.writeExpectedError(error, logger);
      exit(1);

      return;
    }

    throw error;
  }

  private static writeExpectedError(error: Error, logger: MainErrorLogger | undefined): void {
    if (undefined !== logger) {
      logger.error(error.message);

      return;
    }

    try {
      process.stderr.write(`[error] ${error.message}\n`);
    } catch {
      return;
    }
  }
}

await Main.selfRun({
  argv: process.argv,
  entrypointPath: process.argv[1],
  environment: process.env,
  modulePath: fileURLToPath(import.meta.url),
  realPath: realpath,
});
