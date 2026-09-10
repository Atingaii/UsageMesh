import { useEffect, useState, type FormEvent } from "react";
import {
  Check,
  ExternalLink,
  LockKeyhole,
  Monitor,
  Moon,
  Sun,
} from "lucide-react";
import type { DashboardDataset } from "../lib/types";
import type { Preferences } from "../lib/preferences";
import { dateTime, money } from "../lib/analytics";
import { Badge, CopyCommand, Section } from "../components/ui";

export function Settings({
  preferences,
  onChange,
  dataset,
  checkedAt,
  monthlyCost,
}: {
  preferences: Preferences;
  onChange: (value: Preferences) => void;
  dataset: DashboardDataset;
  checkedAt: number | null;
  monthlyCost: number;
}) {
  const [budget, setBudget] = useState(String(preferences.monthlyBudget || "")),
    [notice, setNotice] = useState("");
  const [build, setBuild] = useState<{
    dashboardSourceSha?: string;
    builtAt?: string;
  } | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    void fetch(new URL("build-info.json", document.baseURI), {
      signal: controller.signal,
    })
      .then((response) => (response.ok ? response.json() : null))
      .then(setBuild)
      .catch(() => undefined);
    return () => controller.abort();
  }, []);
  const save = (event: FormEvent) => {
    event.preventDefault();
    const value = Number(budget);
    if (!Number.isFinite(value) || value < 0) return;
    onChange({ ...preferences, monthlyBudget: value });
    setNotice(value ? "费用提醒已保存" : "费用提醒已关闭");
  };
  return (
    <div className="settings-grid">
      <div className="view-stack">
        <Section title="界面外观" subtitle="选择适合你的亮度与阅读字号">
          <div className="settings-body">
            <label className="setting-row">
              <span>
                <strong>阅读字号</strong>
                <small>调整全站文字大小，选择后立即生效</small>
              </span>
              <select
                aria-label="阅读字号"
                value={preferences.textSize}
                onChange={(event) =>
                  onChange({
                    ...preferences,
                    textSize: event.target.value as Preferences["textSize"],
                  })
                }
              >
                <option value="standard">标准 · 清晰阅读</option>
                <option value="large">大字 · 放大 12.5%</option>
              </select>
            </label>
            <div className="theme-options" role="group" aria-label="配色模式">
              {(
                [
                  ["light", "浅色", Sun],
                  ["dark", "深色", Moon],
                  ["system", "跟随系统", Monitor],
                ] as const
              ).map(([value, label, Icon]) => (
                <button
                  key={value}
                  className={preferences.theme === value ? "selected" : ""}
                  aria-pressed={preferences.theme === value}
                  onClick={() => onChange({ ...preferences, theme: value })}
                >
                  <span>
                    <Icon size={16} />
                    {label}
                    {preferences.theme === value && <Check size={14} />}
                  </span>
                </button>
              ))}
            </div>
          </div>
        </Section>
        <Section
          title="自动刷新"
          subtitle="定期检查 GitHub 中的新快照，后台标签页暂停轮询"
        >
          <div className="settings-body">
            <label className="setting-row">
              <span>
                <strong>检查间隔</strong>
                <small>此设置不会改变设备端采集频率</small>
              </span>
              <select
                aria-label="自动刷新间隔"
                value={preferences.refreshSeconds}
                onChange={(event) =>
                  onChange({
                    ...preferences,
                    refreshSeconds: Number(
                      event.target.value,
                    ) as Preferences["refreshSeconds"],
                  })
                }
              >
                <option value="10">每 10 秒</option>
                <option value="30">每 30 秒</option>
                <option value="60">每 60 秒</option>
                <option value="0">仅手动刷新</option>
              </select>
            </label>
            <div className="setting-row">
              <span>最近成功检查</span>
              <span className="mono small">
                {checkedAt ? dateTime(checkedAt) : "尚未检查"}
              </span>
            </div>
          </div>
        </Section>
        <Section
          title="每月费用提醒"
          subtitle="针对本月全部设备的兼容价卡估算，设置一个关注阈值"
        >
          <form className="settings-body" onSubmit={save}>
            <label htmlFor="monthly-budget">每月提醒阈值 (USD)</label>
            <div className="budget-input">
              <span>$</span>
              <input
                id="monthly-budget"
                type="number"
                min="0"
                step="0.01"
                placeholder="例如 100"
                value={budget}
                onChange={(event) => {
                  setBudget(event.target.value);
                  setNotice("");
                }}
              />
              <button type="submit" className="button primary">
                保存设置
              </button>
            </div>
            <p className="muted small">
              留空或设置为 0 可关闭。当前本月估算 {money(monthlyCost)}
              ；仅在界面内提醒，不发送通知、不限制使用。
            </p>
            {preferences.monthlyBudget > 0 && (
              <div className="budget-progress">
                <div>
                  <span>本月提醒进度</span>
                  <strong>
                    {((monthlyCost / preferences.monthlyBudget) * 100).toFixed(
                      1,
                    )}
                    %
                  </strong>
                </div>
                <div className="progress-track">
                  <div
                    style={{
                      width: `${Math.min(100, (monthlyCost / preferences.monthlyBudget) * 100)}%`,
                    }}
                  />
                </div>
              </div>
            )}
            <p role="status" className="success-text small">
              {notice}
            </p>
          </form>
        </Section>
      </div>
      <div className="view-stack">
        <Section title="工作区信息">
          <dl className="workspace-info">
            <div>
              <dt>数据仓库</dt>
              <dd>
                <a
                  href={`https://github.com/${dataset.repo}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  {dataset.repo}
                  <ExternalLink size={12} />
                </a>
              </dd>
            </div>
            <div>
              <dt>已读取设备</dt>
              <dd>
                {dataset.devices.length} / {dataset.expectedDevices}
              </dd>
            </div>
            <div>
              <dt>账本最近更新</dt>
              <dd>{dateTime(dataset.lastSync)}</dd>
            </div>
            <div>
              <dt>费用来源</dt>
              <dd>设备端加密账本</dd>
            </div>
            <div>
              <dt>定价未完整解析</dt>
              <dd>{dataset.pricing.fallbackRows} 个聚合桶</dd>
            </div>
            {build?.dashboardSourceSha && (
              <div>
                <dt>网页构建版本</dt>
                <dd>
                  <a
                    href={`https://github.com/Atingaii/UsageMesh/commit/${build.dashboardSourceSha}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {build.dashboardSourceSha.slice(0, 10)}
                  </a>
                </dd>
              </div>
            )}
            {build?.builtAt && (
              <div>
                <dt>构建时间</dt>
                <dd>{dateTime(build.builtAt)}</dd>
              </div>
            )}
          </dl>
          <div className="settings-bottom">
            <a
              href="https://github.com/Atingaii/UsageMesh/blob/main/docs/PRICING.md"
              target="_blank"
              rel="noreferrer"
              className="text-button"
            >
              查看完整费用口径
              <ExternalLink size={13} />
            </a>
          </div>
        </Section>
        <Section
          title="隐私与会话"
          action={
            <Badge tone="success">
              <LockKeyhole size={12} />
              本地解密
            </Badge>
          }
        >
          <div className="settings-body privacy-notes">
            <p>密码只用于当前浏览器内的解密。用量账本上传前已经加密。</p>
            <p>
              同一标签页可恢复加密会话；闲置 30 分钟、超过 12
              小时或手动锁定后需要重新解锁。
            </p>
            <p>
              外观、阅读字号、刷新间隔和提醒阈值保存在当前浏览器，不随 GitHub
              同步。
            </p>
            <p>修改工作区密码，请在已加入的设备运行：</p>
            <CopyCommand command="usagemesh password" />
          </div>
        </Section>
        <Section
          title="本地工作台"
          subtitle="在本机管理供应商、额度、项目账本和系统提醒"
        >
          <div className="settings-body">
            <p>
              安装 UsageMesh 2.7.0
              或更新版本后，在终端运行以下命令。浏览器会打开独立的本地管理页面。
            </p>
            <CopyCommand command="usagemesh serve" />
            <p>
              使用终端显示的完整启动链接连接；本地配置、密钥和项目数据不会上传此云端面板。
            </p>
          </div>
        </Section>
      </div>
    </div>
  );
}
