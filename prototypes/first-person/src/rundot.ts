// The RUN.world SDK, for RUN builds only (VITE_RUNDOT, set by `npm run build:run`).
//
// The SDK is vendored beside index.html (scripts/vendor-rundot.mjs), not bundled: builds with it bundled hang at
// "Processing game file" on deploy. This imports it from the same URL as its <script> tag, so it is the same,
// already initialising, module instance. Typed loosely on purpose: callers declare the slice they use.

let sdk: Promise<any> | null = null;

/** RundotGameAPI, or null when this is not a RUN.world build or the SDK failed to load. */
export function loadRundot(): Promise<any> {
  if (!import.meta.env.VITE_RUNDOT) return Promise.resolve(null);
  sdk ??= import(/* @vite-ignore */ new URL('vendor/rundot-sdk/rundot-game-api/index.js', document.baseURI).href).then(
    (m) => m.default,
    (err) => {
      console.warn('[rundot] SDK failed to load', err);
      return null;
    },
  );
  return sdk;
}
