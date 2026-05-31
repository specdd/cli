import { posix, resolve } from 'node:path';
import { Command } from 'commander';
import { CliError } from '../cli-error.js';
import { CLI_HELP_FOOTER } from '../constants.js';
import type {
  SpecTree,
  SpecTreeDirectoryNode,
  SpecTreeResult,
  SpecTreeSpecNode,
} from '../services/spec-tree/spec-tree.js';
import {
  SPEC_SECTION_NAMES,
  type SpecSection,
} from '../services/spec-parser/spec-parser.js';

type SpecTreeDependency = Pick<SpecTree, 'build'>;

export type InspectCommandContainer = {
  readonly specTree: SpecTreeDependency;
};

export type CurrentWorkingDirectoryProvider = () => string;

export type OutputWriter = (message: string) => void;

type InspectCommandOptions = {
  format: string;
  section: string[];
  sections?: string;
};

type InspectOutputFormat = 'json' | 'json-extended' | 'text';

type InspectCompactSection = {
  readonly body: readonly string[];
  readonly inlineValue?: string;
};

type InspectCompactSpec = {
  readonly directoryLevel: boolean;
  readonly name: string;
  readonly path: string;
  readonly sections: Readonly<Record<string, readonly InspectCompactSection[]>>;
  readonly title: string;
};

type InspectCompactDirectory = {
  readonly path: string;
  readonly specs: readonly InspectCompactSpec[];
};

type InspectCompactResult = {
  readonly directories: readonly InspectCompactDirectory[];
  readonly rootDirectoryPath: string;
  readonly sectionNames: readonly string[];
  readonly targetDirectoryPath: string;
  readonly targetPath: string;
};

export class InspectInvalidFormatError extends CliError {
  public constructor(format: string) {
    super(`Unsupported inspect output format: ${format}`);
    this.name = 'InspectInvalidFormatError';
  }
}

export const resolveInspectTargetPath = (
  currentWorkingDirectoryPath: string,
  targetPath: string | undefined,
): string => {
  return resolve(currentWorkingDirectoryPath, targetPath ?? '.');
};

export const collectInspectSectionOption = (value: string, previous: string[]): string[] => {
  return [
    ...previous,
    value,
  ];
};

export const resolveInspectSectionNames = (
  sectionOptions: readonly string[],
  sectionsOption: string | undefined,
): readonly string[] | undefined => {
  const sectionNames = [
    ...sectionOptions,
    ...((sectionsOption ?? '').split(',')),
  ].map((sectionName) => sectionName.trim()).filter((sectionName) => '' !== sectionName);

  if (0 === sectionNames.length) {
    return undefined;
  }

  if (sectionNames.some((sectionName) => 'all' === sectionName)) {
    return SPEC_SECTION_NAMES;
  }

  return sectionNames;
};

export const renderInspect = (result: SpecTreeResult, format: string): string => {
  if ('json' === format) {
    return `${JSON.stringify(compactInspectResult(result), null, 2)}\n`;
  }

  if ('json-extended' === format) {
    return `${JSON.stringify(result, null, 2)}\n`;
  }

  if ('text' === format) {
    return renderInspectText(result);
  }

  throw new InspectInvalidFormatError(format);
};

export const resolveInspectOutputFormat = (format: string): InspectOutputFormat => {
  if ('json' === format || 'json-extended' === format || 'text' === format) {
    return format;
  }

  throw new InspectInvalidFormatError(format);
};

const compactInspectResult = (result: SpecTreeResult): InspectCompactResult => {
  return {
    directories: compactInspectDirectories(result.root),
    rootDirectoryPath: result.rootDirectoryPath,
    sectionNames: result.sectionNames,
    targetDirectoryPath: result.targetDirectoryPath,
    targetPath: result.targetPath,
  };
};

const compactInspectDirectories = (
  node: SpecTreeDirectoryNode,
): readonly InspectCompactDirectory[] => {
  const directories = [];
  const directory = compactInspectDirectory(node);

  if (null !== directory) {
    directories.push(directory);
  }

  for (const child of node.children) {
    if ('directory' === child.type) {
      directories.push(...compactInspectDirectories(child));
    }
  }

  return directories;
};

const compactInspectDirectory = (node: SpecTreeDirectoryNode): InspectCompactDirectory | null => {
  const directorySpecs = inspectDirectorySpecs(node);
  const specChildren = node.children.filter((child): child is SpecTreeSpecNode => 'spec' === child.type);

  if ('.' !== node.path && 0 === directorySpecs.length && 0 === specChildren.length) {
    return null;
  }

  return {
    path: renderInspectDirectoryPath(node),
    specs: [
      ...directorySpecs.map((spec) => compactInspectSpec(spec)),
      ...specChildren.map((child) => compactInspectSpec(child)),
    ],
  };
};

const compactInspectSpec = (node: SpecTreeSpecNode): InspectCompactSpec => {
  return {
    directoryLevel: node.directoryLevel,
    name: node.name,
    path: node.path,
    sections: compactInspectSections(node),
    title: node.title,
  };
};

const compactInspectSections = (
  node: SpecTreeSpecNode,
): Readonly<Record<string, readonly InspectCompactSection[]>> => {
  return Object.fromEntries(Object.entries(node.sections).map(([sectionName, sections]) => [
    sectionName,
    sections.map((section) => compactInspectSection(section)),
  ]));
};

const compactInspectSection = (section: SpecSection): InspectCompactSection => {
  return {
    ...(null === section.inlineValue ? {} : {
      inlineValue: section.inlineValue,
    }),
    body: trimTextLines(section.body),
  };
};

const renderInspectText = (result: SpecTreeResult): string => {
  return `${renderInspectDirectoryBlocks(result.root).join('\n\n')}\n`;
};

const renderInspectDirectoryBlocks = (
  node: SpecTreeDirectoryNode,
): string[] => {
  const blocks = [];
  const block = renderInspectDirectoryBlock(node);

  if (null !== block) {
    blocks.push(block);
  }

  for (const child of node.children) {
    if ('directory' === child.type) {
      blocks.push(...renderInspectDirectoryBlocks(child));
    }
  }

  return blocks;
};

const renderInspectDirectoryBlock = (node: SpecTreeDirectoryNode): string | null => {
  const directorySpecs = inspectDirectorySpecs(node);
  const specChildren = node.children.filter((child): child is SpecTreeSpecNode => 'spec' === child.type);
  const specs = [
    ...directorySpecs,
    ...specChildren,
  ];

  if ('.' !== node.path && 0 === specs.length) {
    return null;
  }

  return [
    renderInspectDirectoryPath(node),
    ...renderInspectSpecs(specs, 1),
  ].join('\n');
};

const renderInspectDirectoryPath = (node: SpecTreeDirectoryNode): string => {
  if ('.' === node.path) {
    return '/';
  }

  return `/${node.path.split(posix.sep).join('/')}/`;
};

const renderInspectSpecs = (specs: readonly SpecTreeSpecNode[], depth: number): string[] => {
  const duplicateNames = duplicateSpecNames(specs);

  return specs.flatMap((spec) => renderInspectSpec(spec, depth, duplicateNames.has(spec.name)));
};

const renderInspectSpec = (node: SpecTreeSpecNode, depth: number, usePathLabel: boolean): string[] => {
  return [
    `${indent(depth)}${usePathLabel ? node.path : node.name}`,
    ...renderInspectSpecSections(node, depth + 1),
  ];
};

const duplicateSpecNames = (specs: readonly SpecTreeSpecNode[]): ReadonlySet<string> => {
  const seenNames = new Set<string>();
  const duplicateNames = new Set<string>();

  for (const spec of specs) {
    if (seenNames.has(spec.name)) {
      duplicateNames.add(spec.name);

      continue;
    }

    seenNames.add(spec.name);
  }

  return duplicateNames;
};

const inspectDirectorySpecs = (node: SpecTreeDirectoryNode): readonly SpecTreeSpecNode[] => {
  return node.specs;
};

const renderInspectSpecSections = (node: SpecTreeSpecNode, depth: number): string[] => {
  const lines: string[] = [];

  for (const sections of Object.values(node.sections)) {
    for (const section of sections) {
      lines.push(...renderInspectSection(section, depth));
    }
  }

  return lines;
};

const renderInspectSection = (section: SpecSection, depth: number): string[] => {
  const sectionHeader = null === section.inlineValue ? `${section.name}:` : `${section.name}: ${section.inlineValue}`;
  const body = trimTextLines(section.body);
  const lines = [
    `${indent(depth)}${sectionHeader}`,
  ];

  if (0 === body.length) {
    return lines;
  }

  lines.push(...body.map((line) => `${indent(depth + 1)}${line}`));

  return lines;
};

const indent = (depth: number): string => {
  return '  '.repeat(depth);
};

const trimTextLines = (text: string): readonly string[] => {
  const lines = text.split('\n').map((line) => line.trim());

  while (0 < lines.length && '' === lines[0]) {
    lines.shift();
  }

  while (0 < lines.length && '' === lines[lines.length - 1]) {
    lines.pop();
  }

  return lines;
};

export const createInspectCommand = (
  container: InspectCommandContainer,
  getCurrentWorkingDirectory: CurrentWorkingDirectoryProvider = () => process.cwd(),
  writeOutput: OutputWriter = (message) => {
    process.stdout.write(message);
  },
): Command => {
  const command = new Command('inspect');

  command
    .description('Inspect SpecDD spec files and selected sections.')
    .argument('[path]', 'Directory, .sdd file, or ordinary file to inspect. Defaults to the current directory.')
    .option('--section <name>', 'Section to include, or all. May be repeated.', collectInspectSectionOption, [])
    .option('--sections <names>', 'Comma-separated sections to include, or all.')
    .option('--format <format>', 'Output format: text, json, or json-extended.', 'text')
    .addHelpText(
      'after',
      CLI_HELP_FOOTER,
    )
    .action(async (targetPath: string | undefined, options: InspectCommandOptions) => {
      const format = resolveInspectOutputFormat(options.format);
      const sectionNames = resolveInspectSectionNames(options.section, options.sections);
      const currentWorkingDirectoryPath = getCurrentWorkingDirectory();
      const result = await container.specTree.build({
        rootDirectoryPath: currentWorkingDirectoryPath,
        ...(undefined === sectionNames ? {} : {
          sectionNames,
        }),
        targetPath: resolveInspectTargetPath(currentWorkingDirectoryPath, targetPath),
      });

      writeOutput(renderInspect(result, format));
    });

  return command;
};
