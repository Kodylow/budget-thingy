const base = import.meta.env.BASE_URL;

export default function Slide06() {
  return (
    <div className="w-screen h-screen overflow-hidden relative walkthrough-slide">
      <header className="walkthrough-header">
        <h2 className="walkthrough-title">Investigate spending without double-counting</h2>
        <div className="walkthrough-rule"></div>
      </header>
      <div className="walkthrough-content">
        <ul className="walkthrough-list">
          <li><p>Open Spend and choose an available detail view</p></li>
          <li><p>Narrow the authorized scope with search and filters</p></li>
          <li><p>Open a group or member to investigate supporting detail</p></li>
          <li><p>Project-attributed amounts explain activity; do not add them to workspace or member totals</p></li>
        </ul>
        <figure className="walkthrough-figure">
          <div className="walkthrough-image-frame">
            <img className="walkthrough-image" src={`${base}walkthrough/slide06.png`} crossOrigin="anonymous" alt="Annotated Spend detail view with scope filters" />
          </div>
          <figcaption className="walkthrough-caption"><span className="walkthrough-callouts">1 Detail view · 2 Scope and filters · 3 Group detail</span>Sample data</figcaption>
        </figure>
      </div>
    </div>
  );
}