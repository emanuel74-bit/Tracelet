/**
 * Mount/base path normalisation shared by the mounts, the dispatcher and the static assets.
 * Accepts an absolute path such as '/observe' or '/internal/observe/' and returns it without a trailing slash.
 * The root ('/') is refused: the dashboard must not shadow the host application.
 */
const SEGMENT = /^[A-Za-z0-9._~-]+$/;

export function normalizeBasePath(path: string): string {
  if (typeof path !== 'string' || !path.startsWith('/')) throw new Error('Tracelet path must be an absolute path starting with "/"');
  const segments = path.split('/').filter((s, i, a) => !(s === '' && i === a.length - 1));
  // segments[0] is '' (leading slash)
  const parts = segments.slice(1);
  if (parts.length === 0) throw new Error('Tracelet path must not be the root "/"');
  for (const part of parts) {
    if (!SEGMENT.test(part) || part === '.' || part === '..') throw new Error('Tracelet path may only contain the characters A-Z a-z 0-9 . _ ~ - and "/" and must not contain empty, "." or ".." segments');
  }
  return '/' + parts.join('/');
}
