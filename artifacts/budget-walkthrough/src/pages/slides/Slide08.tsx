const base = import.meta.env.BASE_URL;

export default function Slide08() {
  return (
    <div className="w-screen h-screen overflow-hidden relative walkthrough-slide">
      <header className="walkthrough-header">
        <h2 className="walkthrough-title">Funding and Agent limits are different</h2>
        <div className="walkthrough-rule"></div>
      </header>
      <div className="walkthrough-content">
        <ul className="walkthrough-list">
          <li><p>Budget allocations are planning funding used for monitoring</p></li>
          <li><p>Monthly Agent limits are platform controls that may block paid Agent usage</p></li>
          <li><p>Changing a planning allocation does not automatically change an Agent limit</p></li>
          <li><p>Remaining monthly limit uses the current billing cycle, not a short report range</p></li>
        </ul>
        <figure className="walkthrough-figure">
          <div className="walkthrough-image-frame">
            <img className="walkthrough-image" src={`${base}walkthrough/slide08.png`} crossOrigin="anonymous" alt="Annotated planning funding and monthly Agent limit comparison" />
          </div>
          <figcaption className="walkthrough-caption"><span className="walkthrough-callouts">1 Current billing cycle · 2 Monthly limit and remaining</span>Sample data</figcaption>
        </figure>
      </div>
    </div>
  );
}