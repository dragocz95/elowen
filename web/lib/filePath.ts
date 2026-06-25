// Path-display helpers shared by the file-change rows (task changes + timeline "most active files").
// Split a repo-relative path into a muted directory prefix and an emphasized file name.

/** The file name — the segment after the last slash (the whole path when there's no slash). */
export const baseName = (p: string): string => p.split('/').pop() ?? p;

/** The directory prefix including its trailing slash, or '' when the path has no directory. */
export const dirName = (p: string): string => {
  const i = p.lastIndexOf('/');
  return i >= 0 ? p.slice(0, i + 1) : '';
};
