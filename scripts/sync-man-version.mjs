import { readFileSync, writeFileSync } from 'node:fs';

const checkOnly = process.argv.includes('--check');
const packageJsonPath = new URL('../package.json', import.meta.url);
const manPagePath = new URL('../man/specdd.1', import.meta.url);
const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
const manPage = readFileSync(manPagePath, 'utf8');
const headerPattern = /^(\.TH SPECDD 1 "[^"]+" ")specdd ([^"]+)(" "SpecDD CLI Manual")$/mu;
const match = headerPattern.exec(manPage);

if (null === match) {
  throw new Error('man/specdd.1 must start with a supported .TH header');
}

if ('./man/specdd.1' !== packageJson.man) {
  throw new Error('package.json man field must point to ./man/specdd.1');
}

if (!Array.isArray(packageJson.files) || !packageJson.files.includes('man')) {
  throw new Error('package.json files must include man');
}

const expectedVersion = packageJson.version;
const currentVersion = match[2];

if (expectedVersion === currentVersion) {
  process.exit(0);
}

if (checkOnly) {
  throw new Error(`man/specdd.1 version ${currentVersion} does not match package.json version ${expectedVersion}`);
}

writeFileSync(
  manPagePath,
  manPage.replace(headerPattern, `$1specdd ${expectedVersion}$3`),
);
