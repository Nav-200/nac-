/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { lazy, Suspense, useEffect, useState } from 'react';

// Both routes are heavyweight (the game pulls three.js, the simulator is a
// 2,400-line app of its own), so each loads only when its hash is active.
const App = lazy(() => import('./App'));
const RacingGame = lazy(() => import('./game/ui/RacingGame'));

const SIMULATOR_HASH = '#simulator';

const readRoute = (): 'game' | 'simulator' =>
  window.location.hash === SIMULATOR_HASH ? 'simulator' : 'game';

/**
 * Two apps share this project: the racing game (default) and the original
 * navQtracker hardware simulator at `#simulator`. A hash check is all the
 * routing either of them needs.
 */
export const Root: React.FC = () => {
  const [route, setRoute] = useState<'game' | 'simulator'>(readRoute);

  useEffect(() => {
    const onHashChange = () => setRoute(readRoute());
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  if (route === 'simulator') {
    return (
      <Suspense fallback={<RouteLoading />}>
        <App />
        <a
          href="#"
          className="fixed bottom-4 left-4 z-50 rounded-full border border-white/20 bg-black/70 px-4 py-2 text-xs font-semibold tracking-wide text-white/80 backdrop-blur-md hover:text-white"
        >
          ← Horizon Rush
        </a>
      </Suspense>
    );
  }

  return (
    <Suspense fallback={<RouteLoading />}>
      <RacingGame />
    </Suspense>
  );
};

const RouteLoading: React.FC = () => (
  <div className="fixed inset-0 flex items-center justify-center bg-[#070b12]">
    <div className="h-1 w-40 overflow-hidden rounded-full bg-white/10">
      <div className="h-full w-1/3 animate-pulse rounded-full bg-cyan-400" />
    </div>
  </div>
);

export default Root;
