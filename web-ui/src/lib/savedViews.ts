import {
  DEFAULT_FILTERS,
  FILTER_LABELS,
  TIME_LABELS,
  filterError,
  type Dimension,
} from "./analytics";
import { readPreference } from "./preferences";
import type { FilterState } from "./types";
export interface SavedView {
  id: string;
  name: string;
  filters: FilterState;
}
const key = (repo: string) => `usagemesh:views:v2:${repo}`;
export function parseViewFilters(value: unknown): FilterState | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (
    typeof v.timeRange !== "string" ||
    !Object.prototype.hasOwnProperty.call(TIME_LABELS, v.timeRange)
  )
    return null;
  const result = {
    ...DEFAULT_FILTERS,
    timeRange: v.timeRange as FilterState["timeRange"],
  };
  for (const field of Object.keys(FILTER_LABELS) as Dimension[])
    if (typeof v[field] === "string") result[field] = v[field];
  if (typeof v.customStartDate === "string")
    result.customStartDate = v.customStartDate;
  if (typeof v.customEndDate === "string")
    result.customEndDate = v.customEndDate;
  return filterError(result) ? null : result;
}
export function readSavedViews(repo: string): SavedView[] {
  try {
    const raw = readPreference(key(repo));
    if (raw !== null) {
      const entries: unknown = JSON.parse(raw);
      if (!Array.isArray(entries)) return [];
      const ids = new Set<string>();
      return entries
        .flatMap((v) => {
          if (
            !v ||
            typeof v.id !== "string" ||
            ids.has(v.id) ||
            typeof v.name !== "string" ||
            !v.name.trim()
          )
            return [];
          const filters = parseViewFilters(v.filters);
          if (!filters) return [];
          ids.add(v.id);
          return [{ id: v.id, name: v.name.trim().slice(0, 40), filters }];
        })
        .slice(0, 20);
    }
    const filters = parseViewFilters(
      JSON.parse(readPreference(`usagemesh:view:${repo}`) || "null"),
    );
    return filters ? [{ id: "legacy", name: "原有保存视图", filters }] : [];
  } catch {
    return [];
  }
}
export function saveViews(repo: string, views: SavedView[]): boolean {
  try {
    localStorage.setItem(key(repo), JSON.stringify(views));
    return true;
  } catch {
    return false;
  }
}
