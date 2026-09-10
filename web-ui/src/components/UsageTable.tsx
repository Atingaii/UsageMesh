import { memo, useMemo, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  ChevronLeft,
  ChevronRight,
  Download,
  Search,
  SlidersHorizontal,
  X,
} from "lucide-react";
import type { RequestRecord, UsageRecord } from "../lib/types";
import {
  dateTime,
  downloadCsv,
  money,
  number,
  ROUTE_LABELS,
} from "../lib/analytics";
import { sortTableRows } from "../lib/tableRows";
import { Badge, EmptyState, Modal } from "./ui";

type Row = UsageRecord | RequestRecord;
interface Column {
  key: string;
  label: string;
  value: (row: Row) => string | number;
  numeric?: boolean;
  extra?: boolean;
}
const isRequest = (row: Row): row is RequestRecord => "requestCount" in row;
function columnsFor(requests: boolean): Column[] {
  return [
    {
      key: "date",
      label: requests ? "请求时间" : "账本时间",
      value: (row) => (row.timestampMs ? dateTime(row.timestampMs) : row.date),
    },
    { key: "device", label: "设备", value: (row) => row.device },
    { key: "tool", label: "客户端", value: (row) => row.tool },
    { key: "model", label: "模型", value: (row) => row.model },
    { key: "routeProvider", label: "路由", value: (row) => row.routeProvider },
    { key: "tier", label: "速率 / Tier", value: (row) => row.tier },
    ...(requests
      ? [
          {
            key: "reasoningEffort",
            label: "思考强度",
            value: (row: Row) =>
              isRequest(row) ? row.reasoningEffort || "—" : "—",
          },
        ]
      : []),
    {
      key: "totalTokens",
      label: "总 Tokens",
      value: (row) => row.totalTokens,
      numeric: true,
    },
    {
      key: "cost",
      label: "估算费用 (USD)",
      value: (row) => row.cost,
      numeric: true,
    },
    {
      key: "vendor",
      label: "模型厂商",
      value: (row) => row.vendor,
      extra: true,
    },
    {
      key: "routeType",
      label: "路由类型",
      value: (row) => ROUTE_LABELS[row.routeType] || row.routeType,
      extra: true,
    },
    {
      key: "billingChannel",
      label: "计费渠道",
      value: (row) => row.billingChannel,
      extra: true,
    },
    {
      key: "rawProvider",
      label: "原始 Provider",
      value: (row) => row.rawProvider,
      extra: true,
    },
    {
      key: "inputTokens",
      label: "输入",
      value: (row) => row.inputTokens,
      numeric: true,
      extra: true,
    },
    {
      key: "cacheReadTokens",
      label: "缓存读取",
      value: (row) => row.cacheReadTokens,
      numeric: true,
      extra: true,
    },
    {
      key: "cacheWriteTokens",
      label: "缓存写入",
      value: (row) => row.cacheWriteTokens,
      numeric: true,
      extra: true,
    },
    {
      key: "outputTokens",
      label: "输出",
      value: (row) => row.outputTokens,
      numeric: true,
      extra: true,
    },
    {
      key: "reasoningTokens",
      label: "Reasoning",
      value: (row) => row.reasoningTokens,
      numeric: true,
      extra: true,
    },
    {
      key: "requests",
      label: "请求数",
      value: (row) => (isRequest(row) ? row.requestCount : row.requestsCount),
      numeric: true,
      extra: true,
    },
    ...(requests
      ? [
          {
            key: "durationMs",
            label: "耗时 (ms)",
            value: (row: Row) =>
              isRequest(row) ? (row.durationMs ?? "—") : "—",
            extra: true,
            numeric: true,
          },
          {
            key: "agent",
            label: "Agent",
            value: (row: Row) => (isRequest(row) ? row.agent || "—" : "—"),
            extra: true,
          },
        ]
      : []),
  ];
}
export function exportRows(rows: Row[], requests = false) {
  const columns = columnsFor(requests);
  downloadCsv(
    `usagemesh-${requests ? "requests" : "ledger"}-${new Date().toISOString().slice(0, 10)}.csv`,
    [...columns.map((c) => c.label), "定价状态", "Device ID", "Timestamp (ms)"],
    rows.map((row) => [
      ...columns.map((c) => c.value(row)),
      row.costLowerBound ? "Lower bound" : "Ledger estimate",
      row.deviceId,
      row.timestampMs,
    ]),
  );
}
export const UsageTable = memo(function UsageTable({
  rows,
  requests = false,
  limitNote,
}: {
  rows: Row[];
  requests?: boolean;
  limitNote?: string;
}) {
  const [query, setQuery] = useState(""),
    [sortKey, setSortKey] = useState("date"),
    [ascending, setAscending] = useState(false);
  const [page, setPage] = useState(1),
    [pageSize, setPageSize] = useState(25),
    [expanded, setExpanded] = useState(false),
    [detail, setDetail] = useState<Row | null>(null);
  const columns = useMemo(() => columnsFor(requests), [requests]);
  const shownColumns = columns.filter((column) => expanded || !column.extra);
  const ordered = useMemo(() => {
    const column = columns.find((c) => c.key === sortKey)!;
    return sortTableRows(
      rows,
      (row) =>
        sortKey === "date"
          ? row.timestampMs || new Date(row.date).getTime() || 0
          : column.value(row),
      ascending,
    );
  }, [rows, columns, sortKey, ascending]);
  // Search text is created only when needed, then reused while typing. Sorting
  // is independent of the query so each keystroke only filters the stable order.
  const searchValues = useMemo(
    () => new WeakMap<Row, string[]>(),
    [rows, columns],
  );
  const sorted = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return ordered;
    return ordered.filter((row) => {
      let values = searchValues.get(row);
      if (!values) {
        values = columns.map((column) =>
          String(column.value(row)).toLowerCase(),
        );
        searchValues.set(row, values);
      }
      return values.some((value) => value.includes(q));
    });
  }, [ordered, query, columns, searchValues]);
  const pages = Math.max(1, Math.ceil(sorted.length / pageSize)),
    currentPage = Math.min(page, pages);
  const visible = sorted.slice(
    (currentPage - 1) * pageSize,
    currentPage * pageSize,
  );
  const format = (row: Row, column: Column) => {
    const value = column.value(row);
    if (column.key === "cost")
      return `${row.costLowerBound ? "≥ " : ""}${money(Number(value), 4)}`;
    return column.numeric && typeof value === "number"
      ? number(value)
      : String(value);
  };
  return (
    <section className="panel data-panel">
      <div className="panel-heading">
        <div>
          <h2>
            {requests ? "实时请求明细" : "聚合账本明细"}{" "}
            <Badge>{number(sorted.length)} 条</Badge>
          </h2>
          <p>
            {requests
              ? "来源客户端记录的真实用量元数据；思考强度为空时不做推测。"
              : "账本按设备、时间和模型等维度聚合，费用沿用设备端结果。"}
          </p>
        </div>
        <div className="table-actions">
          <button
            className={`button ${expanded ? "active-text" : ""}`}
            aria-pressed={expanded}
            onClick={() => setExpanded(!expanded)}
          >
            <SlidersHorizontal size={15} />
            {expanded ? "精简字段" : "全部字段"}
          </button>
          <button
            className="button"
            disabled={!sorted.length}
            onClick={() => exportRows(sorted, requests)}
          >
            <Download size={15} />
            导出 CSV
          </button>
        </div>
      </div>
      <div className="table-search-row">
        <div className="search-input">
          <Search size={16} />
          <input
            aria-label={requests ? "搜索请求明细" : "搜索聚合明细"}
            placeholder="搜索设备、模型、路由或思考强度…"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setPage(1);
            }}
          />
          {query && (
            <button
              className="icon-button"
              aria-label="清除搜索"
              onClick={() => {
                setQuery("");
                setPage(1);
              }}
            >
              <X size={14} />
            </button>
          )}
        </div>
        <span className="muted small">点击模型查看完整记录</span>
      </div>
      {sorted.length ? (
        <div
          className="table-scroll"
          tabIndex={0}
          role="region"
          aria-label={
            requests ? "请求明细表，可横向滚动" : "聚合账本表，可横向滚动"
          }
        >
          <table>
            <caption className="sr-only">
              {requests ? "请求级用量记录" : "聚合用量账本"}
            </caption>
            <thead>
              <tr>
                {shownColumns.map((column) => (
                  <th
                    key={column.key}
                    className={column.numeric ? "numeric" : ""}
                    aria-sort={
                      sortKey === column.key
                        ? ascending
                          ? "ascending"
                          : "descending"
                        : "none"
                    }
                  >
                    <button
                      onClick={() => {
                        if (sortKey === column.key) setAscending(!ascending);
                        else {
                          setSortKey(column.key);
                          setAscending(false);
                        }
                        setPage(1);
                      }}
                    >
                      {column.label}
                      {sortKey === column.key ? (
                        ascending ? (
                          <ArrowUp size={12} />
                        ) : (
                          <ArrowDown size={12} />
                        )
                      ) : (
                        <ArrowUpDown size={12} />
                      )}
                    </button>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {visible.map((row) => (
                <tr key={row.id}>
                  {shownColumns.map((column) => (
                    <td
                      key={column.key}
                      className={`${column.numeric ? "numeric" : ""} ${column.key === "cost" ? "cost-cell" : ""}`}
                      title={format(row, column)}
                    >
                      {column.key === "model" ? (
                        <button
                          className="model-link"
                          onClick={() => setDetail(row)}
                        >
                          {row.model}
                        </button>
                      ) : column.key === "tier" ? (
                        <Badge
                          tone={/fast|priority/i.test(row.tier) ? "violet" : ""}
                        >
                          {row.tier}
                        </Badge>
                      ) : (
                        format(row, column)
                      )}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <EmptyState
          title={
            query ? "没有匹配的记录" : requests ? "暂无请求明细" : undefined
          }
          description={
            query
              ? "试试其他关键词，或清除搜索条件。"
              : requests
                ? "请求账本仅保留近期明细。检查筛选范围，并确保设备端已更新和同步。"
                : undefined
          }
        />
      )}
      <div className="pagination">
        <span>
          {sorted.length
            ? `显示 ${(currentPage - 1) * pageSize + 1}–${Math.min(currentPage * pageSize, sorted.length)}`
            : "显示 0"}{" "}
          / 共 {number(sorted.length)} 条
        </span>
        <div>
          <label>
            <span className="sr-only">每页记录数</span>
            <select
              aria-label="每页记录数"
              value={pageSize}
              onChange={(event) => {
                setPageSize(Number(event.target.value));
                setPage(1);
              }}
            >
              {[25, 50, 100].map((size) => (
                <option key={size} value={size}>
                  {size} 条 / 页
                </option>
              ))}
            </select>
          </label>
          <button
            className="icon-button"
            aria-label="上一页"
            disabled={currentPage <= 1}
            onClick={() => setPage(currentPage - 1)}
          >
            <ChevronLeft size={16} />
          </button>
          <span aria-live="polite">
            {currentPage} / {pages}
          </span>
          <button
            className="icon-button"
            aria-label="下一页"
            disabled={currentPage >= pages}
            onClick={() => setPage(currentPage + 1)}
          >
            <ChevronRight size={16} />
          </button>
        </div>
      </div>
      {limitNote && <p className="table-note">{limitNote}</p>}
      {detail && (
        <Modal title="用量记录详情" onClose={() => setDetail(null)}>
          <dl className="record-detail">
            {columns.map((column) => (
              <div key={column.key}>
                <dt>{column.label}</dt>
                <dd>{format(detail, column)}</dd>
              </div>
            ))}
            <div>
              <dt>定价状态</dt>
              <dd>
                {detail.costLowerBound
                  ? "费用下界，部分价格尚未解析"
                  : "设备端账本估算"}
              </dd>
            </div>
            <div>
              <dt>设备 ID</dt>
              <dd>{detail.deviceId}</dd>
            </div>
          </dl>
        </Modal>
      )}
    </section>
  );
});
