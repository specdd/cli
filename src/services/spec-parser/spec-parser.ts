import { CliError } from '../../cli-error.js';
import type { FileReaderDependency } from '../../infrastructure/file-system.js';

export const SPEC_SECTION_NAMES = [
  'Spec',
  'Platform',
  'Purpose',
  'Structure',
  'Owns',
  'Can modify',
  'Can read',
  'References',
  'Must',
  'Must not',
  'Forbids',
  'Depends on',
  'Exposes',
  'Accepts',
  'Returns',
  'Raises',
  'Handles',
  'Tasks',
  'Done when',
  'Scenario',
  'Example',
] as const;

const REQUIRED_INLINE_VALUE_SECTIONS = new Set<SpecSectionName>([
  'Platform',
  'Scenario',
  'Spec',
]);

const INLINE_VALUE_SECTIONS = new Set<SpecSectionName>([
  'Example',
  'Platform',
  'Scenario',
  'Spec',
]);

const BODYLESS_SECTIONS = new Set<SpecSectionName>([
  'Platform',
  'Spec',
]);

const REPEATABLE_SECTIONS = new Set<SpecSectionName>([
  'Example',
  'Scenario',
]);

const SCENARIO_STEP_KEYWORDS = [
  'Given',
  'When',
  'Then',
  'And',
  'But',
] as const;

const TASK_STATUS_BY_MARKER = {
  '[ ]': 'open',
  '[!]': 'blocked',
  '[?]': 'question',
  '[-]': 'skipped',
  '[X]': 'done',
  '[x]': 'done',
} as const;

const BODY_ENTRY_INDENTATION = 2;
const CONTINUATION_INDENTATION = 4;
const INDENTATION_UNIT = 2;

export type SpecSectionName = typeof SPEC_SECTION_NAMES[number];

export type SpecBodyEntryKind = 'key-value' | 'scenario-step' | 'task' | 'text';

export type SpecTaskStatus = typeof TASK_STATUS_BY_MARKER[keyof typeof TASK_STATUS_BY_MARKER];

export type SpecTask = {
  readonly id: string | null;
  readonly marker: string;
  readonly status: SpecTaskStatus;
  readonly text: string;
};

export type SpecScenarioStep = {
  readonly keyword: typeof SCENARIO_STEP_KEYWORDS[number];
  readonly text: string;
};

export type SpecKeyValue = {
  readonly key: string;
  readonly value: string;
};

export type SpecBodyEntry = {
  readonly kind: SpecBodyEntryKind;
  readonly lineNumber: number;
  readonly rawLines: readonly string[];
  readonly text: string;
  readonly keyValue?: SpecKeyValue;
  readonly scenarioStep?: SpecScenarioStep;
  readonly task?: SpecTask;
};

export type SpecSection = {
  readonly name: SpecSectionName;
  readonly inlineValue: string | null;
  readonly body: string;
  readonly entries: readonly SpecBodyEntry[];
  readonly lineNumber: number;
};

export type SpecDocument = {
  readonly sourcePath: string | null;
  readonly title: string;
  readonly sections: readonly SpecSection[];
  readonly sectionLookup: Readonly<Record<string, readonly SpecSection[]>>;
};

export type SpecParseContentRequest = {
  readonly content: string;
  readonly sourcePath?: string;
};

export type SpecParseFileRequest = {
  readonly path: string;
};

export type SpecValidateContentRequest = {
  readonly content: string;
  readonly sourcePath?: string;
};

export type SpecValidateFileRequest = {
  readonly path: string;
};

type MutableBodyEntry = {
  readonly kind: SpecBodyEntryKind;
  readonly lineNumber: number;
  readonly rawLines: string[];
  readonly segments: string[];
  readonly keyValue?: {
    readonly key: string;
    readonly valueSegments: string[];
  };
  readonly scenarioStep?: {
    readonly keyword: typeof SCENARIO_STEP_KEYWORDS[number];
    readonly segments: string[];
  };
  readonly task?: {
    readonly id: string | null;
    readonly marker: string;
    readonly status: SpecTaskStatus;
    readonly segments: string[];
  };
};

type MutableSection = {
  readonly name: SpecSectionName;
  readonly inlineValue: string | null;
  readonly lineNumber: number;
  readonly entries: MutableBodyEntry[];
};

type ParsedSectionHeader = {
  readonly inlineValue: string | null;
  readonly name: SpecSectionName;
};

type KeyValueParts = {
  readonly key: string;
  readonly value: string;
};

type ScenarioStepParts = {
  readonly keyword: typeof SCENARIO_STEP_KEYWORDS[number];
  readonly text: string;
};

type TaskParts = {
  readonly id: string | null;
  readonly marker: string;
  readonly status: SpecTaskStatus;
  readonly text: string;
};

export type SpecParserSyntaxErrorDetails = {
  readonly description?: string;
  readonly lineNumber?: number | null;
  readonly sourcePath?: string | null;
};

export class SpecParserReadError extends CliError {
  public constructor(path: string) {
    super(`Failed to read SpecDD spec file: ${path}`);
    this.name = 'SpecParserReadError';
  }
}

export class SpecParserSyntaxError extends CliError {
  public readonly description: string;

  public readonly lineNumber: number | null;

  public readonly sourcePath: string | null;

  public constructor(message: string, details: SpecParserSyntaxErrorDetails = {}) {
    super(message);
    this.name = 'SpecParserSyntaxError';
    this.description = details.description ?? message;
    this.lineNumber = details.lineNumber ?? null;
    this.sourcePath = details.sourcePath ?? null;
  }
}

export class SpecParserDuplicateSectionError extends SpecParserSyntaxError {
  public constructor(sectionName: string, sourcePath: string | null) {
    const description = `Duplicate SpecDD spec section "${sectionName}"`;

    super(`${description}${SpecParser.sourceSuffix(sourcePath)}.`, {
      description,
      sourcePath,
    });
    this.name = 'SpecParserDuplicateSectionError';
  }
}

export class SpecParser {
  private readonly fileSystem: FileReaderDependency;

  private readonly textDecoder = new TextDecoder();

  public constructor(fileSystem: FileReaderDependency) {
    this.fileSystem = fileSystem;
  }

  public async parseFile(request: SpecParseFileRequest): Promise<SpecDocument> {
    try {
      return this.parseContent({
        content: this.textDecoder.decode(await this.fileSystem.readFile(request.path)),
        sourcePath: request.path,
      });
    } catch (error) {
      if (error instanceof SpecParserSyntaxError) {
        throw error;
      }

      throw new SpecParserReadError(request.path);
    }
  }

  public async validateFile(request: SpecValidateFileRequest): Promise<readonly SpecParserSyntaxError[]> {
    let content: Uint8Array;

    try {
      content = await this.fileSystem.readFile(request.path);
    } catch (error) {
      throw new SpecParserReadError(request.path);
    }

    return this.validateContent({
      content: this.textDecoder.decode(content),
      sourcePath: request.path,
    });
  }

  public parseContent(request: SpecParseContentRequest): SpecDocument {
    const sourcePath = request.sourcePath ?? null;
    const sections = this.parseSections(this.normalizeLineEndings(request.content), sourcePath);
    const specSections = sections.map((section) => this.toSpecSection(section));
    const sectionLookup = this.createSectionLookup(specSections);
    const specSection = specSections[0];

    if (undefined === specSection) {
      throw this.missingSpecSectionError(sourcePath);
    }

    return {
      sectionLookup,
      sections: specSections,
      sourcePath,
      title: specSection.inlineValue as string,
    };
  }

  public validateContent(request: SpecValidateContentRequest): readonly SpecParserSyntaxError[] {
    return this.collectSyntaxErrors(this.normalizeLineEndings(request.content), request.sourcePath ?? null);
  }

  private parseSections(content: string, sourcePath: string | null): MutableSection[] {
    const sections: MutableSection[] = [];
    const seenSectionNames = new Set<SpecSectionName>();
    const seenScenarioValues = new Set<string>();
    let currentSection: MutableSection | null = null;
    let currentBodyEntry: MutableBodyEntry | null = null;
    const lines = content.split('\n');

    for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
      const line = lines[lineIndex] as string;
      const lineNumber = lineIndex + 1;
      const contentStart = this.firstNonWhitespace(line);

      if (contentStart >= line.length) {
        continue;
      }

      if ('#' === line[contentStart]) {
        continue;
      }

      this.assertValidIndentation(line, contentStart, lineNumber, sourcePath);

      const sectionHeader = this.parseSectionHeader(line, contentStart, lineNumber, sourcePath);

      if (null !== sectionHeader) {
        this.assertFirstSectionIsSpec(sectionHeader.name, sections, lineNumber, sourcePath);
        this.assertSectionCanRepeat(sectionHeader, seenSectionNames, seenScenarioValues, sourcePath);
        currentSection = {
          entries: [],
          inlineValue: sectionHeader.inlineValue,
          lineNumber,
          name: sectionHeader.name,
        };
        currentBodyEntry = null;
        sections.push(currentSection);

        continue;
      }

      this.assertNoSectionSyntaxCandidate(line, contentStart, lineNumber, sourcePath);

      if (null === currentSection) {
        throw this.syntaxError('Invalid SpecDD syntax', lineNumber, sourcePath);
      }

      if (BODYLESS_SECTIONS.has(currentSection.name)) {
        throw this.syntaxError(`Section '${currentSection.name}' does not support follow-up lines`, lineNumber, sourcePath);
      }

      if (contentStart >= CONTINUATION_INDENTATION) {
        if (null === currentBodyEntry) {
          throw this.syntaxError('Continuation line must follow a body entry in the same section', lineNumber, sourcePath);
        }

        this.addContinuation(currentBodyEntry, line, contentStart);

        continue;
      }

      if (BODY_ENTRY_INDENTATION !== contentStart) {
        throw this.syntaxError('Body entries must be indented by exactly 2 spaces', lineNumber, sourcePath);
      }

      currentBodyEntry = this.parseBodyEntry(currentSection.name, line, lineNumber, sourcePath);
      currentSection.entries.push(currentBodyEntry);
    }

    return sections;
  }

  private collectSyntaxErrors(content: string, sourcePath: string | null): readonly SpecParserSyntaxError[] {
    const diagnostics: SpecParserSyntaxError[] = [];
    const sections: MutableSection[] = [];
    const seenSectionNames = new Set<SpecSectionName>();
    const seenScenarioValues = new Set<string>();
    let currentSection: MutableSection | null = null;
    let currentBodyEntry: MutableBodyEntry | null = null;
    const lines = content.split('\n');

    for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
      const line = lines[lineIndex] as string;
      const lineNumber = lineIndex + 1;
      const contentStart = this.firstNonWhitespace(line);

      if (contentStart >= line.length) {
        continue;
      }

      if ('#' === line[contentStart]) {
        continue;
      }

      if (!this.collectSyntaxDiagnostic(diagnostics, () => {
        this.assertValidIndentation(line, contentStart, lineNumber, sourcePath);
      })) {
        continue;
      }

      let sectionHeader: ParsedSectionHeader | null = null;

      try {
        sectionHeader = this.parseSectionHeader(line, contentStart, lineNumber, sourcePath);
      } catch (error) {
        this.appendSyntaxDiagnostic(diagnostics, error);
        sectionHeader = this.recoverInvalidSectionHeader(line, contentStart);

        if (null === sectionHeader) {
          continue;
        }
      }

      if (null !== sectionHeader) {
        this.collectSyntaxDiagnostic(diagnostics, () => {
          this.assertFirstSectionIsSpec(sectionHeader.name, sections, lineNumber, sourcePath);
        });
        this.collectSyntaxDiagnostic(diagnostics, () => {
          this.assertSectionCanRepeat(sectionHeader, seenSectionNames, seenScenarioValues, sourcePath);
        });
        currentSection = {
          entries: [],
          inlineValue: sectionHeader.inlineValue,
          lineNumber,
          name: sectionHeader.name,
        };
        currentBodyEntry = null;
        sections.push(currentSection);

        continue;
      }

      if (!this.collectSyntaxDiagnostic(diagnostics, () => {
        this.assertNoSectionSyntaxCandidate(line, contentStart, lineNumber, sourcePath);
      })) {
        continue;
      }

      if (null === currentSection) {
        diagnostics.push(this.syntaxError('Invalid SpecDD syntax', lineNumber, sourcePath));

        continue;
      }

      if (BODYLESS_SECTIONS.has(currentSection.name)) {
        diagnostics.push(this.syntaxError(`Section '${currentSection.name}' does not support follow-up lines`, lineNumber, sourcePath));

        continue;
      }

      if (contentStart >= CONTINUATION_INDENTATION) {
        if (null === currentBodyEntry) {
          diagnostics.push(this.syntaxError('Continuation line must follow a body entry in the same section', lineNumber, sourcePath));

          continue;
        }

        this.addContinuation(currentBodyEntry, line, contentStart);

        continue;
      }

      if (BODY_ENTRY_INDENTATION !== contentStart) {
        diagnostics.push(this.syntaxError('Body entries must be indented by exactly 2 spaces', lineNumber, sourcePath));

        continue;
      }

      try {
        currentBodyEntry = this.parseBodyEntry(currentSection.name, line, lineNumber, sourcePath);
        currentSection.entries.push(currentBodyEntry);
      } catch (error) {
        currentBodyEntry = null;
        this.appendSyntaxDiagnostic(diagnostics, error);
      }
    }

    if (0 === sections.length) {
      diagnostics.push(this.missingSpecSectionError(sourcePath));
    }

    return diagnostics;
  }

  private recoverInvalidSectionHeader(line: string, contentStart: number): ParsedSectionHeader | null {
    if (0 !== contentStart) {
      return null;
    }

    for (const name of SPEC_SECTION_NAMES) {
      const colonOffset = contentStart + name.length;

      if (line.length <= colonOffset || ':' !== line[colonOffset] || !line.startsWith(name, contentStart)) {
        continue;
      }

      return {
        inlineValue: this.recoverInlineValue(name, line.slice(colonOffset + 1)),
        name,
      };
    }

    return null;
  }

  private recoverInlineValue(sectionName: SpecSectionName, inlineTail: string): string | null {
    const inlineValue = inlineTail.trim();

    if ('' === inlineValue) {
      return null;
    }

    if (INLINE_VALUE_SECTIONS.has(sectionName)) {
      return inlineValue;
    }

    return null;
  }

  private collectSyntaxDiagnostic(diagnostics: SpecParserSyntaxError[], callback: () => void): boolean {
    try {
      callback();

      return true;
    } catch (error) {
      this.appendSyntaxDiagnostic(diagnostics, error);

      return false;
    }
  }

  private appendSyntaxDiagnostic(diagnostics: SpecParserSyntaxError[], error: unknown): void {
    if (error instanceof SpecParserSyntaxError) {
      diagnostics.push(error);

      return;
    }

    throw error;
  }

  private normalizeLineEndings(content: string): string {
    return content.replaceAll('\r\n', '\n').replaceAll('\r', '\n');
  }

  private firstNonWhitespace(line: string): number {
    let offset = 0;

    while (offset < line.length && /\s/u.test(line[offset] as string)) {
      offset += 1;
    }

    return offset;
  }

  private assertValidIndentation(
    line: string,
    contentStart: number,
    lineNumber: number,
    sourcePath: string | null,
  ): void {
    if (0 === contentStart) {
      return;
    }

    const indentation = line.slice(0, contentStart);

    if (!/^[ ]+$/u.test(indentation) || 0 !== contentStart % INDENTATION_UNIT) {
      throw this.syntaxError('Indentation must use spaces in multiples of 2', lineNumber, sourcePath);
    }
  }

  private parseSectionHeader(
    line: string,
    contentStart: number,
    lineNumber: number,
    sourcePath: string | null,
  ): ParsedSectionHeader | null {
    for (const name of SPEC_SECTION_NAMES) {
      const colonOffset = contentStart + name.length;

      if (line.length <= colonOffset || ':' !== line[colonOffset] || !line.startsWith(name, contentStart)) {
        continue;
      }

      if (0 !== contentStart) {
        throw this.syntaxError('Section headers must start at column 0', lineNumber, sourcePath);
      }

      const inlineTail = line.slice(colonOffset + 1);
      const inlineValue = this.parseInlineValue(name, inlineTail, lineNumber, sourcePath);

      return {
        inlineValue,
        name,
      };
    }

    return null;
  }

  private parseInlineValue(
    sectionName: SpecSectionName,
    inlineTail: string,
    lineNumber: number,
    sourcePath: string | null,
  ): string | null {
    if ('' !== inlineTail && !inlineTail.startsWith(' ')) {
      throw this.syntaxError(
        `Inline value for section '${sectionName}' must be separated from ':' by a space`,
        lineNumber,
        sourcePath,
      );
    }

    const inlineValue = inlineTail.trim();

    if (!INLINE_VALUE_SECTIONS.has(sectionName) && '' !== inlineValue) {
      throw this.syntaxError(`Section '${sectionName}' does not support inline text after ':'`, lineNumber, sourcePath);
    }

    if (REQUIRED_INLINE_VALUE_SECTIONS.has(sectionName) && '' === inlineValue) {
      throw this.syntaxError(`Section '${sectionName}' requires an inline value`, lineNumber, sourcePath);
    }

    if ('' === inlineValue) {
      return null;
    }

    return inlineValue;
  }

  private assertNoSectionSyntaxCandidate(
    line: string,
    contentStart: number,
    lineNumber: number,
    sourcePath: string | null,
  ): void {
    const content = line.slice(contentStart);
    const colonOffset = content.indexOf(':');
    const label = (-1 === colonOffset ? content : content.slice(0, colonOffset)).trimEnd();

    if (!this.isSectionCandidate(label)) {
      return;
    }

    if (this.isKnownSectionName(label)) {
      throw this.syntaxError(`Section '${label}' is missing ':'`, lineNumber, sourcePath);
    }

    if (-1 !== colonOffset && 0 === contentStart) {
      throw this.syntaxError(`Unknown SpecDD section '${label}'`, lineNumber, sourcePath);
    }
  }

  private isSectionCandidate(label: string): boolean {
    return '' !== label.trim() && /^[\p{L}\s]+$/u.test(label);
  }

  private isKnownSectionName(label: string): label is SpecSectionName {
    return (SPEC_SECTION_NAMES as readonly string[]).includes(label);
  }

  private assertFirstSectionIsSpec(
    sectionName: SpecSectionName,
    sections: readonly MutableSection[],
    lineNumber: number,
    sourcePath: string | null,
  ): void {
    if (0 !== sections.length || 'Spec' === sectionName) {
      return;
    }

    throw this.syntaxError('SpecDD files should start with the Spec section', lineNumber, sourcePath);
  }

  private assertSectionCanRepeat(
    sectionHeader: ParsedSectionHeader,
    seenSectionNames: Set<SpecSectionName>,
    seenScenarioValues: Set<string>,
    sourcePath: string | null,
  ): void {
    if ('Scenario' === sectionHeader.name) {
      const scenarioName = sectionHeader.inlineValue as string;

      if (seenScenarioValues.has(scenarioName)) {
        throw new SpecParserDuplicateSectionError(`Scenario: ${scenarioName}`, sourcePath);
      }

      seenScenarioValues.add(scenarioName);

      return;
    }

    if (REPEATABLE_SECTIONS.has(sectionHeader.name)) {
      return;
    }

    if (seenSectionNames.has(sectionHeader.name)) {
      throw new SpecParserDuplicateSectionError(sectionHeader.name, sourcePath);
    }

    seenSectionNames.add(sectionHeader.name);
  }

  private parseBodyEntry(
    sectionName: SpecSectionName,
    line: string,
    lineNumber: number,
    sourcePath: string | null,
  ): MutableBodyEntry {
    const content = line.slice(BODY_ENTRY_INDENTATION);

    if ('Tasks' === sectionName) {
      return this.parseTaskEntry(content, line, lineNumber, sourcePath);
    }

    const scenarioStep = this.parseScenarioStep(content);

    if (null !== scenarioStep) {
      return {
        kind: 'scenario-step',
        lineNumber,
        rawLines: [
          line,
        ],
        scenarioStep: {
          keyword: scenarioStep.keyword,
          segments: [
            scenarioStep.text,
          ],
        },
        segments: [
          scenarioStep.text,
        ],
      };
    }

    const keyValue = this.parseKeyValue(content);

    if (null !== keyValue) {
      return {
        keyValue: {
          key: keyValue.key,
          valueSegments: [
            keyValue.value,
          ],
        },
        kind: 'key-value',
        lineNumber,
        rawLines: [
          line,
        ],
        segments: [
          keyValue.value,
        ],
      };
    }

    return {
      kind: 'text',
      lineNumber,
      rawLines: [
        line,
      ],
      segments: [
        content.trim(),
      ],
    };
  }

  private parseTaskEntry(
    content: string,
    line: string,
    lineNumber: number,
    sourcePath: string | null,
  ): MutableBodyEntry {
    const task = this.parseTask(content, lineNumber, sourcePath);

    return {
      kind: 'task',
      lineNumber,
      rawLines: [
        line,
      ],
      segments: [
        task.text,
      ],
      task: {
        id: task.id,
        marker: task.marker,
        segments: [
          task.text,
        ],
        status: task.status,
      },
    };
  }

  private parseTask(content: string, lineNumber: number, sourcePath: string | null): TaskParts {
    if (!content.startsWith('[')) {
      throw this.syntaxError('Invalid SpecDD syntax', lineNumber, sourcePath);
    }

    const markerEnd = this.findTaskMarkerEnd(content);

    if (null === markerEnd) {
      throw this.syntaxError('Invalid SpecDD syntax', lineNumber, sourcePath);
    }

    const marker = content.slice(0, markerEnd);
    const status = TASK_STATUS_BY_MARKER[marker as keyof typeof TASK_STATUS_BY_MARKER];

    if (undefined === status) {
      throw this.syntaxError(`Invalid SpecDD task state '${marker}'`, lineNumber, sourcePath);
    }

    const rawText = content.slice(markerEnd).trimStart();
    const taskIdMatch = /^#\d+/u.exec(rawText);
    const id = taskIdMatch?.[0] ?? null;
    const text = (null === id ? rawText : rawText.slice(id.length).trimStart()).trim();

    if ('' === text) {
      throw this.syntaxError('Task entries must include task text', lineNumber, sourcePath);
    }

    return {
      id,
      marker,
      status,
      text,
    };
  }

  private findTaskMarkerEnd(content: string): number | null {
    for (const marker of Object.keys(TASK_STATUS_BY_MARKER)) {
      if (content.startsWith(marker)) {
        return marker.length;
      }
    }

    let offset = 1;

    while (offset < content.length && !/\s/u.test(content[offset] as string)) {
      if (']' === content[offset]) {
        return offset + 1;
      }

      offset += 1;
    }

    return null;
  }

  private parseScenarioStep(content: string): ScenarioStepParts | null {
    for (const keyword of SCENARIO_STEP_KEYWORDS) {
      if (content === keyword) {
        return {
          keyword,
          text: '',
        };
      }

      if (content.startsWith(`${keyword} `)) {
        return {
          keyword,
          text: content.slice(keyword.length).trim(),
        };
      }
    }

    return null;
  }

  private parseKeyValue(content: string): KeyValueParts | null {
    for (let index = 0; index < content.length; index += 1) {
      if (':' !== content[index]) {
        continue;
      }

      if (0 === index || /\s/u.test(content[index - 1] as string)) {
        return null;
      }

      if (' ' !== content[index + 1]) {
        return null;
      }

      return {
        key: content.slice(0, index),
        value: content.slice(index + 2).trim(),
      };
    }

    return null;
  }

  private addContinuation(entry: MutableBodyEntry, line: string, contentStart: number): void {
    const segment = line.slice(contentStart).trim();

    entry.rawLines.push(line);

    entry.segments.push(segment);
    entry.keyValue?.valueSegments.push(segment);
    entry.scenarioStep?.segments.push(segment);
    entry.task?.segments.push(segment);
  }

  private toSpecSection(section: MutableSection): SpecSection {
    const entries = section.entries.map((entry) => this.toSpecBodyEntry(entry));

    return {
      body: entries.map((entry) => entry.text).join('\n'),
      entries,
      inlineValue: section.inlineValue,
      lineNumber: section.lineNumber,
      name: section.name,
    };
  }

  private toSpecBodyEntry(entry: MutableBodyEntry): SpecBodyEntry {
    const semanticText = this.semanticText(entry.segments);
    const keyValue = this.toKeyValue(entry);
    const scenarioStep = this.toScenarioStep(entry);
    const task = this.toTask(entry);

    return {
      ...(undefined === keyValue ? {} : {
        keyValue,
      }),
      kind: entry.kind,
      lineNumber: entry.lineNumber,
      rawLines: [
        ...entry.rawLines,
      ],
      ...(undefined === scenarioStep ? {} : {
        scenarioStep,
      }),
      ...(undefined === task ? {} : {
        task,
      }),
      text: this.entryText(entry, semanticText, keyValue, scenarioStep, task),
    };
  }

  private toKeyValue(entry: MutableBodyEntry): SpecKeyValue | undefined {
    if (undefined === entry.keyValue) {
      return undefined;
    }

    return {
      key: entry.keyValue.key,
      value: this.semanticText(entry.keyValue.valueSegments),
    };
  }

  private toScenarioStep(entry: MutableBodyEntry): SpecScenarioStep | undefined {
    if (undefined === entry.scenarioStep) {
      return undefined;
    }

    return {
      keyword: entry.scenarioStep.keyword,
      text: this.semanticText(entry.scenarioStep.segments),
    };
  }

  private toTask(entry: MutableBodyEntry): SpecTask | undefined {
    if (undefined === entry.task) {
      return undefined;
    }

    return {
      id: entry.task.id,
      marker: entry.task.marker,
      status: entry.task.status,
      text: this.semanticText(entry.task.segments),
    };
  }

  private entryText(
    entry: MutableBodyEntry,
    semanticText: string,
    keyValue: SpecKeyValue | undefined,
    scenarioStep: SpecScenarioStep | undefined,
    task: SpecTask | undefined,
  ): string {
    if ('key-value' === entry.kind && undefined !== keyValue) {
      return '' === keyValue.value ? `${keyValue.key}:` : `${keyValue.key}: ${keyValue.value}`;
    }

    if ('scenario-step' === entry.kind && undefined !== scenarioStep) {
      return '' === scenarioStep.text ? scenarioStep.keyword : `${scenarioStep.keyword} ${scenarioStep.text}`;
    }

    if ('task' === entry.kind && undefined !== task) {
      return task.text;
    }

    return semanticText;
  }

  private semanticText(segments: readonly string[]): string {
    return segments.map((segment) => segment.trim()).filter((segment) => '' !== segment).join(' ');
  }

  private createSectionLookup(sections: readonly SpecSection[]): Readonly<Record<string, readonly SpecSection[]>> {
    const lookup: Record<string, SpecSection[]> = {};

    for (const section of sections) {
      lookup[section.name] = [
        ...(lookup[section.name] ?? []),
        section,
      ];
    }

    return lookup;
  }

  private syntaxError(message: string, lineNumber: number, sourcePath: string | null): SpecParserSyntaxError {
    return new SpecParserSyntaxError(`${message} at line ${lineNumber}${SpecParser.sourceSuffix(sourcePath)}.`, {
      description: message,
      lineNumber,
      sourcePath,
    });
  }

  private missingSpecSectionError(sourcePath: string | null): SpecParserSyntaxError {
    const description = 'SpecDD spec must contain a Spec section';

    return new SpecParserSyntaxError(`${description}${SpecParser.sourceSuffix(sourcePath)}.`, {
      description,
      sourcePath,
    });
  }

  public static sourceSuffix(sourcePath: string | null): string {
    if (null === sourcePath) {
      return '';
    }

    return ` in ${sourcePath}`;
  }
}
