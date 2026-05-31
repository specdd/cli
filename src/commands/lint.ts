import { posix, resolve } from 'node:path';
import { Command } from 'commander';
import { CliError } from '../cli-error.js';
import { CLI_HELP_FOOTER } from '../constants.js';
import type {
  SpecLintDiagnostic,
  SpecLintDirectoryNode,
  SpecLinter,
  SpecLintResult,
  SpecLintSpecNode,
} from '../services/spec-linter/spec-linter.js';

type SpecLinterDependency = Pick<SpecLinter, 'lint'>;

export type LintCommandContainer = {
  readonly specLinter: SpecLinterDependency;
};

export type CurrentWorkingDirectoryProvider = () => string;

export type OutputWriter = (message: string) => void;

export type ExitCodeSetter = (exitCode: number) => void;

type LintCommandOptions = {
  format: string;
};

type LintOutputFormat = 'json' | 'text';

type LintCompactSpec = {
  readonly diagnostics: readonly SpecLintDiagnostic[];
  readonly directoryLevel: boolean;
  readonly name: string;
  readonly path: string;
};

type LintCompactDirectory = {
  readonly path: string;
  readonly specs: readonly LintCompactSpec[];
};

type LintCompactResult = {
  readonly directories: readonly LintCompactDirectory[];
  readonly errorCount: number;
  readonly filesChecked: number;
  readonly ok: boolean;
  readonly rootDirectoryPath: string;
  readonly targetDirectoryPath: string;
  readonly targetPath: string;
  readonly warningCount: number;
};

export class LintInvalidFormatError extends CliError {
  public constructor(format: string) {
    super(`Unsupported lint output format: ${format}`);
    this.name = 'LintInvalidFormatError';
  }
}

export const resolveLintTargetPath = (
  currentWorkingDirectoryPath: string,
  targetPath: string | undefined,
): string => {
  return resolve(currentWorkingDirectoryPath, targetPath ?? '.');
};

export const resolveLintOutputFormat = (format: string): LintOutputFormat => {
  if ('json' === format || 'text' === format) {
    return format;
  }

  throw new LintInvalidFormatError(format);
};

export const renderLintResult = (result: SpecLintResult, format: string): string => {
  if ('json' === format) {
    return `${JSON.stringify(compactLintResult(result), null, 2)}\n`;
  }

  if ('text' === format) {
    return renderLintText(result);
  }

  throw new LintInvalidFormatError(format);
};

const compactLintResult = (result: SpecLintResult): LintCompactResult => {
  return {
    directories: compactLintDirectories(result.root),
    errorCount: result.errorCount,
    filesChecked: result.filesChecked,
    ok: result.ok,
    rootDirectoryPath: result.rootDirectoryPath,
    targetDirectoryPath: result.targetDirectoryPath,
    targetPath: result.targetPath,
    warningCount: result.warningCount,
  };
};

const compactLintDirectories = (
  node: SpecLintDirectoryNode,
): readonly LintCompactDirectory[] => {
  const directories = [];
  const directory = compactLintDirectory(node);

  if (null !== directory) {
    directories.push(directory);
  }

  for (const child of node.children) {
    if ('directory' === child.type) {
      directories.push(...compactLintDirectories(child));
    }
  }

  return directories;
};

const compactLintDirectory = (node: SpecLintDirectoryNode): LintCompactDirectory | null => {
  const directorySpecs = lintDirectorySpecs(node);
  const specChildren = node.children.filter((child): child is SpecLintSpecNode => 'spec' === child.type);

  if ('.' !== node.path && 0 === directorySpecs.length && 0 === specChildren.length) {
    return null;
  }

  return {
    path: renderLintDirectoryPath(node),
    specs: [
      ...directorySpecs.map((spec) => compactLintSpec(spec)),
      ...specChildren.map((child) => compactLintSpec(child)),
    ],
  };
};

const compactLintSpec = (node: SpecLintSpecNode): LintCompactSpec => {
  return {
    diagnostics: node.diagnostics,
    directoryLevel: node.directoryLevel,
    name: node.name,
    path: node.path,
  };
};

const lintDirectorySpecs = (node: SpecLintDirectoryNode): readonly SpecLintSpecNode[] => {
  return node.specs;
};

const renderLintText = (result: SpecLintResult): string => {
  return `${[
    ...renderLintDiagnosticBlocks(result.diagnostics),
    renderLintSummary(result),
  ].join('\n\n')}\n`;
};

const renderLintDiagnosticBlocks = (
  diagnostics: readonly SpecLintDiagnostic[],
): string[] => {
  const diagnosticsByPath = new Map<string, SpecLintDiagnostic[]>();

  for (const diagnostic of diagnostics) {
    diagnosticsByPath.set(diagnostic.path, [
      ...(diagnosticsByPath.get(diagnostic.path) ?? []),
      diagnostic,
    ]);
  }

  return [
    ...diagnosticsByPath.entries(),
  ].map(([path, pathDiagnostics]) => [
    `${path}:`,
    ...pathDiagnostics.map((diagnostic) => `${indent(1)}- ${renderLintDiagnostic(diagnostic)}`),
  ].join('\n'));
};

const renderLintDirectoryPath = (node: SpecLintDirectoryNode): string => {
  if ('.' === node.path) {
    return '/';
  }

  return `/${node.path.split(posix.sep).join('/')}/`;
};

const renderLintDiagnostic = (diagnostic: SpecLintDiagnostic): string => {
  const line = undefined === diagnostic.lineNumber ? '' : `, line ${diagnostic.lineNumber}`;

  return `${formatLintCategory(diagnostic.code)} ${diagnostic.severity}${line}: ${diagnostic.message}`;
};

const formatLintCategory = (code: string): string => {
  const category = code.replaceAll('-', ' ');

  return `${category.charAt(0).toUpperCase()}${category.slice(1)}`;
};

const renderLintSummary = (result: SpecLintResult): string => {
  return `${result.errorCount} ${pluralize('error', result.errorCount)}, ${result.warningCount} ${pluralize('warning', result.warningCount)} in ${result.filesChecked} ${pluralize('spec', result.filesChecked)}`;
};

const pluralize = (word: string, count: number): string => {
  if (1 === count) {
    return word;
  }

  return `${word}s`;
};

const indent = (depth: number): string => {
  return '  '.repeat(depth);
};

export const createLintCommand = (
  container: LintCommandContainer,
  getCurrentWorkingDirectory: CurrentWorkingDirectoryProvider = () => process.cwd(),
  writeOutput: OutputWriter = (message) => {
    process.stdout.write(message);
  },
  setExitCode: ExitCodeSetter = (exitCode) => {
    process.exitCode = exitCode;
  },
): Command => {
  const command = new Command('lint');

  command
    .description('Lint SpecDD spec files.')
    .argument('[path]', 'Directory, .sdd file, or ordinary file to lint. Defaults to the current directory.')
    .option('--format <format>', 'Output format: text or json.', 'text')
    .addHelpText(
      'after',
      CLI_HELP_FOOTER,
    )
    .action(async (targetPath: string | undefined, options: LintCommandOptions) => {
      const format = resolveLintOutputFormat(options.format);
      const currentWorkingDirectoryPath = getCurrentWorkingDirectory();
      const result = await container.specLinter.lint({
        rootDirectoryPath: currentWorkingDirectoryPath,
        targetPath: resolveLintTargetPath(currentWorkingDirectoryPath, targetPath),
      });

      writeOutput(renderLintResult(result, format));

      if (!result.ok) {
        setExitCode(1);
      }
    });

  return command;
};
