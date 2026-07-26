import logo from './logo.svg';
import './App.css';
import { useEffect, useState } from 'react';

function App() {
  const [version, setVersion] = useState('');

  useEffect(() => {
    // 经 preload 桥安全调用主进程能力；浏览器/非 Electron 环境无该 API 时静默跳过
    if (window.electronAPI && window.electronAPI.getAppVersion) {
      window.electronAPI.getAppVersion().then(setVersion).catch(() => {});
    }
  }, []);

  return (
    <div className="App">
      <header className="App-header">
        <img src={logo} className="App-logo" alt="logo" />
        <p>
          Edit <code>src/App.js</code> and save to reload by erishen
        </p>
        <a
          className="App-link"
          href="https://reactjs.org"
          target="_blank"
          rel="noopener noreferrer"
        >
          Learn React
        </a>
        {version && (
          <p style={{ marginTop: 16, opacity: 0.7 }}>
            App version: {version}
          </p>
        )}
      </header>
    </div>
  );
}

export default App;
