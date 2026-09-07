const base = import.meta.env.BASE_URL;

export default function Slide07() {
  return (
    <div className="w-screen h-screen overflow-hidden relative walkthrough-slide">
      <header className="walkthrough-header">
        <h2 className="walkthrough-title">Team admins: review your assigned scope</h2>
        <div className="walkthrough-rule"></div>
      </header>
      <div className="walkthrough-content">
        <ul className="walkthrough-list">
          <li><p>Open My Team to review the people and groups available to you</p></li>
          <li><p>Investigate changes before changing funding or limits</p></li>
          <li><p>Check the selected scope and dates when comparing amounts</p></li>
          <li><p>A shared funding team does not grant access to otherwise restricted spending</p></li>
        </ul>
        <figure className="walkthrough-figure">
          <div className="walkthrough-image-frame">
            <img className="walkthrough-image" src={`${base}walkthrough/slide07.png`} crossOrigin="anonymous" alt="Annotated My Team people and group scope view" />
          </div>
          <figcaption className="walkthrough-caption"><span className="walkthrough-callouts">1 Scoped people · 2 Assigned team scope</span>Sample data</figcaption>
        </figure>
      </div>
    </div>
  );
}