const base = import.meta.env.BASE_URL;

export default function Slide04() {
  return (
    <div className="w-screen h-screen overflow-hidden relative walkthrough-slide">
      <header className="walkthrough-header">
        <h2 className="walkthrough-title">Choose the right reporting period</h2>
        <div className="walkthrough-rule"></div>
      </header>
      <div className="walkthrough-content">
        <ul className="walkthrough-list">
          <li><p>Full period is the default reporting range</p></li>
          <li><p>Start and end dates are inclusive</p></li>
          <li><p>The contract runs from May 20, 2026 to May 20, 2027</p></li>
          <li><p>Reporting dates do not change the billing cycle or monthly Agent limit</p></li>
          <li><p>A forecast is an estimate, not additional recorded spending</p></li>
        </ul>
        <figure className="walkthrough-figure">
          <div className="walkthrough-image-frame">
            <img className="walkthrough-image" src={`${base}walkthrough/slide04.png`} crossOrigin="anonymous" alt="Annotated reporting period and date controls" />
          </div>
          <figcaption className="walkthrough-caption"><span className="walkthrough-callouts">1 Reporting period · 2 Inclusive start · 3 Inclusive end</span>Sample data</figcaption>
        </figure>
      </div>
    </div>
  );
}