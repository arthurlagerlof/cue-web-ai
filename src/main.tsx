import { lazy, Suspense, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import Landing from './Landing';
import { getCurrentRoute } from './navigation';
import './style.css';

const App = lazy(() => import('./App'));

function Router() {
  const [route, setRoute] = useState(() => {
    const currentRoute = getCurrentRoute();
    if (window.location.pathname !== currentRoute) window.history.replaceState(null, '', currentRoute);
    return currentRoute;
  });

  useEffect(() => {
    const updateRoute = () => setRoute(getCurrentRoute());
    window.addEventListener('popstate', updateRoute);
    return () => window.removeEventListener('popstate', updateRoute);
  }, []);

  return route === '/app'
    ? <Suspense fallback={<main><p>Loading Cue…</p></main>}><App /></Suspense>
    : <Landing />;
}

createRoot(document.getElementById('root')!).render(<Router />);
