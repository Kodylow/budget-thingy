const base = import.meta.env.BASE_URL;

export default function Slide03() {
  return (
    <div className="w-screen h-screen overflow-hidden relative walkthrough-slide">
      <header className="walkthrough-header">
        <h2 className="walkthrough-title">Start with Home</h2>
        <div className="walkthrough-rule"></div>
      </header>
      <div className="walkthrough-content">
        <ul className="walkthrough-list">
          <li><p>Review your personal spending summary and trends</p></li>
          <li><p>Use My Projects to see your current project inventory</p></li>
          <li><p>Follow linked details to investigate an amount</p></li>
          <li><p>Home is not automatically an account-wide spending view</p></li>
        </ul>
        <figure className="walkthrough-figure">
          <div className="walkthrough-image-frame">
            <img className="walkthrough-image" src={`${base}walkthrough/slide03.png`} crossOrigin="anonymous" alt="Annotated Budget Monitor Home spending summary" />
          </div>
          <figcaption className="walkthrough-caption"><span className="walkthrough-callouts">1 Personal spending · 2 My Projects · 3 Spending trend</span>Sample data</figcaption>
        </figure>
      </div>
    </div>
  );
}