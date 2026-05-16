import { Chalk, type ChalkInstance } from 'chalk';
import { CliError } from '../../cli-error.js';
import type { Config } from '../config/config.js';

export type LoggerStream = {
  write(message: string): unknown;
};

export type LoggerOptions = {
  stdout?: LoggerStream;
  stderr?: LoggerStream;
  colorLevel?: 0 | 1 | 2 | 3;
};

type NoticeLevel = 'error' | 'warning' | 'log' | 'info' | 'debug';

const NOTICE_LEVELS: Record<NoticeLevel, number> = {
  error: 0,
  warning: 1,
  log: 2,
  info: 3,
  debug: 4,
};

export class InvalidLogLevelError extends CliError {
  public constructor(logLevel: unknown) {
    super(`Invalid log_level config value: ${String(logLevel)}`);
    this.name = 'InvalidLogLevelError';
  }
}

export class Logger {
  private readonly stdout: LoggerStream;

  private readonly stderr: LoggerStream;

  private readonly minimumLevel: NoticeLevel;

  private readonly chalk: ChalkInstance;

  public constructor(config: Config, options: LoggerOptions = {}) {
    this.stdout = options.stdout ?? process.stdout;
    this.stderr = options.stderr ?? process.stderr;
    this.minimumLevel = this.resolveLogLevel(config);
    this.chalk = new Chalk({ level: options.colorLevel ?? 1 });
  }

  public error(message: string): void {
    this.write('error', message);
  }

  public warn(message: string): void {
    this.write('warning', message);
  }

  public log(message: string): void {
    this.write('log', message);
  }

  public info(message: string): void {
    this.write('info', message);
  }

  public debug(message: string): void {
    this.write('debug', message);
  }

  private resolveLogLevel(config: Config): NoticeLevel {
    const configuredLevel = config.get('log_level', 'info');

    if ('string' !== typeof configuredLevel) {
      throw new InvalidLogLevelError(configuredLevel);
    }

    const normalizedLevel = configuredLevel.toLowerCase();

    if ('warn' === normalizedLevel) {
      return 'warning';
    }

    if (true === this.isNoticeLevel(normalizedLevel)) {
      return normalizedLevel;
    }

    throw new InvalidLogLevelError(configuredLevel);
  }

  private isNoticeLevel(level: string): level is NoticeLevel {
    return Object.hasOwn(NOTICE_LEVELS, level);
  }

  private write(level: NoticeLevel, message: string): void {
    if (NOTICE_LEVELS[level] > NOTICE_LEVELS[this.minimumLevel]) {
      return;
    }

    const line = `${this.formatLevel(level)} ${message}\n`;
    const stream = 'error' === level ? this.stderr : this.stdout;

    try {
      stream.write(line);
    } catch {
      return;
    }
  }

  private formatLevel(level: NoticeLevel): string {
    if ('error' === level) {
      return this.chalk.red('[error]');
    }

    if ('warning' === level) {
      return this.chalk.yellow('[warn]');
    }

    if ('info' === level) {
      return this.chalk.cyan('[info]');
    }

    if ('debug' === level) {
      return this.chalk.gray('[debug]');
    }

    return this.chalk.white('[log]');
  }
}
