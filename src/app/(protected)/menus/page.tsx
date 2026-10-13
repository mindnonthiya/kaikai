import { PageTitle } from "@/components/page-title";
import { demoMenus } from "@/lib/demo-data";
import { formatBaht } from "@/lib/money";

export default function MenusPage() {
  return <><PageTitle eyebrow="สินค้า" title="เมนูและสูตรต้นทุน" description="ราคาขาย สูตร และกำไรต่อกล่องตามต้นทุนล่าสุด" action={<button className="primary-button">+ สร้างเมนู</button>} /><div className="section-grid">{demoMenus.map((menu) => <article className="menu-card" key={menu.id}><div className="menu-icon">{menu.emoji}</div><h3>{menu.name}</h3><p>{menu.category} · พร้อมขาย</p><div className="menu-price"><div><span>ราคาขาย</span><strong>{formatBaht(menu.price)}</strong></div><div><span>ต้นทุน/กล่อง</span><strong>{formatBaht(menu.cost)}</strong></div></div><div className="menu-margin">กำไร {formatBaht(menu.price-menu.cost)} · {Math.round((menu.price-menu.cost)*100/menu.price)}%</div></article>)}</div></>;
}
