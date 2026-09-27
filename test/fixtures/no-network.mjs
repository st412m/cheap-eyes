// Preloaded (node --import) into every server process the tests spawn: any fetch fails.
globalThis.fetch = async (url) => {
  throw new TypeError(`network is disabled in tests: ${url}`);
};
