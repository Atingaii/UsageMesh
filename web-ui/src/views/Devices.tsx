import { DataQuality } from "../components/DataQuality";
import { useState } from "react";
import {
  ArrowRight,
  CircleCheck,
  Clock3,
  Laptop,
  Monitor,
  Plus,
  Search,
  Server,
  Terminal,
} from "lucide-react";
import type { DashboardDataset } from "../lib/types";
import { compact, dateTime, money } from "../lib/analytics";
import { deviceSyncStatus } from "../lib/data";
import { Badge, CopyCommand, EmptyState, Section } from "../components/ui";

export function Devices({
  dataset,
  onConnect,
  onInspect,
}: {
  dataset: DashboardDataset;
  onConnect: () => void;
  onInspect: (device: string) => void;
}) {
  const [query, setQuery] = useState(""),
    [status, setStatus] = useState("all");
  const devices = dataset.devices.map((device) => ({
    ...device,
    status: deviceSyncStatus(device.presenceAt),
  }));
  const online = devices.filter((device) => device.status === "online").length;
  const visible = devices.filter(
    (device) =>
      (status === "all" || device.status === status) &&
      `${device.name} ${device.platform} ${device.architecture}`
        .toLowerCase()
        .includes(query.toLowerCase()),
  );
  return (
    <div className="view-stack">
      <div className="device-summary">
        <div>
          <Monitor size={20} />
          <strong>{dataset.expectedDevices}</strong>
          <span>已注册设备</span>
        </div>
        <div>
          <CircleCheck size={20} className="success-text" />
          <strong>{online}</strong>
          <span>心跳正常</span>
        </div>
        <div>
          <Clock3 size={20} className="warning-text" />
          <strong>{devices.length - online}</strong>
          <span>心跳延迟 / 离线</span>
        </div>
      </div>
      <Section
        title="已连接的设备"
        subtitle="用量显示全部历史；在线状态依据心跳时间判断"
        action={
          <button className="button primary" onClick={onConnect}>
            <Plus size={16} />
            接入新设备
          </button>
        }
      >
        <div className="device-toolbar">
          <div className="search-input">
            <Search size={16} />
            <input
              aria-label="搜索设备"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索名称、系统或架构…"
            />
          </div>
          <select
            aria-label="筛选设备状态"
            value={status}
            onChange={(event) => setStatus(event.target.value)}
          >
            <option value="all">全部状态</option>
            <option value="online">在线</option>
            <option value="syncing">心跳延迟</option>
            <option value="offline">离线</option>
          </select>
        </div>
        <div
          className="table-scroll device-table-scroll"
          tabIndex={0}
          role="region"
          aria-label="设备列表，可横向滚动"
        >
          <table className="device-table">
            <caption className="sr-only">
              已连接设备的心跳、账本和历史用量
            </caption>
            <thead>
              <tr>
                <th scope="col">设备</th>
                <th scope="col">状态</th>
                <th scope="col" className="numeric">
                  Tokens
                </th>
                <th scope="col" className="numeric">
                  估算费用
                </th>
                <th scope="col" className="numeric">
                  请求
                </th>
                <th scope="col">最近同步</th>
                <th scope="col">CLI 版本</th>
                <th scope="col">
                  <span className="sr-only">操作</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {visible.map((device) => {
                const Icon = device.platform === "Linux" ? Server : Laptop;
                const label =
                  device.status === "online"
                    ? "在线"
                    : device.status === "syncing"
                      ? "心跳延迟"
                      : "离线";
                return (
                  <tr key={device.id}>
                    <td>
                      <div className="device-identity">
                        <span className="device-platform">
                          <Icon size={18} />
                        </span>
                        <div>
                          <strong>{device.name}</strong>
                          {dataset.retainedDeviceIds?.includes(device.id) && (
                            <Badge tone="warning">上次快照</Badge>
                          )}
                          <small>
                            {device.platform} / {device.architecture}
                          </small>
                        </div>
                      </div>
                    </td>
                    <td>
                      <Badge
                        tone={
                          device.status === "online"
                            ? "success"
                            : device.status === "syncing"
                              ? "warning"
                              : ""
                        }
                      >
                        <span
                          className={`status-dot ${device.status === "online" ? "" : device.status === "syncing" ? "amber" : "gray"}`}
                        />
                        {label}
                      </Badge>
                    </td>
                    <td className="numeric">{compact(device.totalTokens)}</td>
                    <td className="numeric">
                      {device.costLowerBound ? "≥ " : ""}
                      {money(device.cost)}
                    </td>
                    <td className="numeric">{compact(device.requestsCount)}</td>
                    <td className="device-sync-cell">
                      <span>心跳 {dateTime(device.presenceAt)}</span>
                      <small>账本 {dateTime(device.lastSync)}</small>
                    </td>
                    <td className="mono">{device.appVersion}</td>
                    <td>
                      <button
                        className="text-button"
                        aria-label={`查看 ${device.name} 的设备用量`}
                        onClick={() => onInspect(device.name)}
                      >
                        查看用量
                        <ArrowRight size={14} />
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {!visible.length && (
          <EmptyState
            title="没有匹配的设备"
            description="调整筛选，或接入设备并完成第一次同步。"
          />
        )}
      </Section>
      <DataQuality dataset={dataset} />
      <Section
        title="同步诊断"
        subtitle="心跳在 3 分钟内视为在线，3–10 分钟显示延迟，超过 10 分钟显示离线"
      >
        <div className="diagnostic-grid">
          <div>
            <Terminal size={19} />
            <h3>检查设备端状态</h3>
            <p>确认工作区、采集与计划任务是否正常。</p>
            <CopyCommand command="usagemesh status" />
          </div>
          <div>
            <Clock3 size={19} />
            <h3>手动同步账本</h3>
            <p>在需要更新的设备执行，再刷新本页面。</p>
            <CopyCommand command="usagemesh sync" />
          </div>
        </div>
      </Section>
    </div>
  );
}
