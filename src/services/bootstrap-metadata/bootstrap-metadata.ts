import { join } from 'node:path';
import { CliError } from '../../cli-error.js';
import {
  SPECDD_BOOTSTRAP_PATH,
  SPECDD_FRONT_MATTER_DELIMITER,
} from '../../constants.js';
import type {
  FileExistenceDependency,
  FileReaderDependency,
} from '../../infrastructure/file-system.js';

const FRONT_MATTER_FIELD_PATTERNS = {
  Changelog: /^Changelog:\s*(.+?)\s*$/i,
  Version: /^Version:\s*(.+?)\s*$/i,
};

type BootstrapMetadataField = keyof typeof FRONT_MATTER_FIELD_PATTERNS;

type BootstrapMetadataFileSystemDependency = FileExistenceDependency & FileReaderDependency;

export class BootstrapMetadataError extends CliError {
  public constructor(message: string) {
    super(message);
    this.name = 'BootstrapMetadataError';
  }
}

export class BootstrapMetadataMissingFieldError extends BootstrapMetadataError {
  public constructor(bootstrapPath: string, field: BootstrapMetadataField) {
    super(`SpecDD bootstrap ${field} front matter is missing: ${bootstrapPath}`);
    this.name = 'BootstrapMetadataMissingFieldError';
  }
}

export class BootstrapMetadata {
  private readonly fileSystem: BootstrapMetadataFileSystemDependency;

  private readonly textDecoder = new TextDecoder();

  public constructor(fileSystem: BootstrapMetadataFileSystemDependency) {
    this.fileSystem = fileSystem;
  }

  public async hasBootstrap(targetDirectoryPath: string): Promise<boolean> {
    try {
      return await this.fileSystem.exists(this.bootstrapPath(targetDirectoryPath));
    } catch (error) {
      throw new BootstrapMetadataError(String(error));
    }
  }

  public async readVersion(targetDirectoryPath: string): Promise<string> {
    return this.readField(targetDirectoryPath, 'Version');
  }

  public async readChangelog(targetDirectoryPath: string): Promise<string> {
    return this.readField(targetDirectoryPath, 'Changelog');
  }

  private async readField(targetDirectoryPath: string, field: BootstrapMetadataField): Promise<string> {
    const bootstrapPath = this.bootstrapPath(targetDirectoryPath);

    try {
      const bootstrapContent = this.textDecoder.decode(await this.fileSystem.readFile(bootstrapPath));

      return this.extractFrontMatterValue(bootstrapPath, bootstrapContent, field);
    } catch (error) {
      if (error instanceof BootstrapMetadataError) {
        throw error;
      }

      throw new BootstrapMetadataError(String(error));
    }
  }

  private bootstrapPath(targetDirectoryPath: string): string {
    return join(targetDirectoryPath, SPECDD_BOOTSTRAP_PATH);
  }

  private extractFrontMatterValue(
    bootstrapPath: string,
    bootstrapContent: string,
    field: BootstrapMetadataField,
  ): string {
    const lines = bootstrapContent.split(/\r?\n/);

    if (SPECDD_FRONT_MATTER_DELIMITER !== lines[0]?.trim()) {
      throw new BootstrapMetadataMissingFieldError(bootstrapPath, field);
    }

    for (const line of lines.slice(1)) {
      const trimmedLine = line.trim();

      if (SPECDD_FRONT_MATTER_DELIMITER === trimmedLine) {
        break;
      }

      const fieldMatch = FRONT_MATTER_FIELD_PATTERNS[field].exec(trimmedLine);

      if (null !== fieldMatch) {
        return this.cleanFrontMatterValue(fieldMatch[1] as string);
      }
    }

    throw new BootstrapMetadataMissingFieldError(bootstrapPath, field);
  }

  private cleanFrontMatterValue(value: string): string {
    const trimmedValue = value.trim();

    if (this.isQuoted(trimmedValue, '"')) {
      return trimmedValue.slice(1, -1).trim();
    }

    if (this.isQuoted(trimmedValue, "'")) {
      return trimmedValue.slice(1, -1).trim();
    }

    return trimmedValue;
  }

  private isQuoted(value: string, quote: string): boolean {
    return value.startsWith(quote) && value.endsWith(quote);
  }
}
