const base = import.meta.env.BASE_URL;

export default function Slide09() {
  return (
    <div className="w-screen h-screen overflow-hidden relative walkthrough-slide">
      <header className="walkthrough-header">
        <h2 className="walkthrough-title">Change Agent limits safely—when authorized</h2>
        <div className="walkthrough-rule"></div>
      </header>
      <div className="walkthrough-content">
        <ul className="walkthrough-list">
          <li><p>Open Management → Limits</p></li>
          <li><p>Select eligible members in an authorized workspace and enter the amount</p></li>
          <li><p>Review the targets before confirming the change</p></li>
          <li><p>Check which results are verified, pending, failed, or unknown</p></li>
          <li><p>An unconfirmed outcome is not a successful limit change</p></li>
        </ul>
        <figure className="walkthrough-figure">
          <div className="walkthrough-image-frame">
            <img className="walkthrough-image" src={`${base}walkthrough/slide09.png`} crossOrigin="anonymous" alt="Annotated Management Limits change and result workflow" />
          </div>
          <figcaption className="walkthrough-caption"><span className="walkthrough-callouts">1 Review changes · 2 Monthly amount · 3 Eligible members</span>Sample data</figcaption>
        </figure>
      </div>
    </div>
  );
}