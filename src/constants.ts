export const SPECDD_DIRECTORY_PATH = '.specdd';
export const SPECDD_BOOTSTRAP_FILE_NAME = 'bootstrap.md';
export const SPECDD_LOCAL_BOOTSTRAP_FILE_NAME = 'bootstrap.local.md';
export const SPECDD_GITIGNORE_FILE_NAME = '.gitignore';
export const SPECDD_BOOTSTRAP_PATH = `${SPECDD_DIRECTORY_PATH}/${SPECDD_BOOTSTRAP_FILE_NAME}`;
export const SPECDD_GITIGNORE_PATH = `${SPECDD_DIRECTORY_PATH}/${SPECDD_GITIGNORE_FILE_NAME}`;
export const SPECDD_LOCAL_BOOTSTRAP_GITIGNORE_CONTENT = `${SPECDD_LOCAL_BOOTSTRAP_FILE_NAME}\n`;

export const SPECDD_HOMEPAGE_URL = 'https://specdd.ai';
export const SPECDD_CHANGELOG_URL = 'https://specdd.ai/changelog/';
export const SPECDD_CLI_HELP_URL = 'https://github.com/specdd/cli';
export const SPECDD_GITHUB_RELEASE_BASE_URL = 'https://api.github.com/repos/specdd/specdd/releases';

export const SPECDD_DISTRIBUTION_ASSET_NAME = 'specdd.zip';
export const SPECDD_SIGNATURE_ASSET_NAME = 'specdd.zip.asc';

export const SPECDD_COPYRIGHT_NOTICE = 'Copyright (c) 2026 Matīss Treinis and SpecDD contributors';
export const CLI_HELP_FOOTER = `\n${SPECDD_COPYRIGHT_NOTICE}\nSpec help: ${SPECDD_HOMEPAGE_URL}\nCLI help: ${SPECDD_CLI_HELP_URL}`;

export const SPECDD_VERSION_PATTERN = /^\d+\.\d+(?:\.\d+)?$/;
export const SPECDD_LEADING_V_VERSION_PATTERN = /^[vV](\d+\.\d+(?:\.\d+)?)$/;
export const SPECDD_VERSION_PART_SEPARATOR = '.';
export const SPECDD_FRONT_MATTER_DELIMITER = '---';
