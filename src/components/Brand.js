import logo from '../logo.svg';

export default function Brand() {
  return (
    <div className="brand">
      <img src={logo} alt="logo" className="brand-logo" />
      <div>
        <div className="brand-title">Agent Workflow</div>
        <div className="brand-sub">AI 能力工作台</div>
      </div>
    </div>
  );
}
