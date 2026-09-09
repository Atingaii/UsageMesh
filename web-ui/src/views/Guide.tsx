import { useState } from "react";
import { ArrowLeft, Copy, FileText } from "lucide-react";
import { CopyCommand } from "../components/ui";
const chapters = [
  [
    "start",
    "快速开始",
    "UsageMesh 提供云端用量面板与本地管理工作台。云端聚合各设备的加密账本，本地工作台用于查看本机记录和管理客户端配置。",
  ],
  [
    "workspace",
    "连接工作区",
    "首次使用先创建自己的 GitHub fork，并运行 usagemesh setup。已有工作区的新设备应使用 usagemesh invite 生成的加入命令。Dashboard 密码只在浏览器内解密数据。",
  ],
  [
    "usage",
    "阅读用量",
    "用量概览展示当前筛选范围。费用来自设备端价卡估算，不是供应商账单；标记 ≥ 的费用为下界。项目和会话账本保存在本机工作台中。",
  ],
  [
    "cycles",
    "官方订阅周期",
    "周期用量按官方重置窗口汇总所有已读取设备的 Codex 官方订阅记录，API 付费、中转和来源不明记录不计入。百分比取账号与额度类别的最新快照，不跨机器累加。至少一台设备升级到 v2.7.0 并同步即可提供周期；时间边界不完整的分钟记录单列待核对。每日 Tokens 独立展示，不能反推小时周期。",
  ],
  [
    "local",
    "本地管理",
    "运行 usagemesh serve 打开本地页面。额度中心通过已登录的 Codex 读取官方额度、周期历史和每日 Tokens；过期记录不代表当前余额。供应商配置需要先预览，再备份并应用。",
  ],
  [
    "privacy",
    "隐私与同步",
    "云端接收加密用量账本与脱敏额度周期，不上传原始对话和登录凭据。供应商密钥使用本机环境变量引用。配置备份可能含原有凭据，仅保存在本机。",
  ],
  [
    "help",
    "常见问题",
    "数据缺失时先检查设备同步状态。额度未知时刷新对应来源；CodexBar 连接器需要单独安装与授权。系统提醒只在本地 serve 服务运行期间生效。",
  ],
];
export function Guide({ onBack }: { onBack: () => void }) {
  const [active, setActive] = useState("start"),
    [copied, setCopied] = useState(false),
    [copyError, setCopyError] = useState(false);
  return (
    <article className="guide-page">
      <button className="text-button" onClick={onBack}>
        <ArrowLeft size={15} />
        返回概览
      </button>
      <h2>工作区使用指南</h2>
      <div className="guide-meta">
        <span>
          <FileText size={14} />
          {chapters.length} 个章节
        </span>
        <button
          className="button"
          onClick={async () => {
            setCopyError(false);
            try {
              await navigator.clipboard.writeText(
                chapters
                  .map(([, title, body]) => `## ${title}\n\n${body}`)
                  .join("\n\n"),
              );
              setCopied(true);
            } catch {
              setCopied(false);
              setCopyError(true);
            }
          }}
        >
          <Copy size={14} />
          {copied ? "已复制" : "复制 Markdown"}
        </button>
      </div>
      {copyError && <p role="status">复制失败，请选择下方正文手动复制。</p>}
      <p className="guide-intro">
        从查看用量到管理本机客户端，在这里了解工作区的主要功能与数据边界。
      </p>
      <div className="guide-layout">
        <nav aria-label="指南目录">
          <strong>目录</strong>
          {chapters.map(([id, title], i) => (
            <a
              key={id}
              className={active === id ? "active" : ""}
              href={`#guide-${id}`}
              onClick={(e) => {
                e.preventDefault();
                setActive(id);
                document
                  .getElementById(`guide-${id}`)
                  ?.scrollIntoView({ behavior: "auto", block: "start" });
              }}
            >
              {i + 1}. {title}
            </a>
          ))}
        </nav>
        <div>
          {chapters.map(([id, title, body], i) => (
            <section id={`guide-${id}`} key={id}>
              <h3>
                <span>{i + 1}</span>
                {title}
              </h3>
              <div className="guide-copy">
                <p>{body}</p>
                {id === "local" && <CopyCommand command="usagemesh serve" />}
                {id === "start" && (
                  <p className="guide-callout">
                    第一次建立工作区使用 setup；加入已有工作区使用邀请命令。
                  </p>
                )}
              </div>
            </section>
          ))}
        </div>
      </div>
    </article>
  );
}
