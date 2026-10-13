import Link from "next/link";
import { PageTitle } from "@/components/page-title";
import { SaleComposer, type MenuOption } from "./sale-composer";
import { fetchMenus } from "@/lib/data/queries";
import { menuEmoji } from "@/lib/menu-emoji";

export default async function NewSalePage() {
  const menus: MenuOption[] = (await fetchMenus())
    .filter((menu) => menu.isAvailable)
    .map((menu) => ({ id: menu.id, name: menu.name, category: menu.category, price: menu.price, cost: menu.cost, emoji: menuEmoji(menu.name, menu.category) }));
  return <>
    <PageTitle eyebrow="บันทึกรายการ" title="เพิ่มยอดขาย" description="เลือกเมนู กำหนดจำนวน และตรวจยอดก่อนบันทึก" action={<Link className="secondary-button" href="/sales">ประวัติการขาย</Link>} />
    <SaleComposer menus={menus} />
  </>;
}
