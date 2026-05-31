import { SpecDirectoryContext } from './spec-directory-context.js';

describe('SpecDirectoryContext', () => {
  it('matches parent-held and local directory specs as cumulative context', () => {
    const context = new SpecDirectoryContext();

    expect(context.match({
      directoryPaths: [
        '.',
        'foo',
        'foo/bar',
      ],
      rootDirectoryName: 'project',
      specPaths: [
        'foo/bar.sdd',
        'foo/bar/bar.sdd',
        'foo/bar/helper.sdd',
      ],
    })).toEqual({
      ambiguities: [],
      matches: [
        {
          directoryPath: 'foo/bar',
          placement: 'parent',
          specPath: 'foo/bar.sdd',
        },
        {
          directoryPath: 'foo/bar',
          placement: 'local',
          specPath: 'foo/bar/bar.sdd',
        },
      ],
    });
  });

  it('prefers exact matches independently for parent-held and local placements', () => {
    const context = new SpecDirectoryContext();

    expect(context.match({
      directoryPaths: [
        'Billing',
      ],
      rootDirectoryName: 'project',
      specPaths: [
        'billing.sdd',
        'Billing.sdd',
        'Billing/billing.sdd',
        'Billing/Billing.sdd',
      ],
    })).toEqual({
      ambiguities: [],
      matches: [
        {
          directoryPath: 'Billing',
          placement: 'parent',
          specPath: 'Billing.sdd',
        },
        {
          directoryPath: 'Billing',
          placement: 'local',
          specPath: 'Billing/Billing.sdd',
        },
      ],
    });
  });

  it('reports lowercase ambiguity separately by placement', () => {
    const context = new SpecDirectoryContext();

    expect(context.match({
      directoryPaths: [
        'Billing',
      ],
      rootDirectoryName: 'project',
      specPaths: [
        'billing.sdd',
        'BILLING.sdd',
        'Billing/billing.sdd',
        'Billing/BILLING.sdd',
      ],
    })).toEqual({
      ambiguities: [
        {
          directoryPath: 'Billing',
          placement: 'parent',
          specPaths: [
            'billing.sdd',
            'BILLING.sdd',
          ],
        },
        {
          directoryPath: 'Billing',
          placement: 'local',
          specPaths: [
            'Billing/billing.sdd',
            'Billing/BILLING.sdd',
          ],
        },
      ],
      matches: [],
    });
  });
});
