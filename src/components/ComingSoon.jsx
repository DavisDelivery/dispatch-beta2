// Shared stub for routes that are not built yet (Dashboard / Workbench / Loads).
export default function ComingSoon({ title }) {
  return (
    <section className="page page--stub">
      <h1 className="page__title">{title}</h1>
      <p className="stub__badge">coming next</p>
    </section>
  )
}
