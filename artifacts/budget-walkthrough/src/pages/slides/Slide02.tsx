const base = import.meta.env.BASE_URL;

export default function Slide02() {
  return (
    <div className="w-screen h-screen overflow-hidden relative walkthrough-slide">
      <header className="walkthrough-header">
        <h2 className="walkthrough-title">Sign in and understand your access</h2>
        <div className="walkthrough-rule"></div>
      </header>
      <div className="walkthrough-content">
        <ul className="walkthrough-list">
          <li><p>Choose Log in; sign-in continues in the current browser tab</p></li>
          <li><p>Members can review their own spending</p></li>
          <li><p>Administrators see additional information only within their authorized scope</p></li>
          <li><p>Management tools appear only when your permissions allow them</p></li>
        </ul>
        <figure className="walkthrough-figure">
          <div className="walkthrough-image-frame">
            <img className="walkthrough-image" src={`${base}walkthrough/slide02.png`} crossOrigin="anonymous" alt="Annotated Budget Monitor sign-in and access controls" />
          </div>
          <figcaption className="walkthrough-caption"><span className="walkthrough-callouts">1 Log in</span>Sample data</figcaption>
        </figure>
      </div>
    </div>
  );
}