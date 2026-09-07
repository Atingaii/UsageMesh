import { CopyCommand, Modal } from "./ui";

export function ConnectDevice({ onClose }: { onClose: () => void }) {
  return (
    <Modal title="接入新设备" onClose={onClose}>
      <p className="muted">用现有设备生成邀请，在新设备加入同一工作区。</p>
      <ol className="connect-steps">
        <li>
          <span>01</span>
          <div>
            <h3>在现有设备生成邀请</h3>
            <p>运行后会得到完整的 join 命令。</p>
            <CopyCommand command="usagemesh invite" />
          </div>
        </li>
        <li>
          <span>02</span>
          <div>
            <h3>安装并加入</h3>
            <p>
              在新设备
              <a
                href="https://github.com/Atingaii/UsageMesh/blob/main/README.zh-CN.md"
                target="_blank"
                rel="noreferrer"
              >
                安装 UsageMesh
              </a>
              ，然后运行刚才生成的 join 命令。新设备需要自己的 GitHub 写入凭据。
            </p>
          </div>
        </li>
        <li>
          <span>03</span>
          <div>
            <h3>确认同步状态</h3>
            <p>首次同步后刷新 Dashboard，新设备会自动出现。</p>
            <CopyCommand command="usagemesh status" />
          </div>
        </li>
      </ol>
      <p className="notice">
        邀请命令包含工作区密钥，请仅通过可信渠道传给自己的设备。
      </p>
    </Modal>
  );
}
