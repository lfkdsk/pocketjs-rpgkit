// Stable relative paths for assertions and logs across POSIX and Windows.
export function snapshotPath(path) {
  return path.replace(/\\/g, "/");
}
