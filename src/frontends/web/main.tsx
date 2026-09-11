import {StrictMode, useEffect, useState} from 'react';
import {createRoot} from 'react-dom/client';

import type {GatewayHealth} from '../../gateway/api/index.ts';
import {createGatewayClient} from '../../gateway/client/index.ts';

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function App() {
  const [health, setHealth] = useState<GatewayHealth | undefined>();
  const [problem, setProblem] = useState<string | undefined>();

  useEffect(() => {
    try {
      void createGatewayClient({url: location.href})
        .health()
        .then(setHealth, (error: unknown) => {
          setProblem(describe(error));
        });
    } catch (error: unknown) {
      setProblem(describe(error));
    }
  }, []);

  if (problem !== undefined) {
    return <p role="alert">{problem}</p>;
  }

  if (health === undefined) {
    return <p>Connecting…</p>;
  }

  return (
    <ul>
      {health.characters.map(character => (
        <li key={character.id}>
          {character.displayName} · {character.state}
        </li>
      ))}
    </ul>
  );
}

const root = document.getElementById('root');

if (root === null) {
  throw new Error('The page has no root element.');
}

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
