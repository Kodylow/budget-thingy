const base = import.meta.env.BASE_URL;

export default function Slide12() {
  return (
    <div className="w-screen h-screen overflow-hidden relative walkthrough-slide">
      <header className="walkthrough-header">
        <h2 className="walkthrough-title">When a number or access check looks wrong</h2>
        <div className="walkthrough-rule"></div>
      </header>
      <div className="walkthrough-content">
        <ul className="walkthrough-list">
          <li><p>Check your scope and reporting dates first</p></li>
          <li><p>Unavailable means unknown—not zero</p></li>
          <li><p>Use Reconnect after a temporary access-check failure</p></li>
          <li><p>Administrators can open Account menu → Data quality for detailed notes</p></li>
          <li><p>Use Help for the walkthrough; contact your administrator for missing permissions</p></li>
        </ul>
        <figure className="walkthrough-figure">
          <div className="walkthrough-image-frame">
            <img className="walkthrough-image" src={`${base}walkthrough/slide12.png`} crossOrigin="anonymous" alt="Annotated troubleshooting, reconnect, data quality, and Help controls" />
          </div>
          <figcaption className="walkthrough-caption"><span className="walkthrough-callouts">1 Data quality notes · 2 Freshness and coverage</span>Sample data</figcaption>
        </figure>
      </div>
    </div>
  );
}