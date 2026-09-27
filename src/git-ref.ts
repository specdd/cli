export const isValidGitRef = (ref: string): boolean => {
  return '' !== ref && !ref.startsWith('-') && !/[\s\x00-\x1f\x7f~^:?*\[\\]/.test(ref)
    && !ref.includes('..') && !ref.includes('@{') && !ref.includes('//')
    && !ref.endsWith('/') && !ref.endsWith('.');
};
