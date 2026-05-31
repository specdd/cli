import { posix } from 'node:path';

export type SpecDirectoryContextPlacement = 'local' | 'parent';

export type SpecDirectoryContextMatch = {
  readonly directoryPath: string;
  readonly placement: SpecDirectoryContextPlacement;
  readonly specPath: string;
};

export type SpecDirectoryContextAmbiguity = {
  readonly directoryPath: string;
  readonly placement: SpecDirectoryContextPlacement;
  readonly specPaths: readonly string[];
};

export type SpecDirectoryContextMatchRequest = {
  readonly directoryPaths: readonly string[];
  readonly rootDirectoryName: string;
  readonly specPaths: readonly string[];
};

export type SpecDirectoryContextMatchResult = {
  readonly ambiguities: readonly SpecDirectoryContextAmbiguity[];
  readonly matches: readonly SpecDirectoryContextMatch[];
};

type SpecCandidate = {
  readonly basename: string;
  readonly path: string;
};

export class SpecDirectoryContext {
  public match(request: SpecDirectoryContextMatchRequest): SpecDirectoryContextMatchResult {
    const specsByDirectoryPath = this.groupSpecCandidatesByDirectoryPath(request.specPaths);
    const matches: SpecDirectoryContextMatch[] = [];
    const ambiguities: SpecDirectoryContextAmbiguity[] = [];

    for (const directoryPath of this.uniqueSortedPaths(request.directoryPaths)) {
      const directoryBasename = this.directoryBasename(request.rootDirectoryName, directoryPath);

      if ('.' !== directoryPath) {
        const parentMatch = this.matchPlacement(
          directoryPath,
          'parent',
          directoryBasename,
          specsByDirectoryPath.get(posix.dirname(directoryPath)) ?? [],
        );

        this.collectPlacementResult(parentMatch, matches, ambiguities);
      }

      const localMatch = this.matchPlacement(
        directoryPath,
        'local',
        directoryBasename,
        specsByDirectoryPath.get(directoryPath) ?? [],
      );

      this.collectPlacementResult(localMatch, matches, ambiguities);
    }

    return {
      ambiguities,
      matches,
    };
  }

  private groupSpecCandidatesByDirectoryPath(specPaths: readonly string[]): ReadonlyMap<string, readonly SpecCandidate[]> {
    const specsByDirectoryPath = new Map<string, SpecCandidate[]>();

    for (const specPath of this.uniqueSortedPaths(specPaths)) {
      const directoryPath = posix.dirname(specPath);
      const candidates = specsByDirectoryPath.get(directoryPath) ?? [];

      candidates.push({
        basename: this.specBasename(specPath),
        path: specPath,
      });
      specsByDirectoryPath.set(directoryPath, candidates);
    }

    return specsByDirectoryPath;
  }

  private matchPlacement(
    directoryPath: string,
    placement: SpecDirectoryContextPlacement,
    directoryBasename: string,
    candidates: readonly SpecCandidate[],
  ): SpecDirectoryContextMatch | SpecDirectoryContextAmbiguity | null {
    const exactMatch = candidates.find((candidate) => candidate.basename === directoryBasename);

    if (undefined !== exactMatch) {
      return {
        directoryPath,
        placement,
        specPath: exactMatch.path,
      };
    }

    const lowercaseMatches = candidates.filter((candidate) => (
      candidate.basename.toLowerCase() === directoryBasename.toLowerCase()
    ));

    if (1 < lowercaseMatches.length) {
      return {
        directoryPath,
        placement,
        specPaths: lowercaseMatches.map((candidate) => candidate.path),
      };
    }

    const lowercaseMatch = lowercaseMatches[0];

    if (undefined === lowercaseMatch) {
      return null;
    }

    return {
      directoryPath,
      placement,
      specPath: lowercaseMatch.path,
    };
  }

  private collectPlacementResult(
    result: SpecDirectoryContextMatch | SpecDirectoryContextAmbiguity | null,
    matches: SpecDirectoryContextMatch[],
    ambiguities: SpecDirectoryContextAmbiguity[],
  ): void {
    if (null === result) {
      return;
    }

    if ('specPath' in result) {
      matches.push(result);

      return;
    }

    ambiguities.push(result);
  }

  private directoryBasename(rootDirectoryName: string, directoryPath: string): string {
    if ('.' === directoryPath) {
      return rootDirectoryName;
    }

    return posix.basename(directoryPath);
  }

  private specBasename(specPath: string): string {
    return posix.basename(specPath).slice(0, -'.sdd'.length);
  }

  private uniqueSortedPaths(paths: readonly string[]): readonly string[] {
    return [
      ...new Set(paths),
    ].sort((left, right) => {
      const depthDifference = this.pathDepth(left) - this.pathDepth(right);

      if (0 !== depthDifference) {
        return depthDifference;
      }

      return left.localeCompare(right);
    });
  }

  private pathDepth(path: string): number {
    if ('.' === path) {
      return 0;
    }

    return path.split('/').length;
  }
}
