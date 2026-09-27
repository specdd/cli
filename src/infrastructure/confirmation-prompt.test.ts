import { jest } from '@jest/globals';
import { PassThrough } from 'node:stream';
import { ConfirmationPrompt } from './confirmation-prompt.js';

describe('ConfirmationPrompt', () => {
  let input: PassThrough & { isTTY: boolean };
  let output: PassThrough & { isTTY: boolean };
  let prompt: ConfirmationPrompt;
  let written: string;

  beforeEach(() => {
    input = Object.assign(new PassThrough(), { isTTY: true, });
    output = Object.assign(new PassThrough(), { isTTY: true, });
    written = '';
    output.on('data', (data: Buffer) => { written += data.toString(); });
    prompt = new ConfirmationPrompt(input, output);
  });

  afterEach(() => {
    input.destroy();
    output.destroy();
    jest.restoreAllMocks();
  });

  it.each(['y', 'Y', 'yes', 'YES', ' yes ',])('accepts only an explicit affirmative: %s', async (answer) => {
    const result = prompt.confirm();
    input.write(`${answer}\n`);
    expect(await result).toBe(true);
    expect(written).toContain('Continue? [y/N]');
    expect(input.isPaused()).toBe(true);
    expect(input.listenerCount('keypress')).toBe(0);
    expect(input.listenerCount('error')).toBe(0);
    expect(output.listenerCount('error')).toBe(0);
  });

  it.each(['', 'n', 'no', 'true', 'maybe', 'yes please',])('declines %s', async (answer) => {
    const result = prompt.confirm();
    input.write(`${answer}\n`);
    expect(await result).toBe(false);
  });

  it('declines EOF and terminal Ctrl-C', async () => {
    const eof = prompt.confirm();
    input.end();
    expect(await eof).toBe(false);
    input = Object.assign(new PassThrough(), { isTTY: true, });
    const cancelled = new ConfirmationPrompt(input, output).confirm();
    input.write('\u0003');
    expect(await cancelled).toBe(false);
    expect(input.listenerCount('error')).toBe(0);
  });

  it.each(['input', 'output',])('declines %s stream failure', async (stream) => {
    const result = prompt.confirm();
    ('input' === stream ? input : output).emit('error', new Error('disconnected'));
    expect(await result).toBe(false);
  });

  it('declines when writing the prompt fails synchronously', async () => {
    jest.spyOn(output, 'write').mockImplementation(() => { throw new Error('write failed'); });
    expect(await prompt.confirm()).toBe(false);
    expect(input.isPaused()).toBe(true);
    expect(input.listenerCount('error')).toBe(0);
  });

  it.each(['input', 'output',])('does not read redirected %s', async (stream) => {
    ('input' === stream ? input : output).isTTY = false;
    expect(await prompt.confirm()).toBe(false);
    expect(written).toBe('');
    expect(input.listenerCount('data')).toBe(0);
  });

  it('declines closed streams', async () => {
    input.destroy();
    expect(await prompt.confirm()).toBe(false);
  });

  it('uses process streams by default and declines noninteractive execution', async () => {
    const descriptor = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: false, });
    try {
      expect(await new ConfirmationPrompt().confirm()).toBe(false);
    } finally {
      if (descriptor) {
        Object.defineProperty(process.stdin, 'isTTY', descriptor);
      } else {
        Reflect.deleteProperty(process.stdin, 'isTTY');
      }
    }
  });
});
