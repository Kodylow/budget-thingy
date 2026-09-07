const base = import.meta.env.BASE_URL;

export default function Slide05() {
  return (
    <div className="w-screen h-screen overflow-hidden relative walkthrough-slide">
      <header className="walkthrough-header">
        <h2 className="walkthrough-title">Find your projects—including those without spend</h2>
        <div className="walkthrough-rule"></div>
      </header>
      <div className="walkthrough-content">
        <ul className="walkthrough-list">
          <li><p>Open My Projects from the navigation</p></li>
          <li><p>Search, sort, and page through your current self-owned projects</p></li>
          <li><p>Published describes current deployment status</p></li>
          <li><p>Projects without spending still belong in the inventory</p></li>
          <li><p>Reporting dates change spending amounts, not catalog membership</p></li>
        </ul>
        <figure className="walkthrough-figure">
          <div className="walkthrough-image-frame">
            <img className="walkthrough-image" src={`${base}walkthrough/slide05.png`} crossOrigin="anonymous" alt="Annotated My Projects inventory and search controls" />
          </div>
          <figcaption className="walkthrough-caption"><span className="walkthrough-callouts">1 Search current projects · 2 Published status</span>Sample data</figcaption>
        </figure>
      </div>
    </div>
  );
}