import Link from "next/link";
import { PageTitle } from "@/components/page-title";
import { BatchSlipImporter } from "./batch-slip-importer";
import { fetchMenus, fetchPooledRate, fetchPricePresets, fetchSaleSettings } from "@/lib/data/queries";

export const metadata = {
  title: "นำเข้าสลิปเป็นชุด — kaikai",
};

export default async function BatchSlipImportPage() {
  const [menus, presets, settings, pooled] = await Promise.all([
    fetchMenus(),
    fetchPricePresets(),
    fetchSaleSettings(),
    fetchPooledRate(),
  ]);

  return (
    <>
      <PageTitle
        eyebrow="บันทึกรายการ"
        title="นำเข้าสลิปเป็นชุด"
        description="เลือกรูปสลิปหลายๆ รูปพร้อมกัน ระบบบีบอัดรูปจิ๋ว อ่านยอดเงิน และจับคู่สูตรเมนูให้อัตโนมัติ"
        action={
          <Link className="secondary-button" href="/sales">
            ประวัติการขาย
          </Link>
        }
      />
      <BatchSlipImporter
        menus={menus.filter((m) => m.isAvailable)}
        presets={presets}
        defaultDeliveryFee={settings.defaultDeliveryFee}
        pooledBps={pooled.bps}
      />
    </>
  );
}
