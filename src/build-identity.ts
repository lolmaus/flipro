// The build replaces the compiled module with immutable package/source values.
// Keeping a source fallback lets dev, tests, and type checks run before any build.
export const buildIdentity = Object.freeze({
  name: 'flipro',
  version: 'unbuilt',
  revision: 'unknown',
});
