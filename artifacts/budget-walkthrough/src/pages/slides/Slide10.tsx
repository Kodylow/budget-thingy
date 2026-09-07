const base = import.meta.env.BASE_URL;

export default function Slide10() {
  return (
    <div className="w-screen h-screen overflow-hidden relative walkthrough-slide">
      <header className="walkthrough-header">
        <h2 className="walkthrough-title">Manage planning funding—when authorized</h2>
        <div className="walkthrough-rule"></div>
      </header>
      <div className="walkthrough-content">
        <ul className="walkthrough-list">
          <li><p>Open Management → Budget allocations</p></li>
          <li><p>Review opening funding and dated monthly additions separately</p></li>
          <li><p>Review and confirm an opening-funding change or monthly addition</p></li>
          <li><p>Approved adjustments remain additive</p></li>
          <li><p>These actions manage local planning funding, not platform limits</p></li>
        </ul>
        <figure className="walkthrough-figure">
          <div className="walkthrough-image-frame">
            <img className="walkthrough-image" src={`${base}walkthrough/slide10.png`} crossOrigin="anonymous" alt="Annotated Budget allocations funding management workflow" />
          </div>
          <figcaption className="walkthrough-caption"><span className="walkthrough-callouts">1 Opening funding · 2 Monthly addition · 3 Funding history</span>Sample data</figcaption>
        </figure>
      </div>
    </div>
  );
}