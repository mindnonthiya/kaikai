// Helpers for server actions: auth context, form parsing and Thai error messages.
import type { SupabaseClient, User } from "@supabase/supabase-js";
import { DEMO_MODE_MESSAGE, type ActionState } from "@/lib/action-state";
import { hasSupabaseEnv } from "@/lib/env";
import { bahtToSatang } from "@/lib/money";
import { createClient } from "@/lib/supabase/server";
import { bangkokDayKey, fromBangkokDateInput } from "@/lib/time";

/** Thrown for user-facing validation problems; the message is shown as-is. */
export class InputError extends Error {}

type Context = { supabase: SupabaseClient; user: User };

/**
 * Runs `fn` with a signed-in Supabase client and turns any thrown error into an ActionState,
 * so forms always get a readable message instead of a crashed page.
 */
export async function runAction(fn: (ctx: Context) => Promise<ActionState | void>): Promise<ActionState> {
  if (!hasSupabaseEnv) return { error: DEMO_MODE_MESSAGE };
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return { error: "หมดเวลาเข้าสู่ระบบ กรุณาเข้าสู่ระบบใหม่" };
    return (await fn({ supabase, user })) ?? { ok: true };
  } catch (error) {
    if (error instanceof InputError) return { error: error.message };
    console.error(error);
    return { error: "บันทึกไม่สำเร็จ กรุณาลองใหม่อีกครั้ง" };
  }
}

/** PostgREST / Postgres codes for "table or column does not exist" — the database is missing a migration. */
export const SCHEMA_OUTDATED_CODES = new Set(["PGRST204", "PGRST205", "42P01", "42703"]);
export const SCHEMA_OUTDATED_MESSAGE = "ฐานข้อมูลยังไม่ได้อัปเดต — กรุณารันไฟล์ใน supabase/migrations ที่ยังไม่ได้รัน (เช่น 202610150001_costing_v2.sql) ใน SQL Editor";

/** Converts a Postgres/PostgREST error into a Thai message. */
export function dbError(error: { code?: string; message: string }, context?: { unique?: string; foreignKey?: string }): never {
  if (error.code === "23505") throw new InputError(context?.unique ?? "มีข้อมูลนี้อยู่แล้ว");
  if (error.code === "23503") throw new InputError(context?.foreignKey ?? "ข้อมูลนี้ถูกใช้งานอยู่ จึงลบไม่ได้");
  if (error.code === "23514") throw new InputError("ข้อมูลไม่ผ่านการตรวจสอบ (เช่น ตัวเลขติดลบ)");
  if (error.code === "42501") throw new InputError("ไม่มีสิทธิ์ทำรายการนี้");
  if (error.code && SCHEMA_OUTDATED_CODES.has(error.code)) throw new InputError(SCHEMA_OUTDATED_MESSAGE);
  if (error.code === "22P02" && error.message.includes("bigint")) throw new InputError("ฐานข้อมูลยังไม่ได้อัปเดต — กรุณารัน migration 202610130002_app_data.sql และ 202610140001_packaging_delivery.sql");
  throw new Error(error.message);
}

export function text(form: FormData, name: string, label: string, options: { required?: boolean; max?: number } = {}) {
  const value = String(form.get(name) ?? "").trim();
  if (options.required !== false && !value) throw new InputError(`กรุณากรอก${label}`);
  if (value.length > (options.max ?? 200)) throw new InputError(`${label}ยาวเกินไป`);
  return value;
}

export function optionalText(form: FormData, name: string, label: string, max = 200) {
  return text(form, name, label, { required: false, max }) || null;
}

export function money(form: FormData, name: string, label: string, options: { required?: boolean; positive?: boolean } = {}) {
  const raw = String(form.get(name) ?? "").trim();
  if (!raw) {
    if (options.required) throw new InputError(`กรุณากรอก${label}`);
    return 0;
  }
  let value: number;
  try { value = bahtToSatang(raw); } catch { throw new InputError(`${label}ไม่ถูกต้อง (ใส่ตัวเลข ทศนิยมไม่เกิน 2 ตำแหน่ง)`); }
  if (options.positive && value <= 0) throw new InputError(`${label}ต้องมากกว่า 0`);
  return value;
}

export function quantity(form: FormData, name: string, label: string, options: { required?: boolean } = { required: true }) {
  const raw = String(form.get(name) ?? "").trim().replace(/,/g, "");
  if (!raw) {
    if (options.required) throw new InputError(`กรุณากรอก${label}`);
    return null;
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw new InputError(`${label}ต้องเป็นตัวเลขมากกว่า 0`);
  if (!/^\d+(\.\d{1,4})?$/.test(raw)) throw new InputError(`${label}มีทศนิยมได้ไม่เกิน 4 ตำแหน่ง`);
  return value;
}

/** Stepper / table cell amount: empty = 0, otherwise a number ≥ 0 with at most 4 decimals. */
export function amountOrZero(form: FormData, name: string, label: string) {
  const raw = String(form.get(name) ?? "").trim().replace(/,/g, "");
  if (!raw) return 0;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || !/^\d+(\.\d{1,4})?$/.test(raw)) throw new InputError(`${label}ต้องเป็นตัวเลข 0 ขึ้นไป ทศนิยมไม่เกิน 4 ตำแหน่ง`);
  return value;
}

export function oneOf<T extends string>(form: FormData, name: string, allowed: readonly T[], label: string): T {
  const value = String(form.get(name) ?? "");
  if (!allowed.includes(value as T)) throw new InputError(`กรุณาเลือก${label}`);
  return value as T;
}

export function id(form: FormData, name = "id") {
  const value = String(form.get(name) ?? "");
  if (!/^[0-9a-f-]{36}$/i.test(value)) throw new InputError("ไม่พบรายการ");
  return value;
}

/** Reads an <input type="date"> value (Bangkok calendar day); empty means today. */
export function dateField(form: FormData, name: string, label: string) {
  const value = String(form.get(name) ?? "") || bangkokDayKey(new Date());
  try { return fromBangkokDateInput(value); } catch { throw new InputError(`${label}ไม่ถูกต้อง`); }
}
