"use client";

import { CircleAlert } from "lucide-react";

export default function ProtectedError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <section className="panel error-panel" role="alert">
    <CircleAlert size={28} />
    <h1>โหลดข้อมูลไม่สำเร็จ</h1>
    <p>{error.message || "เกิดข้อผิดพลาดที่ไม่คาดคิด"}</p>
    <p className="muted-note">ถ้าเพิ่งตั้งค่าฐานข้อมูล ตรวจว่ารัน migration ครบทั้ง 2 ไฟล์ใน Supabase SQL Editor แล้ว</p>
    <button className="primary-button" onClick={reset}>ลองใหม่</button>
  </section>;
}
