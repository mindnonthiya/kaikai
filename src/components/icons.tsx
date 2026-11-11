import {
  BarChart3, ChefHat, CircleDollarSign, ClipboardList, Gift, LayoutDashboard,
  PackageOpen, PlusCircle, Settings, ShoppingBag, WalletCards,
} from "lucide-react";

export const navItems = [
  { href: "/dashboard", label: "ภาพรวม", icon: LayoutDashboard, inBottomBar: true, group: "หน้าร้าน" },
  { href: "/sales/new", label: "เปิดบิล", icon: PlusCircle, accent: true, inBottomBar: true, group: "หน้าร้าน" },
  { href: "/sales", label: "การขาย", icon: ShoppingBag, inBottomBar: true, group: "หน้าร้าน" },
  { href: "/rewards", label: "แต้มสะสม", icon: Gift, inBottomBar: true, group: "หน้าร้าน" },
  { href: "/menus", label: "เมนูและสูตร", icon: ChefHat, group: "ต้นทุนและบัญชี" },
  { href: "/ingredients", label: "วัตถุดิบ", icon: PackageOpen, group: "ต้นทุนและบัญชี" },
  { href: "/expenses", label: "ค่าใช้จ่าย", icon: WalletCards, group: "ต้นทุนและบัญชี" },
  { href: "/bank-check", label: "เทียบยอดธนาคาร", icon: CircleDollarSign, group: "ต้นทุนและบัญชี" },
  { href: "/reports", label: "รายงาน", icon: BarChart3, group: "สรุปและตั้งค่า" },
  { href: "/settings", label: "ตั้งค่า", icon: Settings, group: "สรุปและตั้งค่า" },
];

export { CircleDollarSign, ClipboardList, Gift };
