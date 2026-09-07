import { useState } from "react";
import type { FilterState } from "../lib/types";
import { filterError } from "../lib/analytics";
import { readSavedViews, saveViews, type SavedView } from "../lib/savedViews";
import { Modal } from "./ui";

export function SavedViews({
  repo,
  filters,
  onChange,
}: {
  repo: string;
  filters: FilterState;
  onChange: (filters: FilterState) => void;
}) {
  const [views, setViews] = useState(() => readSavedViews(repo));
  const [open, setOpen] = useState(false),
    [name, setName] = useState(""),
    [editing, setEditing] = useState<string | null>(null),
    [notice, setNotice] = useState("");
  const commit = (next: SavedView[]) => {
    const persisted = saveViews(repo, next);
    setViews(next);
    setNotice(
      persisted
        ? "视图已保存到此浏览器"
        : "浏览器存储不可用，变更仅在本次页面停留期间有效",
    );
  };
  return (
    <div className="saved-views">
      <select
        aria-label="切换保存视图"
        value=""
        onChange={(event) => {
          const view = views.find((v) => v.id === event.target.value);
          if (view) {
            onChange({ ...view.filters });
            setNotice(`已应用：${view.name}`);
          }
        }}
      >
        <option value="">选择保存视图（{views.length}）</option>
        {views.map((view) => (
          <option key={view.id} value={view.id}>
            {view.name}
          </option>
        ))}
      </select>
      <button
        className="text-button"
        onClick={() => {
          setOpen(true);
          setName("");
          setEditing(null);
          setNotice("");
        }}
      >
        管理 / 保存视图
      </button>
      {!open && (
        <span role="status" className="small muted">
          {notice}
        </span>
      )}
      {open && (
        <Modal title="保存的筛选视图" onClose={() => setOpen(false)}>
          <p className="small muted">
            每个仓库最多 20 个视图，保存全部筛选与时间范围；仅存于当前浏览器。
          </p>
          <form
            className="view-editor"
            onSubmit={(event) => {
              event.preventDefault();
              const trimmed = name.trim();
              if (!trimmed) {
                setNotice("请输入视图名称");
                return;
              }
              if (views.some((v) => v.id !== editing && v.name === trimmed)) {
                setNotice("已有同名视图，请使用其他名称");
                return;
              }
              if (!editing && filterError(filters)) {
                setNotice("请先填写有效的自定义时间范围");
                return;
              }
              if (!editing && views.length >= 20) {
                setNotice("已达到 20 个视图，请先删除不用的视图");
                return;
              }
              commit(
                editing
                  ? views.map((v) =>
                      v.id === editing ? { ...v, name: trimmed } : v,
                    )
                  : [
                      ...views,
                      {
                        id: crypto.randomUUID(),
                        name: trimmed,
                        filters: { ...filters },
                      },
                    ],
              );
              setEditing(null);
              setName("");
            }}
          >
            <label htmlFor="view-name">
              {editing ? "修改视图名称" : "新视图名称"}
            </label>
            <input
              id="view-name"
              value={name}
              maxLength={40}
              required
              placeholder="例如：工作电脑 · 近 7 天"
              onChange={(event) => setName(event.target.value)}
            />
            <button className="button primary" type="submit">
              {editing ? "保存名称" : "保存当前筛选"}
            </button>
            {editing && (
              <button
                className="text-button"
                type="button"
                onClick={() => {
                  setEditing(null);
                  setName("");
                }}
              >
                取消重命名
              </button>
            )}
          </form>
          <p role="status" className="small">
            {notice}
          </p>
          <ul className="saved-view-list">
            {views.map((view) => (
              <li key={view.id}>
                <strong>{view.name}</strong>
                <div>
                  <button
                    className="text-button"
                    onClick={() => {
                      onChange({ ...view.filters });
                      setNotice(`已应用：${view.name}`);
                      setOpen(false);
                    }}
                  >
                    应用<span className="sr-only"> {view.name}</span>
                  </button>
                  <button
                    className="text-button"
                    onClick={() => {
                      setEditing(view.id);
                      setName(view.name);
                    }}
                  >
                    重命名<span className="sr-only"> {view.name}</span>
                  </button>
                  <button
                    className="text-button"
                    onClick={() => {
                      commit(views.filter((v) => v.id !== view.id));
                      if (editing === view.id) {
                        setEditing(null);
                        setName("");
                      }
                    }}
                  >
                    删除<span className="sr-only"> {view.name}</span>
                  </button>
                </div>
              </li>
            ))}
          </ul>
          {!views.length && (
            <p className="muted small">还没有保存视图，从当前筛选创建一个。</p>
          )}
        </Modal>
      )}
    </div>
  );
}
