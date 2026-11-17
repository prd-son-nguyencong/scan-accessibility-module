import { useState } from 'react';
import Card from './Card.jsx';

// Don't treat <b> in a comment as JSX
export default function App({ items }) {
  const [n, setN] = useState(0);
  const big = n > 3 && n < 10;
  const label = `Count: ${n < 5 ? 'few' : 'many'}`;
  return (
    <main className="app">
      <h1 id="title">Careers {label}</h1>
      <img src="/hero.png" alt="" />
      {items.map((i) => (
        <Card key={i} title={i} />
      ))}
      <button type="button" onClick={() => setN(n + 1)}>
        Don't click <>fragment</>
      </button>
      <p {...{ className: 'x' }}>{big ? <span>big</span> : null}</p>
    </main>
  );
}
