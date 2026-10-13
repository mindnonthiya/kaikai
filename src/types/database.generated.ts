export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

type Row = Record<string, unknown>;
type Table = { Row: Row; Insert: Row; Update: Row; Relationships: [] };

export type Database = {
  public: {
    Tables: {
      profiles: Table; ingredients: Table; ingredient_purchases: Table; packaging_items: Table;
      menus: Table; menu_recipe_items: Table; menu_cost_snapshots: Table; sales: Table;
      sale_items: Table; payments: Table; expenses: Table; slip_uploads: Table;
      audit_logs: Table; settings: Table;
    };
    Views: Record<string, never>;
    Functions: {
      create_sale: { Args: { payload: Json }; Returns: Json };
    };
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
};
