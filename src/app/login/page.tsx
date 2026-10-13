import { Brand } from "@/components/brand";
import { LoginForm } from "./login-form";

export default function LoginPage() {
  return <main className="login-page"><section className="login-art"><div><Brand /><h1>ทุกกล่อง<br />มีความหมาย</h1><p>เห็นยอดขาย ต้นทุน และกำไรจริงของร้านได้ในที่เดียว</p></div><div className="login-quote"><span>วันนี้</span><strong>ขายดีขึ้นอีกนิด<br />กำไรก็ชัดขึ้นอีกหน่อย</strong></div></section><section className="login-form-wrap"><LoginForm /></section></main>;
}
