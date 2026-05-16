import { CliError } from '../../cli-error.js';
import {
  SPECDD_LEADING_V_VERSION_PATTERN,
  SPECDD_VERSION_PART_SEPARATOR,
  SPECDD_VERSION_PATTERN,
} from '../../constants.js';

export class SpecDDInvalidVersionError extends CliError {
  public constructor(version: string, suggestion: string | null = null) {
    if (null !== suggestion) {
      super(`Invalid SpecDD version: ${version}. Did you mean ${suggestion}?`);
      this.name = 'SpecDDInvalidVersionError';

      return;
    }

    super(`Invalid SpecDD version: ${version}`);
    this.name = 'SpecDDInvalidVersionError';
  }
}

export class SpecDDVersion {
  public isValid(version: string): boolean {
    return SPECDD_VERSION_PATTERN.test(version);
  }

  public suggest(version: string): string | null {
    const suggestionMatch = SPECDD_LEADING_V_VERSION_PATTERN.exec(version.trim());

    if (null === suggestionMatch) {
      return null;
    }

    return suggestionMatch[1] as string;
  }

  public validate(version: string): void {
    if (this.isValid(version)) {
      return;
    }

    throw new SpecDDInvalidVersionError(version, this.suggest(version));
  }

  public compare(leftVersion: string, rightVersion: string): number {
    this.validate(leftVersion);
    this.validate(rightVersion);

    const leftParts = this.parse(leftVersion);
    const rightParts = this.parse(rightVersion);
    const partCount = Math.max(leftParts.length, rightParts.length);

    for (let index = 0; index < partCount; index += 1) {
      const leftPart = leftParts[index] ?? 0;
      const rightPart = rightParts[index] ?? 0;

      if (leftPart > rightPart) {
        return 1;
      }

      if (leftPart < rightPart) {
        return -1;
      }
    }

    return 0;
  }

  private parse(version: string): number[] {
    return version.split(SPECDD_VERSION_PART_SEPARATOR).map((part) => Number(part));
  }
}
