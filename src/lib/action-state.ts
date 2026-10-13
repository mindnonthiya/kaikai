/** Result returned by every server action, shown by <ActionForm> / <ActionButton>. */
export type ActionState = { ok?: boolean; error?: string; message?: string };

export const DEMO_MODE_MESSAGE = "โหมดตัวอย่าง: ยังไม่ได้เชื่อม Supabase จึงยังไม่บันทึกข้อมูลจริง";
