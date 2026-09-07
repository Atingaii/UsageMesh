import { SavedViews } from "./SavedViews";
import { useState } from "react";
import {
  CalendarDays,
  ChevronDown,
  RotateCcw,
  SlidersHorizontal,
  X,
} from "lucide-react";
import type { DynamicFilterOptions, FilterState } from "../lib/types";
import {
  DEFAULT_FILTERS,
  FILTER_LABELS,
  filterError,
  ROUTE_LABELS,
  TIME_LABELS,
  type Dimension,
} from "../lib/analytics";

export function FilterBar({
  filters,
  options,
  onChange,
  repo,
}: {
  filters: FilterState;
  options: DynamicFilterOptions;
  onChange: (filters: FilterState) => void;
  repo: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const selected = (Object.keys(FILTER_LABELS) as Dimension[]).filter(
    (key) => filters[key] !== "all",
  );
  const error = filterError(filters);
  const update = (key: keyof FilterState, value: string) =>
    onChange({ ...filters, [key]: value });
  const select = (key: Dimension) => (
    <label key={key} className="filter-select">
      <span>{FILTER_LABELS[key]}</span>
      <select
        aria-label={`筛选${FILTER_LABELS[key]}`}
        value={filters[key]}
        onChange={(event) => update(key, event.target.value)}
      >
        <option value="all">全部{FILTER_LABELS[key]}</option>
        {options[key].map((value) => (
          <option key={value} value={value}>
            {key === "routeType" ? ROUTE_LABELS[value] || value : value}
          </option>
        ))}
        {filters[key] !== "all" && !options[key].includes(filters[key]) && (
          <option value={filters[key]}>{filters[key]}（暂无数据）</option>
        )}
      </select>
      <ChevronDown size={13} />
    </label>
  );
  return (
    <section className="filters" aria-label="用量筛选">
      <div className="filter-primary">
        <div className="periods">
          <CalendarDays size={16} />
          <div role="group" aria-label="时间范围">
            {Object.entries(TIME_LABELS).map(([value, label]) => (
              <button
                key={value}
                aria-pressed={filters.timeRange === value}
                className={filters.timeRange === value ? "selected" : ""}
                onClick={() => update("timeRange", value)}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
        <div className="filter-primary-right">
          <button
            className={`button ghost ${expanded ? "active-text" : ""}`}
            aria-expanded={expanded}
            onClick={() => setExpanded(!expanded)}
          >
            <SlidersHorizontal size={15} />
            筛选
            {selected.length ? (
              <span className="count">{selected.length}</span>
            ) : null}
            <ChevronDown size={13} />
          </button>
          <button
            className="icon-button"
            aria-label="重置筛选"
            title="重置筛选"
            onClick={() => onChange({ ...DEFAULT_FILTERS })}
          >
            <RotateCcw size={15} />
          </button>
        </div>
      </div>
      <div className="filter-row">
        {select("device")}
        {select("tool")}
        {select("model")}
        <span className="filter-spacer" />
        <SavedViews
          key={repo}
          repo={repo}
          filters={filters}
          onChange={onChange}
        />
      </div>
      {expanded && (
        <div className="filter-row advanced-filters">
          {(
            [
              "vendor",
              "routeProvider",
              "routeType",
              "rawProvider",
              "tier",
            ] as Dimension[]
          ).map(select)}
        </div>
      )}
      {filters.timeRange === "custom" && (
        <div className="custom-range">
          <label>
            开始时间
            <input
              type="datetime-local"
              aria-label="开始时间"
              value={filters.customStartDate || ""}
              onChange={(event) =>
                update("customStartDate", event.target.value)
              }
            />
          </label>
          <span>—</span>
          <label>
            结束时间
            <input
              type="datetime-local"
              aria-label="结束时间"
              value={filters.customEndDate || ""}
              onChange={(event) => update("customEndDate", event.target.value)}
            />
          </label>
          <small>使用本地时间，包含结束分钟</small>
        </div>
      )}
      {error && (
        <p role="alert" className="filter-error">
          {error}
        </p>
      )}
      {selected.length > 0 && (
        <div className="filter-chips">
          {selected.map((key) => (
            <button key={key} onClick={() => update(key, "all")}>
              {FILTER_LABELS[key]}：{filters[key]}
              <X size={12} />
              <span className="sr-only">移除此筛选</span>
            </button>
          ))}
        </div>
      )}
    </section>
  );
}
