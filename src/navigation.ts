export type CueRoute = '/landing' | '/app';

export function getCurrentRoute(): CueRoute {
  if (window.location.pathname === '/app') return '/app';
  if (window.location.pathname === '/landing') return '/landing';
  window.history.replaceState(null, '', '/landing');
  return '/landing';
}

export function navigateTo(route: CueRoute) {
  if (window.location.pathname === route) return;
  window.history.pushState(null, '', route);
  window.dispatchEvent(new PopStateEvent('popstate'));
}
