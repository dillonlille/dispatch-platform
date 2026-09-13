import { Wrench } from "lucide-react";

export function DspHome() {
  return (
    <section className="dsp-home" aria-labelledby="dsp-home-heading">
      <div className="dsp-home-notice">
        <div className="dsp-home-icon" aria-hidden="true">
          <Wrench />
        </div>
        <h1 id="dsp-home-heading">Currently under development</h1>
        <p>We’re building your DSP home page.</p>
      </div>
    </section>
  );
}
