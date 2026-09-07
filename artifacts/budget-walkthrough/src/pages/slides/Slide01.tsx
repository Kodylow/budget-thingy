const base = import.meta.env.BASE_URL;

export default function Slide01() {
  return (
    <div className="w-screen h-screen overflow-hidden relative walkthrough-slide">
      <header className="walkthrough-header">
        <h1 className="walkthrough-title">Budget Monitor: your practical walkthrough</h1>
        <div className="walkthrough-rule"></div>
      </header>
      <div className="walkthrough-content">
        <ul className="walkthrough-list">
          <li><p>For Comcast members and team administrators</p></li>
          <li><p>Find your spending and current projects</p></li>
          <li><p>Understand funding, monthly Agent limits, and the actions your role permits</p></li>
        </ul>
        <figure className="walkthrough-figure">
          <div className="walkthrough-image-frame">
            <img className="walkthrough-image" src={`${base}walkthrough/slide01.png`} crossOrigin="anonymous" alt="Annotated Help walkthrough in Budget Monitor" />
          </div>
          <figcaption className="walkthrough-caption"><span className="walkthrough-callouts">1 Open walkthrough (PDF) · 2 Help navigation</span>Sample data</figcaption>
        </figure>
      </div>
    </div>
  );
}