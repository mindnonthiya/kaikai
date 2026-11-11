import {
  BarChart3, ChefHat, CircleDollarSign, ClipboardList, Gift, LayoutDashboard,
  PackageOpen, PlusCircle, Settings, ShoppingBag, WalletCards,
} from "lucide-react";

export const navItems = [
  { href: "/dashboard", label: "ภาพรวม", icon: LayoutDashboard, inBottomBar: true },
  { href: "/sales/new", label: "เปิดบิล", icon: PlusCircle, accent: true, inBottomBar: true },
  { href: "/sales", label: "การขาย", icon: ShoppingBag, inBottomBar: true },
  { href: "/bank-check", label: "เทียบยอดธนาคาร", icon: CircleDollarSign },
  { href: "/menus", label: "เมนูและสูตร", icon: ChefHat, inBottomBar: true },
  { href: "/ingredients", label: "วัตถุดิบ", icon: PackageOpen },
  { href: "/expenses", label: "ค่าใช้จ่าย", icon: WalletCards },
  { href: "/reports", label: "รายงาน", icon: BarChart3 },
  { href: "/rewards", label: "ระบบสะสมแต้ม", icon: Gift },
  { href: "/settings", label: "ตั้งค่า", icon: Settings },
];

export { CircleDollarSign, ClipboardList, Gift };
