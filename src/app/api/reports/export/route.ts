import { demoSales } from "@/lib/demo-data";

const escape = (value: string | number) => `"${String(value).replaceAll('"', '""')}"`;

export async function GET() {
  const headers = ["เลขที่", "เวลา", "ลูกค้า", "รายการ", "ช่องทางชำระ", "สถานะ", "ยอดรวม (สตางค์)"];
  const rows = demoSales.map((sale) => [sale.id, sale.time, sale.customer, sale.items, sale.payment, sale.status, sale.total]);
  const csv = `\uFEFF${[headers, ...rows].map((row) => row.map(escape).join(",")).join("\r\n")}`;
  return new Response(csv, { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": "attachment; filename=kaikai-sales.csv" } });
}
