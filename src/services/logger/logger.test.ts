import { jest } from '@jest/globals';
import { Config } from '../config/config.js';
import type { ConfigReader, ConfigValue } from '../config/config-reader.js';
import { InvalidLogLevelError, Logger, type LoggerStream } from './logger.js';

class StubReader implements ConfigReader {
  public constructor(private readonly values: Readonly<Record<string, ConfigValue | null>>) {}

  public get(key: string): ConfigValue | null {
    return this.values[key] ?? null;
  }
}

class MemoryStream implements LoggerStream {
  public readonly messages: string[] = [];

  public write(message: string): void {
    this.messages.push(message);
  }
}

class ThrowingStream implements LoggerStream {
  public write(): void {
    throw new Error('write failed');
  }
}

const createConfig = (logLevel: ConfigValue | null = null): Config => {
  return new Config([
    new StubReader({
      log_level: logLevel,
    }),
  ]);
};

const createLogger = (
  logLevel: ConfigValue | null = null,
  stdout: LoggerStream = new MemoryStream(),
  stderr: LoggerStream = new MemoryStream(),
): { logger: Logger; stdout: MemoryStream; stderr: MemoryStream } => {
  const resolvedStdout = stdout instanceof MemoryStream ? stdout : new MemoryStream();
  const resolvedStderr = stderr instanceof MemoryStream ? stderr : new MemoryStream();

  return {
    logger: new Logger(createConfig(logLevel), {
      colorLevel: 0,
      stderr: stderr instanceof MemoryStream ? stderr : resolvedStderr,
      stdout: stdout instanceof MemoryStream ? stdout : resolvedStdout,
    }),
    stderr: resolvedStderr,
    stdout: resolvedStdout,
  };
};

describe('Logger', () => {
  it('writes error notices to stderr', () => {
    const { logger, stderr, stdout } = createLogger('debug');

    logger.error('failed');

    expect(stderr.messages).toEqual([
      '[error] failed\n',
    ]);
    expect(stdout.messages).toEqual([]);
  });

  it('writes non-error notices to stdout', () => {
    const { logger, stderr, stdout } = createLogger('debug');

    logger.warn('careful');
    logger.log('done');
    logger.info('details');
    logger.debug('trace');

    expect(stdout.messages).toEqual([
      '[warn] careful\n',
      '[log] done\n',
      '[info] details\n',
      '[debug] trace\n',
    ]);
    expect(stderr.messages).toEqual([]);
  });

  it('defaults to info level when log_level is not configured', () => {
    const { logger, stdout, stderr } = createLogger();

    logger.error('failed');
    logger.warn('careful');
    logger.log('done');
    logger.info('details');
    logger.debug('trace');

    expect(stderr.messages).toEqual([
      '[error] failed\n',
    ]);
    expect(stdout.messages).toEqual([
      '[warn] careful\n',
      '[log] done\n',
      '[info] details\n',
    ]);
  });

  it('filters notices below warning level', () => {
    const { logger, stdout, stderr } = createLogger('warning');

    logger.error('failed');
    logger.warn('careful');
    logger.log('done');
    logger.info('details');
    logger.debug('trace');

    expect(stderr.messages).toEqual([
      '[error] failed\n',
    ]);
    expect(stdout.messages).toEqual([
      '[warn] careful\n',
    ]);
  });

  it('accepts warn as an alias for warning level', () => {
    const { logger, stdout } = createLogger('warn');

    logger.warn('careful');
    logger.log('done');

    expect(stdout.messages).toEqual([
      '[warn] careful\n',
    ]);
  });

  it('writes debug notices when log_level is debug', () => {
    const { logger, stdout } = createLogger('debug');

    logger.debug('trace');

    expect(stdout.messages).toEqual([
      '[debug] trace\n',
    ]);
  });

  it('throws when log_level is invalid', () => {
    expect(() => createLogger('verbose')).toThrow(InvalidLogLevelError);
  });

  it('throws when log_level is not a string', () => {
    expect(() => createLogger(0)).toThrow(InvalidLogLevelError);
  });

  it('does not throw when an ordinary stream write fails', () => {
    const logger = new Logger(createConfig('debug'), {
      colorLevel: 0,
      stderr: new ThrowingStream(),
      stdout: new ThrowingStream(),
    });

    expect(() => {
      logger.log('done');
      logger.error('failed');
    }).not.toThrow();
  });

  it('colors notice labels when color output is enabled', () => {
    const stdout = new MemoryStream();
    const logger = new Logger(createConfig('log'), {
      colorLevel: 1,
      stdout,
    });

    logger.log('done');

    expect(stdout.messages[0]).toContain('\u001b[');
    expect(stdout.messages[0]).toContain('[log]');
    expect(stdout.messages[0]).toContain('done\n');
  });

  it('uses process streams and default color output when streams are not injected', () => {
    const stdoutWrite = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const stderrWrite = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);

    try {
      const logger = new Logger(createConfig('log'));

      logger.log('done');
      logger.error('failed');

      expect(stdoutWrite).toHaveBeenCalledWith(expect.stringContaining('[log]'));
      expect(stdoutWrite).toHaveBeenCalledWith(expect.stringContaining('done\n'));
      expect(stderrWrite).toHaveBeenCalledWith(expect.stringContaining('[error]'));
      expect(stderrWrite).toHaveBeenCalledWith(expect.stringContaining('failed\n'));
    } finally {
      stdoutWrite.mockRestore();
      stderrWrite.mockRestore();
    }
  });
});
