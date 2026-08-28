/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useState } from 'react';
import App from './App';
import RacingGame from './game/ui/RacingGame';

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
      <>
        <App />
        <a
          href="#"
          className="fixed bottom-4 left-4 z-50 rounded-full border border-white/20 bg-black/70 px-4 py-2 text-xs font-semibold tracking-wide text-white/80 backdrop-blur-md hover:text-white"
        >
          ← Horizon Rush
        </a>
      </>
    );
  }

  return <RacingGame />;
};

export default Root;
