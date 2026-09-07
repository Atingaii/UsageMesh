import { useEffect, useRef, useState, type ReactNode } from "react";
import { Check, Copy, Database, X } from "lucide-react";

export function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <div className="brand">
      <img
        src={`${import.meta.env.BASE_URL}usagemesh-icon.svg`}
        width="34"
        height="34"
        alt=""
      />
      {!compact && (
        <span>
          UsageMesh<span className="brand-caption">AI USAGE WORKSPACE</span>
        </span>
      )}
    </div>
  );
}
export function Badge({
  children,
  tone = "",
}: {
  children: ReactNode;
  tone?: string;
}) {
  return <span className={`badge ${tone}`}>{children}</span>;
}
export function EmptyState({
  title = "当前筛选范围暂无数据",
  description = "调整时间范围或筛选条件，查看其他用量记录。",
  action,
}: {
  title?: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty-state">
      <span className="icon-tile">
        <Database size={22} />
      </span>
      <h3>{title}</h3>
      <p>{description}</p>
      {action}
    </div>
  );
}
export function Section({
  title,
  subtitle,
  action,
  children,
  className = "",
}: {
  title: string;
  subtitle?: string;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`panel ${className}`}>
      <div className="panel-heading">
        <div>
          <h2>{title}</h2>
          {subtitle && <p>{subtitle}</p>}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}
export function CopyCommand({ command }: { command: string }) {
  const [status, setStatus] = useState("");
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  return (
    <div className="command">
      <code>{command}</code>
      <button
        className="icon-button"
        aria-label={`复制 ${command}`}
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(command);
            setStatus("已复制");
          } catch {
            setStatus("请选中命令复制");
          }
          clearTimeout(timer.current);
          timer.current = setTimeout(() => setStatus(""), 2500);
        }}
      >
        {status === "已复制" ? <Check size={16} /> : <Copy size={16} />}
      </button>
      <span className="sr-only" role="status">
        {status}
      </span>
      {status && status !== "已复制" && <small>{status}</small>}
    </div>
  );
}
export function Modal({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current;
    const previous = document.activeElement as HTMLElement;
    element?.showModal();
    return () => {
      element?.close();
      previous?.focus();
    };
  }, []);
  return (
    <dialog
      ref={dialog}
      className="modal"
      aria-label={title}
      onCancel={onClose}
      onClick={(event) => {
        if (event.target === dialog.current) onClose();
      }}
    >
      <div className="modal-heading">
        <h2>{title}</h2>
        <button className="icon-button" aria-label="关闭弹窗" onClick={onClose}>
          <X size={18} />
        </button>
      </div>
      {children}
    </dialog>
  );
}
