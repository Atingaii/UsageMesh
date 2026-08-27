from pathlib import Path

path = Path("src/app.tsx")
text = path.read_text(encoding="utf-8")

branch_anchor = "const ACCESS_BRANCH = 'um-dashboard';"
if "const DEVICE_INDEX_BRANCH = 'um-index';" not in text:
    if branch_anchor not in text:
        raise SystemExit("dashboard branch anchor not found")
    text = text.replace(
        branch_anchor,
        branch_anchor + "\nconst DEVICE_INDEX_BRANCH = 'um-index';",
        1,
    )

old_urls = r'''  const urls = [
    `${RAW}/${repo}/${ACCESS_BRANCH}/device-index.json`,
    new URL('device-index.json', document.baseURI).toString(),
  ];'''
new_urls = r'''  const urls = [
    // The CLI updates this branch on every successful sync, so newly joined
    // devices become visible immediately without rebuilding GitHub Pages.
    `${RAW}/${repo}/${DEVICE_INDEX_BRANCH}/index.json`,
    // Legacy/static fallbacks keep older workspaces and transient raw GitHub
    // failures usable, but they are no longer the source of truth.
    `${RAW}/${repo}/${ACCESS_BRANCH}/device-index.json`,
    new URL('device-index.json', document.baseURI).toString(),
  ];'''

if old_urls not in text:
    raise SystemExit("device-index URL block not found")
text = text.replace(old_urls, new_urls, 1)

for required in [
    "const DEVICE_INDEX_BRANCH = 'um-index';",
    "`${RAW}/${repo}/${DEVICE_INDEX_BRANCH}/index.json`",
]:
    if required not in text:
        raise SystemExit(f"live device index patch missing: {required}")

path.write_text(text, encoding="utf-8")
