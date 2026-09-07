export interface Preferences {
  theme: "light" | "dark" | "system";
  refreshSeconds: 0 | 10 | 30 | 60;
  monthlyBudget: number;
}
export const DEFAULT_PREFERENCES: Preferences = {
  theme: "system",
  refreshSeconds: 10,
  monthlyBudget: 0,
};
export function readPreference(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
export function writePreference(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* Storage is optional. */
  }
}
export function readPreferences(): Preferences {
  try {
    const value = JSON.parse(
      readPreference("usagemesh:preferences:v1") || "{}",
    ) as Partial<Preferences>;
    const oldTheme = readPreference("usagemesh:theme");
    return {
      theme: ["light", "dark", "system"].includes(value.theme || "")
        ? value.theme!
        : oldTheme === "dark"
          ? "dark"
          : "system",
      refreshSeconds: [0, 10, 30, 60].includes(value.refreshSeconds ?? -1)
        ? value.refreshSeconds!
        : 10,
      monthlyBudget:
        typeof value.monthlyBudget === "number" &&
        Number.isFinite(value.monthlyBudget) &&
        value.monthlyBudget >= 0
          ? value.monthlyBudget
          : 0,
    };
  } catch {
    return DEFAULT_PREFERENCES;
  }
}
