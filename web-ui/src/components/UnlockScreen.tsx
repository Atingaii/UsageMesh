import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  ArrowRight,
  Eye,
  EyeOff,
  Fingerprint,
  Github,
  Globe2,
  KeyRound,
  LockKeyhole,
  Monitor,
  ShieldCheck,
} from "lucide-react";
import { repoFromLocation } from "../lib/data";
import { Brand, CopyCommand } from "./ui";

export function UnlockScreen({
  onUnlock,
  error,
  notice,
}: {
  onUnlock: (password: string) => Promise<void>;
  error: string | null;
  notice: string | null;
}) {
  const [busy, setBusy] = useState(false),
    [visible, setVisible] = useState(false);
  const alert = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (error) alert.current?.focus();
  }, [error]);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    const form = event.currentTarget;
    const password = String(new FormData(form).get("password") || "");
    if (!password) return;
    form.reset();
    setVisible(false);
    setBusy(true);
    try {
      await onUnlock(password);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="auth-page">
      <header className="auth-header">
        <Brand />
        <a
          className="button ghost"
          href="https://github.com/Atingaii/UsageMesh"
          target="_blank"
          rel="noreferrer"
        >
          <Github size={17} />
          GitHub
        </a>
      </header>
      <main id="main-content" className="auth-main">
        <div className="auth-narrative">
          <div className="eyebrow">
            <span className="status-dot" />
            YOUR USAGE. YOUR WORKSPACE.
          </div>
          <h1>
            每一次创造，
            <br />
            都有迹可循<span>。</span>
          </h1>
          <p className="auth-lead">
            让分散在不同设备的 AI 用量，
            <br className="desktop-only" />
            汇聚成一个清晰的全貌。
          </p>
          <div className="auth-features">
            {[
              [Monitor, "跨设备汇总", "Mac、Windows 与 Linux"],
              [ShieldCheck, "本地加密", "数据由你自己掌控"],
              [Globe2, "无需服务器", "你的 GitHub 就是工作区"],
            ].map(([Icon, title, description]) => {
              const Component = Icon as typeof Monitor;
              return (
                <div key={String(title)}>
                  <Component size={20} />
                  <strong>{String(title)}</strong>
                  <span>{String(description)}</span>
                </div>
              );
            })}
          </div>
          <div className="auth-tools">
            <span>为你的 AI 编程工具而建</span>
            <span className="tool-word">
              <span className="tool-glyph">⌘</span> Codex
            </span>
            <span className="tool-word">
              <span className="claude-glyph">✳</span> Claude Code
            </span>
            <span className="tool-more">及更多客户端</span>
          </div>
        </div>
        <div className="auth-card">
          <div className="auth-card-top">
            <span className="icon-tile">
              <Fingerprint size={26} />
            </span>
            <span className="badge">
              <LockKeyhole size={12} />
              私有工作区
            </span>
          </div>
          <h2>欢迎回到工作区</h2>
          <p>输入 Dashboard 密码，解锁你的用量洞察。</p>
          <div className="repo-label">
            <Github size={16} />
            <span>{repoFromLocation()}</span>
          </div>
          <form
            className="auth-form"
            onSubmit={submit}
            aria-label="解锁工作区"
            aria-busy={busy}
          >
            <input
              type="text"
              name="username"
              autoComplete="username"
              value={repoFromLocation()}
              readOnly
              hidden
            />
            <div className="auth-field">
              <label htmlFor="password">工作区密码</label>
              <div className={`password-input ${error ? "is-invalid" : ""}`}>
                <KeyRound size={17} />
                <input
                  id="password"
                  name="password"
                  type={visible ? "text" : "password"}
                  autoComplete="current-password"
                  aria-invalid={Boolean(error)}
                  aria-describedby={
                    error
                      ? "unlock-error"
                      : notice
                        ? "unlock-notice"
                        : undefined
                  }
                  placeholder="输入 Dashboard 密码"
                  required
                  disabled={busy}
                />
                <button
                  type="button"
                  className="icon-button"
                  aria-label={visible ? "隐藏密码" : "显示密码"}
                  aria-pressed={visible}
                  disabled={busy}
                  onClick={() => setVisible(!visible)}
                >
                  {visible ? <EyeOff size={17} /> : <Eye size={17} />}
                </button>
              </div>
            </div>
            {error && (
              <div
                id="unlock-error"
                ref={alert}
                role="alert"
                tabIndex={-1}
                className="notice danger"
              >
                {error}
              </div>
            )}
            {!error && notice && (
              <p
                id="unlock-notice"
                role="status"
                className="auth-notice muted small"
              >
                {notice}
              </p>
            )}
            <button
              className="button primary auth-submit"
              disabled={busy}
              type="submit"
            >
              {busy ? "正在解密工作区…" : "解锁工作区"}
              <ArrowRight size={17} />
            </button>
            <span role="status" className="sr-only">
              {busy ? "正在解密并读取设备数据" : ""}
            </span>
          </form>
          <div className="auth-security">
            <ShieldCheck size={16} />
            <p>
              密码仅在浏览器内用于解密，不会上传。
              <br />
              闲置 30 分钟后自动锁定。
            </p>
          </div>
          <details className="setup-help">
            <summary>第一次使用，或忘记了密码？</summary>
            <p>先在设备上初始化工作区：</p>
            <CopyCommand command="usagemesh setup" />
            <p>已有设备可重新设置 Dashboard 密码：</p>
            <CopyCommand command="usagemesh password" />
            <a
              href="https://github.com/Atingaii/UsageMesh/blob/main/README.zh-CN.md"
              target="_blank"
              rel="noreferrer"
            >
              查看完整接入指南 ↗
            </a>
          </details>
        </div>
      </main>
      <footer className="auth-footer">
        <span>
          UsageMesh <span className="muted">/</span> 让每一份用量清晰可见
        </span>
        <span>
          <LockKeyhole size={13} />
          本地优先 · AES-256-GCM
        </span>
      </footer>
    </div>
  );
}
