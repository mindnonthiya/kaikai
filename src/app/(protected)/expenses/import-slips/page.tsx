import Link from "next/link";
import { PageTitle } from "@/components/page-title";
import { fetchPurchaseCatalog } from "@/lib/data/purchase-options";
import { fetchSaleSettings } from "@/lib/data/queries";
import { FUEL_CATEGORY } from "@/lib/data/types";
import { bangkokDayKey } from "@/lib/time";
import { BatchExpenseSlipImporter } from "./batch-expense-slip-importer";

export const metadata = {
  title: "นำเข้าสลิปค่าใช้จ่ายเป็นชุด — kaikai",
};

const CATEGORIES = [
  FUEL_CATEGORY,
  "ค่าแก๊ส",
  "ค่าไฟ",
  "ค่าน้ำ",
  "บรรจุภัณฑ์",
  "วัตถุดิบ",
  "ค่าเช่า",
  "ค่าแรง",
  "การตลาด",
  "อุปกรณ์",
  "อื่น ๆ",
];

export default async function BatchExpenseSlipImportPage() {
  const [saleSettings, catalog] = await Promise.all([
    fetchSaleSettings(),
    fetchPurchaseCatalog(),
  ]);
  const now = new Date();
  const today = bangkokDayKey(now, saleSettings.dayStartHour);
  const maxDate = bangkokDayKey(now);

  return (
    <>
      <PageTitle
        eyebrow="เงินออก"
        title="นำเข้าสลิปค่าใช้จ่ายเป็นชุด"
        description="เลือกรูปสลิปค่าใช้จ่ายหลายๆ ใบพร้อมกัน ระบบอ่านยอดเงิน วันที่ และสามารถกดแยกพริก กระเทียม ไก่ หรือบรรจุภัณฑ์ในแต่ละสลิปได้ทันที"
        action={
          <Link className="secondary-button" href="/expenses">
            ดูรายการค่าใช้จ่าย
          </Link>
        }
      />
      <BatchExpenseSlipImporter
        today={today}
        maxDate={maxDate}
        categories={CATEGORIES}
        perUnit={catalog.perUnit}
        pooled={catalog.pooled}
        restockItems={catalog.restockItems}
      />
    </>
  );
}
