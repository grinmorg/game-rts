import { createRoot } from 'react-dom/client';
import { App } from './ui/App';
import { primeAudio } from './game/audio';
import './styles.css';

primeAudio();
createRoot(document.getElementById('root')!).render(<App />);
