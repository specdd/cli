import { posix, relative, resolve } from 'node:path';
import { Command } from 'commander';
import { CliError } from '../cli-error.js';
import { CLI_HELP_FOOTER } from '../constants.js';
import type { SpecSection } from '../services/spec-parser/spec-parser.js';
import type {
  SpecResolveDirectoryNode,
  SpecResolveLinkDepth,
  SpecResolveReason,
  SpecResolver,
  SpecResolveResult,
  SpecResolveSpecNode,
} from '../services/spec-resolver/spec-resolver.js';

type SpecResolverDependency = Pick<SpecResolver, 'resolve'>;

export type ResolveCommandContainer = {
  readonly specResolver: SpecResolverDependency;
};

export type CurrentWorkingDirectoryProvider = () => string;

export type OutputWriter = (message: string) => void;

type ResolveCommandOptions = {
  depth: string;
  format: string;
  root?: string;
  section: string[];
  sections?: string;
};

type ResolveOutputFormat = 'json' | 'json-extended' | 'text';

type ResolveCompactSection = {
  readonly body: readonly string[];
  readonly inlineValue?: string;
};

type ResolveCompactSpec = {
  readonly directoryLevel: boolean;
  readonly name: string;
  readonly path: string;
  readonly reasons: readonly SpecResolveReason[];
  readonly sections: Readonly<Record<string, readonly ResolveCompactSection[]>>;
  readonly title: string;
};

type ResolveCompactDirectory = {
  readonly path: string;
  readonly specs: readonly ResolveCompactSpec[];
};

type ResolveCompactResult = {
  readonly directories: readonly ResolveCompactDirectory[];
  readonly linkDepth: SpecResolveLinkDepth;
  readonly rootDirectoryPath: string;
  readonly sectionNames: readonly string[];
  readonly targetPath: string;
};

type ResolveVisibleReason = Exclude<SpecResolveReason, {
  readonly kind: 'target';
}>;

type ResolveTextSpecEntry = {
  readonly directoryPath: string;
  readonly spec: SpecResolveSpecNode;
};

type ResolveTextDirectoryGroup = {
  readonly directoryPath: string;
  readonly specs: ResolveTextSpecEntry[];
};

const RESOLVE_LINK_REASON_PHRASES: ReadonlyMap<string, string> = new Map([
  [
    'Can modify',
    'can modify',
  ],
  [
    'Can read',
    'can read',
  ],
  [
    'Depends on',
    'depends on',
  ],
  [
    'References',
    'references',
  ],
  [
    'Structure',
    'defines structure at',
  ],
  [
    'Owns',
    'owns',
  ],
]);

export class ResolveInvalidDepthError extends CliError {
  public constructor(depth: string) {
    super(`Unsupported resolve depth: ${depth}`);
    this.name = 'ResolveInvalidDepthError';
  }
}

export class ResolveInvalidFormatError extends CliError {
  public constructor(format: string) {
    super(`Unsupported resolve output format: ${format}`);
    this.name = 'ResolveInvalidFormatError';
  }
}

export const resolveResolveTargetPath = (
  currentWorkingDirectoryPath: string,
  targetPath: string,
): string => {
  return resolve(currentWorkingDirectoryPath, targetPath);
};

export const resolveResolveRootPath = (
  currentWorkingDirectoryPath: string,
  rootPath: string | undefined,
): string => {
  return resolve(currentWorkingDirectoryPath, rootPath ?? '.');
};

export const collectResolveSectionOption = (value: string, previous: string[]): string[] => {
  return [
    ...previous,
    value,
  ];
};

export const resolveResolveSectionNames = (
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

  return sectionNames;
};

export const resolveResolveDepth = (depth: string): SpecResolveLinkDepth => {
  if ('all' === depth) {
    return 'all';
  }

  if (!/^\d+$/u.test(depth)) {
    throw new ResolveInvalidDepthError(depth);
  }

  return Number(depth);
};

export const resolveResolveOutputFormat = (format: string): ResolveOutputFormat => {
  if ('json' === format || 'json-extended' === format || 'text' === format) {
    return format;
  }

  throw new ResolveInvalidFormatError(format);
};

export const renderResolve = (result: SpecResolveResult, format: string): string => {
  if ('json' === format) {
    return `${JSON.stringify(compactResolveResult(result), null, 2)}\n`;
  }

  if ('json-extended' === format) {
    return `${JSON.stringify(result, null, 2)}\n`;
  }

  if ('text' === format) {
    return renderResolveText(result);
  }

  throw new ResolveInvalidFormatError(format);
};

const compactResolveResult = (result: SpecResolveResult): ResolveCompactResult => {
  return {
    directories: compactResolveDirectories(result.root),
    linkDepth: result.linkDepth,
    rootDirectoryPath: result.rootDirectoryPath,
    sectionNames: result.sectionNames,
    targetPath: result.targetPath,
  };
};

const compactResolveDirectories = (
  node: SpecResolveDirectoryNode,
): readonly ResolveCompactDirectory[] => {
  const directories = [];
  const directory = compactResolveDirectory(node);

  if (null !== directory) {
    directories.push(directory);
  }

  for (const child of node.children) {
    if ('directory' === child.type) {
      directories.push(...compactResolveDirectories(child));
    }
  }

  return directories;
};

const compactResolveDirectory = (node: SpecResolveDirectoryNode): ResolveCompactDirectory | null => {
  const specChildren = node.children.filter((child): child is SpecResolveSpecNode => 'spec' === child.type);

  if ('.' !== node.path && null === node.spec && 0 === specChildren.length) {
    return null;
  }

  return {
    path: renderResolveDirectoryPath(node.path),
    specs: [
      ...(null === node.spec ? [] : [
        compactResolveSpec(node.spec),
      ]),
      ...specChildren.map((child) => compactResolveSpec(child)),
    ],
  };
};

const compactResolveSpec = (node: SpecResolveSpecNode): ResolveCompactSpec => {
  return {
    directoryLevel: node.directoryLevel,
    name: node.name,
    path: node.path,
    reasons: node.reasons,
    sections: compactResolveSections(node),
    title: node.title,
  };
};

const compactResolveSections = (
  node: SpecResolveSpecNode,
): Readonly<Record<string, readonly ResolveCompactSection[]>> => {
  return Object.fromEntries(Object.entries(node.sections).map(([sectionName, sections]) => [
    sectionName,
    sections.map((section) => compactResolveSection(section)),
  ]));
};

const compactResolveSection = (section: SpecSection): ResolveCompactSection => {
  return {
    ...(null === section.inlineValue ? {} : {
      inlineValue: section.inlineValue,
    }),
    body: trimTextLines(section.body),
  };
};

const renderResolveText = (result: SpecResolveResult): string => {
  return `${renderResolveDirectoryBlocks(result).join('\n\n')}\n`;
};

const renderResolveDirectoryBlocks = (result: SpecResolveResult): string[] => {
  const entries = sortResolveTextSpecEntries(
    flattenResolveTextSpecEntries(result.root),
    resolveTextTargetDirectoryPath(result),
  );

  if (0 === entries.length) {
    return [
      '/',
    ];
  }

  return groupResolveTextSpecEntries(entries).map((group) => renderResolveDirectoryGroup(group));
};

const flattenResolveTextSpecEntries = (node: SpecResolveDirectoryNode): readonly ResolveTextSpecEntry[] => {
  const entries = [];

  if (null !== node.spec) {
    entries.push({
      directoryPath: node.path,
      spec: node.spec,
    });
  }

  return [
    ...entries,
    ...node.children.flatMap((child) => {
      if ('directory' === child.type) {
        return flattenResolveTextSpecEntries(child);
      }

      return [
        {
          directoryPath: posix.dirname(child.path),
          spec: child,
        },
      ];
    }),
  ];
};

const sortResolveTextSpecEntries = (
  entries: readonly ResolveTextSpecEntry[],
  targetDirectoryPath: string,
): readonly ResolveTextSpecEntry[] => {
  return [
    ...entries,
  ].sort((left, right) => {
    const scoreDifference = resolveTextRelevanceScore(left, targetDirectoryPath)
      - resolveTextRelevanceScore(right, targetDirectoryPath);

    if (0 !== scoreDifference) {
      return scoreDifference;
    }

    return left.spec.path.localeCompare(right.spec.path);
  });
};

const resolveTextTargetDirectoryPath = (result: SpecResolveResult): string => {
  const targetSpec = flattenResolveTextSpecEntries(result.root).find((entry) => hasTargetReason(entry.spec));

  if (undefined !== targetSpec) {
    return targetSpec.directoryPath;
  }

  const targetRelativePath = normalizeResolveTextPath(relative(result.rootDirectoryPath, result.targetPath));

  if ('' === targetRelativePath) {
    return '.';
  }

  return targetRelativePath;
};

const resolveTextRelevanceScore = (
  entry: ResolveTextSpecEntry,
  targetDirectoryPath: string,
): number => {
  if (hasTargetReason(entry.spec)) {
    return 0;
  }

  const reasonScores = entry.spec.reasons
    .filter(isResolveVisibleReason)
    .map((reason) => resolveTextReasonScore(reason, entry.directoryPath, targetDirectoryPath));

  if (0 === reasonScores.length) {
    return 10_000 + resolveTextDirectoryDistance(entry.directoryPath, targetDirectoryPath);
  }

  return Math.min(...reasonScores);
};

const resolveTextReasonScore = (
  reason: ResolveVisibleReason,
  directoryPath: string,
  targetDirectoryPath: string,
): number => {
  const directoryDistance = resolveTextDirectoryDistance(directoryPath, targetDirectoryPath);

  if ('parent' === reason.kind) {
    return directoryPath === targetDirectoryPath ? 10 : 200 + directoryDistance * 10;
  }

  return 100 + reason.depth * 10 + directoryDistance;
};

const resolveTextDirectoryDistance = (leftPath: string, rightPath: string): number => {
  const leftSegments = resolveTextDirectorySegments(leftPath);
  const rightSegments = resolveTextDirectorySegments(rightPath);
  let commonSegmentCount = 0;

  while (
    commonSegmentCount < leftSegments.length
    && commonSegmentCount < rightSegments.length
    && leftSegments[commonSegmentCount] === rightSegments[commonSegmentCount]
  ) {
    commonSegmentCount += 1;
  }

  return leftSegments.length + rightSegments.length - commonSegmentCount * 2;
};

const resolveTextDirectorySegments = (path: string): readonly string[] => {
  if ('.' === path || '' === path) {
    return [];
  }

  return path.split('/');
};

const groupResolveTextSpecEntries = (
  entries: readonly ResolveTextSpecEntry[],
): readonly ResolveTextDirectoryGroup[] => {
  const groups = new Map<string, ResolveTextDirectoryGroup>();

  for (const entry of entries) {
    const group = groups.get(entry.directoryPath);

    if (undefined !== group) {
      group.specs.push(entry);

      continue;
    }

    groups.set(entry.directoryPath, {
      directoryPath: entry.directoryPath,
      specs: [
        entry,
      ],
    });
  }

  return [
    ...groups.values(),
  ];
};

const renderResolveDirectoryGroup = (group: ResolveTextDirectoryGroup): string => {
  return [
    renderResolveDirectoryPath(group.directoryPath),
    ...group.specs.flatMap((entry) => renderResolveSpec(entry.spec, 1)),
  ].join('\n');
};

const renderResolveDirectoryPath = (path: string): string => {
  if ('.' === path) {
    return '/';
  }

  return `/${path.split(posix.sep).join('/')}/`;
};

const renderResolveSpec = (node: SpecResolveSpecNode, depth: number): string[] => {
  return [
    `${indent(depth)}${node.name}`,
    ...renderResolveReasons(node.reasons, depth + 1),
    ...renderResolveSpecSections(node, depth + 1),
  ];
};

const renderResolveReasons = (reasons: readonly SpecResolveReason[], depth: number): string[] => {
  if (reasons.some((reason) => 'target' === reason.kind)) {
    return [];
  }

  const visibleReasons = reasons.filter(isResolveVisibleReason);

  if (0 === visibleReasons.length) {
    return [];
  }

  return [
    `${indent(depth)}Relevant because:`,
    ...visibleReasons.map((reason) => `${indent(depth + 1)}- ${renderResolveReason(reason)}`),
  ];
};

const isResolveVisibleReason = (reason: SpecResolveReason): reason is ResolveVisibleReason => {
  return 'target' !== reason.kind;
};

const hasTargetReason = (node: SpecResolveSpecNode): boolean => {
  return node.reasons.some((reason) => 'target' === reason.kind);
};

const renderResolveReason = (reason: ResolveVisibleReason): string => {
  if ('parent' === reason.kind) {
    return '.' === reason.directoryPath ? 'Parent context for /' : `Parent context for /${reason.directoryPath}/`;
  }

  return `${reason.fromPath} ${RESOLVE_LINK_REASON_PHRASES.get(reason.sectionName) as string} ${reason.target}`;
};

const normalizeResolveTextPath = (path: string): string => {
  return path.replaceAll('\\', '/');
};

const renderResolveSpecSections = (node: SpecResolveSpecNode, depth: number): string[] => {
  const lines: string[] = [];

  for (const sections of Object.values(node.sections)) {
    for (const section of sections) {
      lines.push(...renderResolveSection(section, depth));
    }
  }

  return lines;
};

const renderResolveSection = (section: SpecSection, depth: number): string[] => {
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

export const createResolveCommand = (
  container: ResolveCommandContainer,
  getCurrentWorkingDirectory: CurrentWorkingDirectoryProvider = () => process.cwd(),
  writeOutput: OutputWriter = (message) => {
    process.stdout.write(message);
  },
): Command => {
  const command = new Command('resolve');

  command
    .description('Resolve relevant SpecDD specs for a target path.')
    .argument('<target>', 'Directory or .sdd file to resolve.')
    .option('--root <path>', 'Root directory for resolution. Defaults to the current directory.')
    .option('--section <name>', 'Section to include. May be repeated.', collectResolveSectionOption, [])
    .option('--sections <names>', 'Comma-separated sections to include.')
    .option('--depth <depth>', 'Soft-link expansion depth: non-negative integer or all.', '2')
    .option('--format <format>', 'Output format: text, json, or json-extended.', 'text')
    .addHelpText(
      'after',
      CLI_HELP_FOOTER,
    )
    .action(async (targetPath: string, options: ResolveCommandOptions) => {
      const format = resolveResolveOutputFormat(options.format);
      const sectionNames = resolveResolveSectionNames(options.section, options.sections);
      const result = await container.specResolver.resolve({
        linkDepth: resolveResolveDepth(options.depth),
        rootDirectoryPath: resolveResolveRootPath(getCurrentWorkingDirectory(), options.root),
        ...(undefined === sectionNames ? {} : {
          sectionNames,
        }),
        targetPath: resolveResolveTargetPath(getCurrentWorkingDirectory(), targetPath),
      });

      writeOutput(renderResolve(result, format));
    });

  return command;
};
