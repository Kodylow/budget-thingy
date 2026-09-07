const base = import.meta.env.BASE_URL;

export default function Slide11() {
  return (
    <div className="w-screen h-screen overflow-hidden relative walkthrough-slide">
      <header className="walkthrough-header">
        <h2 className="walkthrough-title">Use additional reporting and admin tools</h2>
        <div className="walkthrough-rule"></div>
      </header>
      <div className="walkthrough-content">
        <ul className="walkthrough-list">
          <li><p>Custom Reports is available only to authorized roles</p></li>
          <li><p>Choose permitted funding teams and the reporting dates you need</p></li>
          <li><p>Annual remaining belongs to the budget period, not a short selected range</p></li>
          <li><p>Email activity lets authorized administrators review alert activity</p></li>
          <li><p>Org Insights requires account-usage permission</p></li>
        </ul>
        <figure className="walkthrough-figure">
          <div className="walkthrough-image-frame">
            <img className="walkthrough-image" src={`${base}walkthrough/slide11.png`} crossOrigin="anonymous" alt="Annotated Custom Reports and administration tools" />
          </div>
          <figcaption className="walkthrough-caption"><span className="walkthrough-callouts">1 Funding teams · 2 Report dates</span>Sample data</figcaption>
        </figure>
      </div>
    </div>
  );
}