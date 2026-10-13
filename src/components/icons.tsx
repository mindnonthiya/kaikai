import {
  BarChart3, ChefHat, CircleDollarSign, ClipboardList, LayoutDashboard,
  PackageOpen, PlusCircle, Settings, ShoppingBag, WalletCards,
} from "lucide-react";

export const navItems = [
  { href: "/dashboard", label: "ภาพรวม", icon: LayoutDashboard },
  { href: "/sales/new", label: "เพิ่มยอดขาย", icon: PlusCircle, accent: true },
  { href: "/sales", label: "การขาย", icon: ShoppingBag },
  { href: "/menus", label: "เมนูและสูตร", icon: ChefHat },
  { href: "/ingredients", label: "วัตถุดิบ", icon: PackageOpen },
  { href: "/expenses", label: "ค่าใช้จ่าย", icon: WalletCards },
  { href: "/reports", label: "รายงาน", icon: BarChart3 },
  { href: "/settings", label: "ตั้งค่า", icon: Settings },
];

export { CircleDollarSign, ClipboardList };
