// A reactive stand-in for SvelteKit's `$app/state` `page` store, scoped to
// the route tests. The route derives the active vault + open document from
// `page.url`, so the tests need a `page` whose `url` updates on every
// navigation (a `goto`, a history pop) and re-runs the component's
// `$derived`s — exactly what the real SvelteKit runtime does. A plain
// object wouldn't be reactive; this `$state`-backed module is, so flipping
// the URL drives the page the same way a real navigation would.
let url = $state(new URL('http://localhost/'));

export const page = {
  get url() {
    return url;
  },
};

// Point the mock `page` at a new pathname, mirroring a navigation landing.
// The test's `goto` mock and history-navigation helper both call this so
// the URL is the single source of truth in tests too.
export function setPageUrl(pathname: string): void {
  url = new URL(pathname, 'http://localhost/');
}
