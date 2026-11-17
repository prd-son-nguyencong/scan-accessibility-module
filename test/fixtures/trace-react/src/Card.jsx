export default function Card({ title }) {
  const re = /<div>/g; // a regex, not JSX
  return <section className="card">
    <h2>{title}</h2>
    <a href="/apply">Apply</a>
  </section>;
}
