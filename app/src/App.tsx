import { useEffect, useState } from 'react';
import { resumeItem } from './lib/api';
import { getQueue } from './lib/store';
import type { Screen } from './lib/types';
import { Camera } from './pages/Camera';
import { Home } from './pages/Home';
import { Memo } from './pages/Memo';
import { Queue } from './pages/Queue';
import { Settings } from './pages/Settings';

export function App() {
  const [screen, setScreen] = useState<Screen>('home');
  const [tick, setTick] = useState(0);

  useEffect(() => {
    void (async () => {
      const q = await getQueue();
      for (const item of q) {
        if (item.status === 'sent' || item.status === 'queued') await resumeItem(item);
      }
    })();
  }, []);

  function go(s: Screen) {
    setScreen(s);
    setTick(n => n + 1);
  }

  if (screen === 'memo') return <Memo go={go} />;
  if (screen === 'camera') return <Camera go={go} />;
  if (screen === 'settings') return <Settings go={go} />;
  if (screen === 'queue') return <Queue go={go} />;
  return <Home key={tick} go={go} />;
}
