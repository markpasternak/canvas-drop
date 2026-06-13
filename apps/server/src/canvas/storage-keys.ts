/**
 * Storage key layout for canvas version assets. A version's files live under a
 * version-scoped prefix so the atomic pointer swap (U18) and pruning never touch
 * the live version's bytes. Shared by serving (U17) and the deploy engine (U18).
 */
export function versionPrefix(versionId: string): string {
  return `versions/${versionId}/`;
}

export function versionStorageKey(versionId: string, path: string): string {
  return versionPrefix(versionId) + path;
}
