// OpenRouter model id rules that do not depend on live data.

// Variant suffixes refused in any position (`vendor/model:online`, `...:free:nitro`).
// :online adds web search through a plugin; :nitro/:floor may bill at priority or
// flex rates the ZDR price list does not show; :exacto re-sorts providers;
// :thinking/:extended are deprecated. :free passes, the ZDR check decides.
export const REFUSED_SUFFIXES = ['online', 'nitro', 'floor', 'exacto', 'thinking', 'extended'];

// Returns the first refused suffix of `id` (without the colon), or null.
export function refusedSuffix(id) {
  const [, ...suffixes] = String(id).toLowerCase().split(':');
  return suffixes.find((s) => REFUSED_SUFFIXES.includes(s)) ?? null;
}

export function refusedSuffixMessage(suffix) {
  return `the ":${suffix}" model variant is refused`;
}
