/**
 * Entry for the single-file artifact build: the game only, mounted without
 * StrictMode (its dev-mode double-mount would generate the whole world and a
 * WebGL context twice), and without the hash router or simulator app.
 */
import { createRoot } from 'react-dom/client';
import RacingGame from './game/ui/RacingGame';
import './index.css';

createRoot(document.getElementById('root')!).render(<RacingGame />);
