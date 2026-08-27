from pathlib import Path

p = Path("rust-cli/src/collector.rs")
text = p.read_text()
text = text.replace(
    "use crate::model::{DeviceInfo, Ledger, Metrics, RequestDetail, UsageRow};",
    "use crate::model::{DeviceInfo, Ledger, Metrics, PricingInfo, RequestDetail, UsageRow};",
)
p.write_text(text)
print("v2.3.0 repair patch applied")
