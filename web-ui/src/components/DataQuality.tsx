import { useMemo } from "react";
import type { DashboardDataset } from "../lib/types";
import { dateTime } from "../lib/analytics";
import { dataQuality } from "../lib/insights";
import { Badge, Section } from "./ui";
export function DataQuality({
  dataset,
  onInspect,
}: {
  dataset: DashboardDataset;
  onInspect?: () => void;
}) {
  const quality = useMemo(() => dataQuality(dataset), [dataset]);
  const items = [
    {
      title: "账本读取",
      value: `${dataset.devices.length} / ${dataset.expectedDevices} 台`,
      note: quality.missing
        ? `${quality.missing} 台账本未读取，当前合计不包含这些设备。请检查设备页错误并重试刷新。`
        : dataset.retainedDeviceIds?.length
          ? `${dataset.retainedDeviceIds.length} 台更新失败，暂时沿用本标签页上次成功读取的账本；等待重新同步。`
          : dataset.expectedDevices
            ? "索引中的设备账本均已读取；不代表历史数据已完整留存。"
            : "尚未发现设备，请接入设备并首次同步。",
      warning:
        quality.missing > 0 || Boolean(dataset.retainedDeviceIds?.length),
    },
    {
      title: "设备心跳",
      value: `${quality.delayed.length} 台延迟 / 离线`,
      note: quality.delayed.length
        ? `${quality.delayed.map((d) => d.name).join("、")}。设备可能休眠或断网，历史账本仍可查看。`
        : "已读取设备暂无延迟心跳。",
      warning: quality.delayed.length > 0,
    },
    {
      title: "账本新鲜度",
      value: `${quality.stale.length} 台需核对`,
      note: quality.stale.length
        ? `${quality.stale.map((d) => d.name).join("、")} 的更新时间缺失或超过 24 小时。无新用量也可能不更新，可在设备端运行 usagemesh status / sync 核对。`
        : "已读取设备的账本更新时间均在 24 小时内。",
      warning: quality.stale.length > 0,
    },
    {
      title: "费用完整性",
      value: dataset.records.length
        ? `${quality.unresolved} / ${dataset.records.length} 个桶为下界或未定价`
        : "暂无聚合记录",
      note: "未完整解析的费用不能视为最终成本；查看明细中的费用下界与定价字段，更新设备端后同步。",
      warning: quality.unresolved > 0,
    },
    {
      title: "时间精度",
      value: `${quality.dated} 个桶仅有日期`,
      note: "仅日期记录支持按天统计，无法精确定位到分钟；升级设备端后同步可改善后续记录。",
      warning: quality.dated > 0,
    },
    {
      title: "请求留存",
      value: `${dataset.requests.length} 条可查明细`,
      note: quality.earliest
        ? `可见时间：${dateTime(quality.earliest)} — ${dateTime(quality.latest!)}。账本未提供连续覆盖证明，不能据此推断中间无缺失。`
        : "没有可见请求时间，无法证明请求历史覆盖；聚合统计与明细留存可能不同。",
      warning: false,
    },
  ];
  return (
    <Section
      title="数据完整性检查"
      subtitle="工作区全部设备的快照诊断，不受页面筛选影响；缺失记录不等于零消耗"
      action={
        onInspect && (
          <button className="text-button" onClick={onInspect}>
            查看设备与诊断
          </button>
        )
      }
    >
      <div className="quality-grid">
        {items.map((item) => (
          <article key={item.title}>
            <div>
              <h3>{item.title}</h3>
              {item.warning && <Badge tone="warning">需关注</Badge>}
            </div>
            <strong>{item.value}</strong>
            <p>{item.note}</p>
          </article>
        ))}
      </div>
      {dataset.warnings.length > 0 && (
        <ul className="diagnostic-list">
          {dataset.warnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      )}
    </Section>
  );
}
